"""Signing in over HTTP: an agent, a person through a kept sign-in, and a person by the device grant.

One scripted server stands as the gateway and as the issuer it trusts. What
is asked of each, in what form and how often, is what these tests hold: the
issuer's answers decide whether a renewal is tried again, and a refresh token
is spent once.
"""

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Final, final, override
from urllib.parse import parse_qs

import httpx
import pytest
from aio import Heard, hurried, pass_time, run, settle, soon
from gateway_server import NOT_FOUND, Answer, Asked, GatewayServer, Recording
from issuer import (
    ALICE,
    CONFIGURATION,
    DEVICE,
    ME,
    METADATA,
    PENDING,
    REFUSED,
    REVOKE,
    SECRET,
    TOKEN,
    account,
    agent_named,
    issuer_of,
    minted,
    says,
    trusting,
)
from kb import recorded
from pydantic import JsonValue, TypeAdapter
from shown import CARRIED, parts_of, printed
from spec import JsonObject, text
from storages import Refusing
from tokens import expired, token

from semiont.bus import reply_channels_for
from semiont.cache import Pending, Ready
from semiont.errors import SemiontError, SessionError, SignInError, TransportError
from semiont.http import AgentToken, DeviceCode, HttpTransport, ServiceToken, session_from_kept, sign_in_device, sign_out
from semiont.http.oauth import (
    IssuedTokens,
    discover_issuer,
    issuer_client,
    refresh_at_issuer,
    renew_kept,
    revoke_at_issuer,
    sign_in_with_device_grant,
)
from semiont.identifiers import ResourceId, UserId
from semiont.identity import agent_did
from semiont.operations import BROWSE_RESOURCE_REQUESTED, MARK_DELETE
from semiont.registry import kept_in
from semiont.session import HeldSignIn, MemorySignIn, SemiontSession, SessionEndReason, SignInKept
from semiont.sign_in_store import FILE_NAME, SignInStore
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import KEPT_QUERIES, cache_key, last_event_id_key, person_key
from semiont.testing import create_test_client
from semiont.timing import DEVICE_POLL_MS, DEVICE_SLOW_DOWN_MS, MIN_REFRESH_DELAY_MS
from semiont.types import HttpEndpoint, KbTarget, LocalEndpoint, UserResponse
from semiont.watched import Variable, Watched, reached

_JSON = TypeAdapter[JsonValue](JsonValue)

ALICE_KEY = person_key(text(ALICE["did"], "Alice's did"))
"""The key of the person the gateway names for every token: what a session with a storage keeps hers under."""


def form(asked: Asked) -> dict[str, str]:
    """A request's body, which is a form: each field once."""
    assert asked.headers["content-type"] == "application/x-www-form-urlencoded"
    fields = parse_qs(asked.body.decode(), keep_blank_values=True, strict_parsing=True)
    assert all(len(values) == 1 for values in fields.values())
    return {name: values[0] for name, values in fields.items()}


def access(n: int, lifetime: int = 3600) -> str:
    return token(lifetime, n, email="alice@example.org", iss="https://issuer.example.org")


def held(gateway: GatewayServer, access_token: str, refresh: str = "refresh-1") -> HeldSignIn:
    return HeldSignIn(
        access=access_token,
        refresh=refresh,
        client_id="semiont-cli",
        token_endpoint=f"{gateway.origin}{TOKEN}",
        revocation_endpoint=f"{gateway.origin}{REVOKE}",
    )


def now[T](watched: Watched[T]) -> T:
    """A watched value as it is at this moment: read afresh, whatever was read of it before."""
    return watched.value


def sent_with(gateway: GatewayServer, method: str, path: str) -> list[str | None]:
    return [asked.headers.get("authorization") for asked in gateway.of(method, path)]


# ── The issuer a knowledge base trusts ──────────────────────────────────


def test_the_knowledge_base_names_its_issuer_and_the_issuer_its_endpoints() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            found = await soon(discover_issuer(gateway.origin))
            assert found.issuer == issuer_of(gateway)
            assert (found.authorization, found.token) == (f"{issuer_of(gateway)}/auth", f"{gateway.origin}{TOKEN}")
            assert (found.device, found.revocation) == (f"{gateway.origin}{DEVICE}", f"{gateway.origin}{REVOKE}")
            # Its resource metadata is public: asked with no token, and with no stream opened for it.
            assert sent_with(gateway, "GET", METADATA) == [None]
            assert gateway.of("POST", "/bus/subscribe") == []

            trusting(gateway, device=False, revocation=False)
            bare = await soon(discover_issuer(gateway.origin))
            assert (bare.device, bare.revocation) == (None, None)

    run(scenario())


def test_a_knowledge_base_that_names_no_issuer_has_nowhere_to_sign_in() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            # One that does not serve the document at all.
            with pytest.raises(SignInError) as absent:
                await soon(discover_issuer(gateway.origin))
            assert absent.value.code == "no-issuer"
            # One that serves it and lists nobody.
            gateway.answers[METADATA] = {
                "resource": "https://kb.example.org",
                "authorization_servers": [],
                "bearer_methods_supported": ["header"],
            }
            with pytest.raises(SignInError) as empty:
                await soon(discover_issuer(gateway.origin))
            assert empty.value.code == "no-issuer"

    run(scenario())


def test_an_issuer_that_cannot_be_found_is_said_with_the_answer_there_was() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            issuer = issuer_of(gateway)

            gateway.scripted[("GET", METADATA)] = [
                Answer(status=503, body=b'{"error":"starting"}'),
                Answer(status=503, body=b'{"error":"starting"}'),
            ]
            with pytest.raises(SignInError) as away:
                await soon(discover_issuer(gateway.origin))
            assert (away.value.code, away.value.status) == ("discovery", 503)

            gateway.scripted[("GET", CONFIGURATION)] = [Answer(status=500)]
            with pytest.raises(SignInError, match="discovery answered HTTP 500") as failing:
                await soon(discover_issuer(gateway.origin))
            assert (failing.value.code, failing.value.status) == ("discovery", 500)

            # A document that describes another issuer is not this one's.
            gateway.scripted[("GET", CONFIGURATION)] = [
                says({"issuer": "https://elsewhere.example", "authorization_endpoint": "a", "token_endpoint": "t"})
            ]
            with pytest.raises(SignInError, match="not an OpenID configuration for it") as another:
                await soon(discover_issuer(gateway.origin))
            assert (another.value.code, another.value.status) == ("discovery", 200)

            gateway.scripted[("GET", CONFIGURATION)] = [says({"issuer": issuer, "authorization_endpoint": "a"})]
            with pytest.raises(SignInError, match="not an OpenID configuration for it"):
                await soon(discover_issuer(gateway.origin))

            # No answer at all carries no status: an outage is not a refusal.
            gateway.scripted[("GET", CONFIGURATION)] = [Answer(hang_up=True)]
            with pytest.raises(SignInError, match="discovery was not answered") as silent:
                await soon(discover_issuer(gateway.origin))
            assert (silent.value.code, silent.value.status) == ("discovery", None)
        # A gateway that is not there.
        with pytest.raises(SignInError) as gone:
            await soon(discover_issuer(gateway.origin))
        assert (gone.value.code, gone.value.status) == ("discovery", None)

    run(scenario())


# ── The refresh grant, and revocation ───────────────────────────────────


def test_the_refresh_grant_is_one_form_and_an_issuer_that_does_not_rotate_leaves_the_refresh_token_current() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, issuer_client() as http:
            endpoint = f"{gateway.origin}{TOKEN}"
            gateway.scripted[("POST", TOKEN)] = [
                says({"access_token": "access-2", "refresh_token": "refresh-2"}),
                says({"access_token": "access-3"}),
                says({"error": "invalid_grant", "error_description": "Token is not active"}, 400),
                says({"error": "invalid_client"}, 401),
                Answer(status=502, body=b"<html>Bad Gateway</html>"),
                # An answer that carries no access token is no grant, whatever its status.
                says({"token_type": "Bearer"}),
            ]
            assert await soon(refresh_at_issuer(http, endpoint, "semiont-cli", "refresh 1&=")) == IssuedTokens(
                access="access-2", refresh="refresh-2"
            )
            asked = gateway.of("POST", TOKEN)[0]
            assert form(asked) == {"grant_type": "refresh_token", "refresh_token": "refresh 1&=", "client_id": "semiont-cli"}
            # Written as every Semiont client writes a form: a space is `%20`.
            assert b"refresh_token=refresh%201%26%3D" in asked.body
            assert asked.headers["accept"] == "application/json"

            assert await soon(refresh_at_issuer(http, endpoint, "semiont-cli", "refresh-2")) == IssuedTokens(
                access="access-3", refresh="refresh-2"
            )

            for said, status in [
                ("invalid_grant: Token is not active", 400),
                ("invalid_client", 401),
                ("HTTP 502", 502),
                ("HTTP 200", 200),
            ]:
                with pytest.raises(SignInError) as refused:
                    await soon(refresh_at_issuer(http, endpoint, "semiont-cli", "refresh-2"))
                assert (refused.value.code, refused.value.status) == ("exchange", status)
                assert refused.value.message == f"The issuer refused the token request ({said})"

            gateway.scripted[("POST", TOKEN)] = [Answer(hang_up=True)]
            with pytest.raises(SignInError, match="The issuer did not answer") as silent:
                await soon(refresh_at_issuer(http, endpoint, "semiont-cli", "refresh-2"))
            assert (silent.value.code, silent.value.status) == ("exchange", None)

    run(scenario())


def test_a_renewal_the_issuer_did_not_refuse_is_tried_again_inside_its_budget() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            first = access(1)
            kept = MemorySignIn(held(gateway, first))
            renewed = access(2)
            # "Not now", and no answer at all: neither is the issuer's verdict.
            gateway.scripted[("POST", TOKEN)] = [Answer(status=503), Answer(hang_up=True), says({"access_token": renewed})]

            assert await hurried(renew_kept(kept, first)) == renewed
            assert len(gateway.of("POST", TOKEN)) == 3
            # The same refresh token each time: it was not spent by an attempt that got no grant.
            assert {form(asked)["refresh_token"] for asked in gateway.of("POST", TOKEN)} == {"refresh-1"}

    run(scenario())


def test_a_refused_grant_is_final_and_a_spent_budget_says_how_many_attempts_it_took() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            first = access(1)
            kept = MemorySignIn(held(gateway, first))

            gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_grant"}, 400)]
            with pytest.raises(SignInError) as refused:
                await hurried(renew_kept(kept, first))
            assert refused.value.message == "The issuer refused the token request (invalid_grant)"
            assert (refused.value.status, len(gateway.of("POST", TOKEN))) == (400, 1)

            gateway.scripted[("POST", TOKEN)] = [Answer(status=503)] * 9
            with pytest.raises(SignInError) as spent:
                await hurried(renew_kept(kept, first))
            assert (
                spent.value.message == "The session could not be renewed after 4 attempts: The issuer refused the token request (HTTP 503)"
            )
            assert (spent.value.code, spent.value.status) == ("exchange", 503)
            assert len(gateway.of("POST", TOKEN)) == 1 + 4
            # What is kept is as it was: a renewal that failed changes nothing.
            assert await kept.held() == held(gateway, first)

    run(scenario())


def test_revocation_is_one_form_and_a_refusal_is_said() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, issuer_client() as http:
            endpoint = f"{gateway.origin}{REVOKE}"
            gateway.scripted[("POST", REVOKE)] = [Answer(), Answer(status=503)]

            await soon(revoke_at_issuer(http, endpoint, "semiont-cli", "refresh-1"))
            assert form(gateway.of("POST", REVOKE)[0]) == {
                "token": "refresh-1",
                "token_type_hint": "refresh_token",
                "client_id": "semiont-cli",
            }
            with pytest.raises(SignInError, match=r"refused the revocation \(HTTP 503\)") as refused:
                await soon(revoke_at_issuer(http, endpoint, "semiont-cli", "refresh-1"))
            assert refused.value.status == 503

    run(scenario())


# ── The device grant ────────────────────────────────────────────────────


def test_the_device_grant_shows_the_code_and_asks_at_the_issuers_interval_until_the_tokens_arrive() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [
                minted(verification_uri_complete="https://issuer.example.org/device?user_code=WDJB-MJHT", expires_in=900, interval=2)
            ]
            gateway.scripted[("POST", TOKEN)] = [
                PENDING,
                says({"error": "slow_down"}, 400),
                says({"access_token": "access-1", "refresh_token": "refresh-1"}),
            ]
            shown: list[DeviceCode] = []

            def polls() -> int:
                return len(gateway.of("POST", TOKEN))

            signing = asyncio.create_task(sign_in_with_device_grant(gateway.origin, shown.append))
            await soon(gateway.arrived("POST", DEVICE))
            await settle()
            # The person is shown where to approve before the token endpoint is asked anything.
            assert shown == [
                DeviceCode(
                    user_code="WDJB-MJHT",
                    verification_uri="https://issuer.example.org/device",
                    verification_uri_complete="https://issuer.example.org/device?user_code=WDJB-MJHT",
                    expires_in=900,
                )
            ]
            assert form(gateway.of("POST", DEVICE)[0]) == {"client_id": "semiont-cli", "scope": "openid email profile offline_access"}
            assert polls() == 0

            # Not before the interval the issuer stated.
            await pass_time(1.8)
            await settle()
            assert polls() == 0
            await pass_time(0.3)
            await soon(gateway.arrived("POST", TOKEN, 1))
            await settle()
            assert form(gateway.of("POST", TOKEN)[0]) == {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": "the-device-code",
                "client_id": "semiont-cli",
            }

            await pass_time(2.1)
            await soon(gateway.arrived("POST", TOKEN, 2))
            await settle()
            # Told to slow down, it leaves `deviceSlowDownMs` more between asks.
            await pass_time(2 + DEVICE_SLOW_DOWN_MS / 1000 - 0.2)
            await settle()
            assert polls() == 2
            await pass_time(0.3)
            await soon(gateway.arrived("POST", TOKEN, 3))

            issuer, tokens = await soon(signing)
            assert issuer.token == f"{gateway.origin}{TOKEN}"
            assert tokens == IssuedTokens(access="access-1", refresh="refresh-1")

    run(scenario())


def test_an_issuer_that_states_no_interval_is_asked_every_device_poll_until_the_code_has_expired() -> None:
    poll = DEVICE_POLL_MS / 1000

    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [minted(expires_in=30)]
            gateway.scripted[("POST", TOKEN)] = [PENDING] * 20

            loop = asyncio.get_running_loop()
            began = loop.time()
            with pytest.raises(SignInError, match="expired before it was approved") as over:
                await hurried(sign_in_with_device_grant(gateway.origin, lambda _: None))
            assert (over.value.code, over.value.status) == ("expired", None)
            # One ask each `devicePollMs` of the half minute, and none once it is over.
            assert 30 / poll - 1 <= len(gateway.of("POST", TOKEN)) <= 30 / poll
            assert 30 <= loop.time() - began < 30 + poll + 1

    run(scenario())


def test_an_issuer_that_states_no_lifetime_has_answered_without_what_was_asked_for() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            # RFC 8628 §3.2 requires `expires_in`: a code whose lifetime nobody knows is shown to nobody.
            gateway.scripted[("POST", DEVICE)] = [
                says({"device_code": "the-device-code", "user_code": "WDJB-MJHT", "verification_uri": "https://issuer.example.org/device"})
            ]
            shown: list[DeviceCode] = []

            with pytest.raises(SignInError) as refused:
                await soon(sign_in_with_device_grant(gateway.origin, shown.append))
            assert (refused.value.code, refused.value.status, refused.value.message) == (
                "exchange",
                200,
                "The issuer refused the device authorization request (HTTP 200)",
            )
            assert shown == []
            assert gateway.of("POST", TOKEN) == []

    run(scenario())


def test_an_issuer_that_states_no_link_with_the_code_shows_none() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [minted()]
            gateway.scripted[("POST", TOKEN)] = [says({"error": "access_denied"}, 400)]
            shown: list[DeviceCode] = []

            with pytest.raises(SignInError):
                await hurried(sign_in_with_device_grant(gateway.origin, shown.append))
            assert (shown[0].expires_in, shown[0].verification_uri_complete) == (600, None)

    run(scenario())


@pytest.mark.parametrize(
    ("answers", "code", "status", "message"),
    [
        ([says({"error": "access_denied"}, 400)], "denied", 400, "The sign-in was denied at the issuer"),
        ([says({"error": "expired_token"}, 400)], "expired", None, "The code expired before it was approved"),
        (
            [says({"error": "invalid_client", "error_description": "no such client"}, 401)],
            "exchange",
            401,
            "The issuer refused the token request (invalid_client: no such client)",
        ),
        (
            [PENDING, says({"access_token": "access-1"})],
            "exchange",
            None,
            "The issuer returned no refresh token: the session could not outlive its first access token",
        ),
        ([Answer(status=500, body=b"oops")], "exchange", 500, "The issuer refused the token request (HTTP 500)"),
    ],
    ids=["denied", "the code expired", "refused", "no refresh token", "an answer that is no answer"],
)
def test_a_device_grant_that_does_not_sign_in_says_why(answers: Sequence[Answer], code: str, status: int | None, message: str) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = list(answers)
            with pytest.raises(SignInError) as failed:
                await hurried(sign_in_with_device_grant(gateway.origin, lambda _: None))
            assert (failed.value.code, failed.value.status, failed.value.message) == (code, status, message)
            assert len(gateway.of("POST", TOKEN)) == len(answers)

    run(scenario())


def test_a_device_grant_the_issuer_does_not_offer_or_will_not_begin_shows_nobody_a_code() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            shown: list[DeviceCode] = []
            trusting(gateway, device=False)
            with pytest.raises(SignInError, match=r"offers no device authorization endpoint.*semiont-cli") as absent:
                await soon(sign_in_with_device_grant(gateway.origin, shown.append))
            assert absent.value.code == "discovery"

            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [says({"error": "unauthorized_client"}, 400)]
            with pytest.raises(SignInError) as refused:
                await soon(sign_in_with_device_grant(gateway.origin, shown.append))
            assert refused.value.message == "The issuer refused the device authorization request (unauthorized_client)"
            assert (refused.value.code, refused.value.status) == ("exchange", 400)

            # An answer that lacks what the person is to be shown is no code.
            gateway.scripted[("POST", DEVICE)] = [says({"device_code": "the-device-code", "user_code": "WDJB-MJHT"})]
            with pytest.raises(SignInError, match=r"refused the device authorization request \(HTTP 200\)"):
                await soon(sign_in_with_device_grant(gateway.origin, shown.append))
            assert shown == []
            assert gateway.of("POST", TOKEN) == []

    run(scenario())


# ── An agent ────────────────────────────────────────────────────────────


def test_a_service_account_signs_in_once_and_its_token_is_used_until_it_is_due() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = token(300, 1), token(300, 2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": first, "expires_in": 300}), says({"access_token": second})]
            service = ServiceToken(account(gateway))

            # Asked for together, it is granted once.
            together = await soon(asyncio.gather(service.authorization(), service.authorization()))
            assert list(together) == [f"Bearer {first}", f"Bearer {first}"]
            assert await soon(service.authorization()) == f"Bearer {first}"
            assert len(gateway.of("GET", CONFIGURATION)) == 1
            assert len(gateway.of("POST", TOKEN)) == 1
            assert form(gateway.of("POST", TOKEN)[0]) == {
                "grant_type": "client_credentials",
                "client_id": "semiont-smelter",
                "client_secret": SECRET,
            }

            # Half its life before it expires it is due, and the next use fetches another; the issuer is not found again.
            await pass_time(140)
            assert await soon(service.authorization()) == f"Bearer {first}"
            await pass_time(12)
            assert await soon(service.authorization()) == f"Bearer {second}"
            assert (len(gateway.of("GET", CONFIGURATION)), len(gateway.of("POST", TOKEN))) == (1, 2)

    run(scenario())


def test_a_service_token_that_says_nothing_of_how_long_it_lives_is_not_kept() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", TOKEN)] = [
                says({"access_token": "opaque-1"}),
                # One that states only the grant's lifetime is kept for half of it.
                says({"access_token": "opaque-2", "expires_in": 60}),
                says({"access_token": "opaque-3", "expires_in": 60}),
            ]
            service = ServiceToken(account(gateway))

            assert await soon(service.authorization()) == "Bearer opaque-1"
            assert await soon(service.authorization()) == "Bearer opaque-2"
            await pass_time(29)
            assert await soon(service.authorization()) == "Bearer opaque-2"
            await pass_time(2)
            assert await soon(service.authorization()) == "Bearer opaque-3"

    run(scenario())


def test_a_service_account_that_cannot_sign_in_says_where_and_as_whom_and_never_its_secret() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            credential = account(gateway)
            assert SECRET not in repr(credential)
            service = ServiceToken(credential)
            failures: list[SignInError] = []

            async def fails(code: str, status: int | None, saying: str) -> None:
                with pytest.raises(SignInError, match=saying) as failed:
                    await soon(service.authorization())
                assert (failed.value.code, failed.value.status) == (code, status)
                failures.append(failed.value)

            await fails("discovery", 404, "OIDC discovery for .* failed: HTTP 404")
            gateway.scripted[("GET", CONFIGURATION)] = [Answer(hang_up=True)]
            await fails("discovery", None, "OIDC discovery for .* got no answer")
            gateway.scripted[("GET", CONFIGURATION)] = [says({"issuer": issuer_of(gateway)})]
            await fails("discovery", 200, "returned no `token_endpoint`")

            trusting(gateway)
            # An error body can echo the secret: the status is said, never the body.
            gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_client", "error_description": f"bad secret {SECRET}"}, 401)]
            await fails("exchange", 401, r"Client-credentials grant for semiont-smelter at .* failed \(HTTP 401\)")
            gateway.scripted[("POST", TOKEN)] = [Answer(hang_up=True)]
            await fails("exchange", None, "Client-credentials grant for semiont-smelter at .* got no answer")
            gateway.scripted[("POST", TOKEN)] = [says({"token_type": "Bearer"})]
            await fails("exchange", 200, "returned no `access_token`")

            for failure in failures:
                assert SECRET not in failure.message
                assert SECRET not in repr(failure)
                assert SECRET not in repr(failure.__cause__)

    run(scenario())


def test_an_agent_is_signed_in_as_its_account_and_feeds_a_transport() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = token(3600, 1), token(3600, 2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": first}), says({"access_token": second})]
            gateway.answers[ME] = agent_named("semiont-smelter")

            agent = AgentToken(f"{gateway.origin}/", service=ServiceToken(account(gateway)))
            assert now(agent.token) is None
            async with agent:
                assert agent.gateway == gateway.origin
                # The issuer's token is the agent's bearer, and the gateway names the agent by its account. Nothing is exchanged.
                assert agent.token.value == first
                assert agent.did == agent_did("example.org", "semiont-smelter")
                assert [(asked.method, asked.path) for asked in gateway.asked] == [("GET", CONFIGURATION), ("POST", TOKEN), ("GET", ME)]
                assert sent_with(gateway, "GET", ME) == [f"Bearer {first}"]

                # What a service holds: a transport, its agent's token source, and the channels it awaits replies on.
                channels = reply_channels_for(BROWSE_RESOURCE_REQUESTED, MARK_DELETE)
                assert channels == ("browse:resource-result", "browse:resource-failed", "mark:delete-ok", "mark:delete-failed")
                async with HttpTransport(gateway.origin, token=agent.token, refresher=agent.refresh, channels=channels) as transport:
                    await soon(reached(transport.state, lambda state: state == "open"))
                    assert sent_with(gateway, "POST", "/bus/subscribe") == [f"Bearer {first}"]
                    assert gateway.subscriptions[0]["global"] == list(channels)

                    # The gateway refuses the token: the agent asks its issuer for another, and the request is made with it.
                    gateway.answers["/api/health"] = {
                        "status": "ok",
                        "message": "serving",
                        "version": "0.0.0",
                        "timestamp": "2026-10-06T05:04:06.111Z",
                    }
                    gateway.scripted[("GET", "/api/health")] = [REFUSED]
                    await soon(transport.health_check())
                    assert agent.token.value == second
                    assert sent_with(gateway, "GET", "/api/health") == [f"Bearer {first}", f"Bearer {second}"]
                    assert len(gateway.of("POST", TOKEN)) == 2
                    # Who the agent is was said when it signed in, and is said once.
                    assert len(gateway.of("GET", ME)) == 1
            with pytest.raises(RuntimeError, match="signed in once"):
                await agent.__aenter__()

    run(scenario())


def test_an_agent_that_cannot_be_signed_in_says_so_on_the_way_in() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
            service = ServiceToken(account(gateway))

            def agent() -> AgentToken:
                return AgentToken(gateway.origin, service=service)

            gateway.scripted[("GET", ME)] = [REFUSED]
            with pytest.raises(TransportError, match=r"the gateway did not name the agent \(HTTP 401\)") as refused:
                async with agent():
                    pass
            assert (refused.value.code, refused.value.status) == ("unauthorized", 401)

            unsigned = agent()
            gateway.scripted[("GET", ME)] = [says({"did": "did:web:example.org:agents:semiont-smelter"})]
            with pytest.raises(TransportError, match="did not answer who the agent is") as malformed:
                async with unsigned:
                    pass
            assert (malformed.value.code, malformed.value.status) == ("error", 200)
            # And nobody is signed in: no token is held, and no DID is said.
            assert now(unsigned.token) is None
            with pytest.raises(RuntimeError, match="not signed in"):
                _ = unsigned.did

            gateway.scripted[("GET", ME)] = [Answer(hang_up=True)]
            with pytest.raises(TransportError, match="/api/users/me got no answer") as silent:
                async with agent():
                    pass
            assert (silent.value.code, silent.value.status) == ("unavailable", None)

            # Its account failing to sign in at its issuer is the account's failure, and the gateway is not asked.
            gateway.scripted[("POST", TOKEN)] = [Answer(status=401)]
            asked = len(gateway.of("GET", ME))
            with pytest.raises(SignInError):
                async with AgentToken(gateway.origin, service=ServiceToken(account(gateway))):
                    pass
            assert len(gateway.of("GET", ME)) == asked

    run(scenario())


@pytest.mark.parametrize(
    ("answer", "fault"),
    [
        (says({"email": CARRIED, "name": None, "image": None, "domain": "example.org"}), "it has no `did`"),
        (says({**agent_named("semiont-smelter"), "did": [CARRIED]}), "its `did` is malformed"),
        (says({**agent_named("semiont-smelter"), "name": [CARRIED]}), "its `name` is malformed"),
        (says({}), "it has no `did`"),
        # A DID of no DID's form: the table states a DID's form, so the refusal names the `did`.
        (says({**agent_named("semiont-smelter"), "did": CARRIED}), "its `did` is malformed"),
        (says([{**agent_named("semiont-smelter"), "name": CARRIED}]), "it is malformed"),
        (Answer(body=f"did={CARRIED}".encode()), "it is malformed"),
    ],
    ids=["no DID", "a DID that is no text", "a name that is none", "nothing", "a DID that is none", "not an object", "not JSON"],
)
def test_an_answer_that_does_not_say_who_the_agent_is_is_refused_for_its_first_fault_and_in_none_of_its_own_words(
    answer: Answer, fault: str
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
            gateway.scripted[("GET", ME)] = [answer]
            with pytest.raises(TransportError) as refused:
                async with AgentToken(gateway.origin, service=ServiceToken(account(gateway))):
                    pass
            # What an answer carries is its own, whatever it is: no part of it is said.
            assert parts_of(CARRIED, printed(refused.value)) == []
            assert refused.value.message == f"{gateway.origin}{ME} did not answer who the agent is: {fault}"
            assert (refused.value.code, refused.value.status) == ("error", 200)

    run(scenario())


def test_a_grant_that_fails_while_its_answer_carries_a_token_says_no_part_of_the_token() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, issuer_client() as http:
            trusting(gateway)
            endpoint = f"{gateway.origin}{TOKEN}"
            failures: list[SignInError] = []

            # A service account's grant: refused with a token in the refusal, and granted a token that is not text.
            gateway.scripted[("POST", TOKEN)] = [
                says({"access_token": CARRIED, "error": "access_denied"}, 403),
                says({"access_token": [CARRIED]}),
            ]
            for said in (r"failed \(HTTP 403\)", "returned no `access_token`"):
                with pytest.raises(SignInError, match=said) as failed:
                    await soon(ServiceToken(account(gateway)).authorization())
                failures.append(failed.value)

            # The refresh grant, answered a token under a status that is no grant.
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": CARRIED, "refresh_token": CARRIED}, 500)]
            with pytest.raises(SignInError, match=r"refused the token request \(HTTP 500\)") as failed:
                await soon(refresh_at_issuer(http, endpoint, "semiont-cli", "refresh-1"))
            failures.append(failed.value)

            # The device grant, answered an access token and no refresh token.
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": CARRIED})]
            with pytest.raises(SignInError, match="returned no refresh token") as failed:
                await hurried(sign_in_with_device_grant(gateway.origin, lambda _: None))
            failures.append(failed.value)

            assert len(failures) == 4
            for failure in failures:
                assert parts_of(CARRIED, printed(failure)) == []

    run(scenario())


def test_an_agent_says_the_did_its_gateway_names_it_by_as_it_came_once_it_is_signed_in() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": token(3600, 1)}), says({"access_token": token(3600, 2)})]
            # Named under the knowledge base's own domain: not the address dialled, and not as anything here would form one.
            named_as = "did:web:example.org:agents:indexer"
            gateway.answers[ME] = {"did": named_as, "email": None, "name": None, "image": None, "domain": "example.org"}

            agent = AgentToken(gateway.origin, service=ServiceToken(account(gateway)))
            # The gateway says who the agent is. Before it has, nobody does: asking is refused, and no DID is made up.
            with pytest.raises(RuntimeError, match="not signed in"):
                _ = agent.did
            assert gateway.of("GET", ME) == []

            async with agent:
                assert agent.did == named_as
                assert isinstance(agent.did, UserId)
                assert "example.org" not in gateway.origin, "the gateway is dialled somewhere else"

                # A renewal brings a token. Who the agent is was said when it signed in, and is said once.
                first = agent.token.value
                assert await soon(agent.refresh(agent.token.value)) not in (None, first)
                assert len(gateway.of("POST", TOKEN)) == 2
                assert len(gateway.of("GET", ME)) == 1
                assert agent.did == named_as
                # A refusal of the token it has replaced was answered by that renewal:
                # the one it holds is given, and the issuer is not asked.
                assert await soon(agent.refresh(first)) == agent.token.value
                assert len(gateway.of("POST", TOKEN)) == 2
            # Left, it is still who it was signed in as.
            assert agent.did == named_as

    run(scenario())


def test_an_agent_renews_its_token_when_it_is_due_and_keeps_the_one_it_has_when_a_renewal_fails() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[ME] = agent_named("semiont-smelter")
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": token(300, 1)}), says({"access_token": token(30, 2)})]

            async with AgentToken(gateway.origin, service=ServiceToken(account(gateway))) as agent:
                first = agent.token.value
                # Half its life: not before.
                await pass_time(140)
                await settle()
                assert len(gateway.of("POST", TOKEN)) == 1
                await pass_time(12)
                await soon(gateway.arrived("POST", TOKEN, 2))
                await settle()
                second = agent.token.value
                assert second not in (None, first)

                # A refused grant is final for this renewal: the token is left as it is, and nothing is said.
                gateway.scripted[("POST", TOKEN)] = [Answer(status=401)]
                assert await soon(agent.refresh(agent.token.value)) is None
                assert agent.token.value == second

                # An outage is tried again inside the renewal budget, and a token that still works is not given up.
                # The token it holds is due a quarter of a minute after it was issued.
                gateway.scripted[("POST", TOKEN)] = [Answer(status=503), Answer(hang_up=True), says({"access_token": token(300, 3)})]
                asked = len(gateway.of("POST", TOKEN))
                loop = asyncio.get_running_loop()
                tried: list[float] = []

                async def renewed() -> None:
                    await gateway.arrived("POST", TOKEN, asked + 1)
                    tried.append(loop.time())
                    await reached(agent.token, lambda held_token: held_token != second)

                await hurried(renewed())
                assert len(gateway.of("POST", TOKEN)) == asked + 3
                # Inside the one renewal's budget, and not a schedule's floor apart.
                assert loop.time() - tried[0] < MIN_REFRESH_DELAY_MS / 1000
                # A renewal is the issuer's alone: the gateway was asked who the agent is once.
                assert len(gateway.of("GET", ME)) == 1

    run(scenario())


def test_an_agent_the_gateway_refuses_to_name_by_its_refusal_rate_limit_is_refused_as_by_a_401() -> None:
    # A 429 says "not now" unless its code is `refusal-rate`: then the account's token was refused,
    # and the same token gets the same answer however long the sign-in waits.
    refused_by_limit = Answer(
        status=429,
        headers={"Retry-After": "1"},
        body=b'{"error":"The requests this holder has had refused have used their allowance","code":"refusal-rate"}',
    )

    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(86_400, 0)}
            gateway.scripted[("GET", ME)] = [refused_by_limit]
            agent = AgentToken(gateway.origin, service=ServiceToken(account(gateway)))
            with pytest.raises(TransportError, match=r"the gateway did not name the agent \(HTTP 429\)") as refused:
                async with agent:
                    pass
            assert (refused.value.code, refused.value.status) == ("unauthorized", 429)
            assert now(agent.token) is None

    run(scenario())


# ── A person's session over a kept sign-in ──────────────────────────────


def test_a_session_over_what_semiont_login_kept_is_ready_and_renews_through_the_store(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            store = SignInStore(tmp_path / FILE_NAME)
            kept = store.entry("local")
            first, second = access(1), access(2)
            await kept.keep(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": second, "refresh_token": "refresh-2"})]
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.target("local"), kept=kept, on_auth_failed=told.append) as session:
                # Ready inside: the gateway has said who the kept token is, and the stream is opening with it.
                assert session.token.value == first
                signed_in = session.user.value
                assert signed_in is not None
                assert signed_in.email == "alice@example.org"
                assert sent_with(gateway, "GET", ME) == [f"Bearer {first}"]
                await soon(reached(session.client.transport.state, lambda state: state == "open"))
                assert sent_with(gateway, "POST", "/bus/subscribe") == [f"Bearer {first}"]

                # The gateway refuses the token: it is renewed at the issuer the sign-in names, and asked about.
                assert await soon(session.refresh(session.token.value)) == second
                assert form(gateway.of("POST", TOKEN)[0]) == {
                    "grant_type": "refresh_token",
                    "refresh_token": "refresh-1",
                    "client_id": "semiont-cli",
                }
                assert sent_with(gateway, "GET", ME) == [f"Bearer {first}", f"Bearer {second}"]
                # What the issuer rotated is in the store, for the launcher's next verb and this session's next renewal.
                assert await kept.held() == held(gateway, second, "refresh-2")
                written = store.read()["local"]
                assert isinstance(written, dict)
                assert written["email"] == "alice@example.org"
                # Its client asks through the same transport, with the same token.
                gateway.answers["/api/status"] = {
                    "status": "ok",
                    "version": "0.0.0",
                    "features": {"semanticContent": "on", "collaboration": "on"},
                    "message": "serving",
                }
                assert (await soon(session.client.system.status())).version == "0.0.0"
                assert sent_with(gateway, "GET", "/api/status") == [f"Bearer {second}"]
            # On the way out its client ended with it.
            assert session.client.bus.destroyed
            assert told == []

    run(scenario())


def test_a_request_the_gateway_refuses_is_made_again_with_the_sessions_renewed_token() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = access(1), access(2)
            kept = MemorySignIn(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": second})]
            gateway.answers["/api/health"] = {
                "status": "ok",
                "message": "serving",
                "version": "0.0.0",
                "timestamp": "2026-10-06T05:04:06.111Z",
            }
            gateway.scripted[("GET", "/api/health")] = [REFUSED]

            async with session_from_kept(gateway.target("kb"), kept=kept, channels=()) as session:
                transport = session.client.transport
                await soon(transport.health_check())
                assert sent_with(gateway, "GET", "/api/health") == [f"Bearer {first}", f"Bearer {second}"]
                assert session.token.value == second
                assert len(gateway.of("POST", TOKEN)) == 1

    run(scenario())


HERE: Final = KbTarget(id="here", label="Here", endpoint=LocalEndpoint(kind="local", kb_id="in-process"))
"""A knowledge base the host process has loaded: reached through no gateway."""


def test_a_session_is_with_the_knowledge_base_it_was_given() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            target = gateway.target("kb")
            async with session_from_kept(target, kept=MemorySignIn(), channels=()) as session:
                assert session.kb == target

    run(scenario())


def test_a_knowledge_base_reached_through_no_gateway_has_no_session_over_http() -> None:
    async def scenario() -> None:
        with pytest.raises(SessionError) as refused:
            async with session_from_kept(HERE, kept=MemorySignIn()):
                pass
        assert (refused.value.code, refused.value.message, refused.value.kb_id) == (
            "session.construct-failed",
            'A session over HTTP cannot be built for endpoint kind "local"',
            "here",
        )

    run(scenario())


def test_a_host_that_is_no_hosts_name_is_never_put_into_a_url() -> None:
    async def scenario() -> None:
        nowhere = KbTarget(id="kb", label="KB", endpoint=HttpEndpoint(kind="http", host="evil.example/x", port=4000, protocol="https"))
        with pytest.raises(SessionError) as refused:
            async with session_from_kept(nowhere, kept=MemorySignIn()):
                pass
        assert (refused.value.code, refused.value.message) == ("session.construct-failed", 'Invalid KB hostname: "evil.example/x"')
        with pytest.raises(SignInError) as not_signed_in:
            await sign_in_device(nowhere, MemorySignIn(), lambda _: None)
        assert (not_signed_in.value.code, not_signed_in.value.message) == ("discovery", 'Invalid KB hostname: "evil.example/x"')

    run(scenario())


def test_the_device_grant_needs_a_gateway() -> None:
    async def scenario() -> None:
        kept = MemorySignIn()
        with pytest.raises(SignInError) as refused:
            await sign_in_device(HERE, kept, lambda _: None)
        assert (refused.value.code, refused.value.message) == (
            "discovery",
            'The device grant needs an HTTP endpoint; this knowledge base\'s is "local"',
        )
        assert await kept.held() is None

    run(scenario())


def test_with_nothing_kept_a_session_is_signed_out_and_its_requests_are_refused() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.scripted[("GET", "/api/health")] = [REFUSED]
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.target("kb"), kept=MemorySignIn(), on_auth_failed=told.append) as session:
                assert (session.token.value, session.user.value) == (None, None)
                transport = session.client.transport
                with pytest.raises(TransportError) as refused:
                    await soon(transport.health_check())
                assert refused.value.code == "unauthorized"
            # Nobody was asked who nobody is, no stream was opened, and there was no session to end.
            assert (gateway.of("GET", ME), gateway.of("POST", "/bus/subscribe"), gateway.of("POST", TOKEN), told) == ([], [], [], [])

    run(scenario())


def test_a_session_whose_issuer_will_not_renew_it_is_over_and_its_sign_in_is_forgotten(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            store = SignInStore(tmp_path / FILE_NAME)
            kept = store.entry("local")
            await kept.keep(held(gateway, expired(email="alice@example.org", iss="https://issuer.example.org")))
            renewed = access(2)
            gateway.scripted[("POST", TOKEN)] = [
                says({"access_token": renewed}),
                says({"error": "invalid_grant", "error_description": "Session not active"}, 400),
            ]
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.target("local"), kept=kept, on_auth_failed=told.append) as session:
                heard = Heard(session.errors())
                # The kept token had expired: it was renewed before anyone was asked.
                assert session.token.value == renewed
                assert sent_with(gateway, "GET", ME) == [f"Bearer {renewed}"]
                assert await soon(session.refresh(session.token.value)) is None
                assert now(session.token) is None
            assert told == ["expired"]
            said = await heard.ended()
            assert [error.message for error in said if isinstance(error, SessionError)] == [
                "Token refresh failed: The issuer refused the token request (invalid_grant: Session not active)"
            ]
            assert store.read() == {}

    run(scenario())


class InMemory(SignInKept):
    """A sign-in kept as `MemorySignIn` keeps one, for a test's own kind to read as it reads it."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        self._kept: Final = MemorySignIn(sign_in)

    @override
    async def held(self) -> HeldSignIn | None:
        return await self._kept.held()

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await self._kept.keep(sign_in)

    @override
    async def renewed(self, read: HeldSignIn, access: str, refresh: str) -> str | None:
        return await self._kept.renewed(read, access, refresh)

    @override
    async def record_person_key(self, access: str, person_key: str) -> bool:
        return await self._kept.record_person_key(access, person_key)

    @override
    async def forget(self) -> None:
        await self._kept.forget()


@final
class Slowly(InMemory):
    """A kept sign-in that is read at once the first time, and after that only once it is released."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        super().__init__(sign_in)
        self.release = asyncio.Event()
        self.reads = 0

    @override
    async def held(self) -> HeldSignIn | None:
        self.reads += 1
        if self.reads > 1:
            await self.release.wait()
        return await super().held()


def test_renewals_asked_for_together_spend_one_refresh_token() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = access(1), access(2)
            kept = Slowly(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [
                says({"access_token": second, "refresh_token": "refresh-2"}),
                says({"error": "invalid_grant"}, 400),
            ]
            # The gateway refuses the kept token everywhere at once: to the session asking who it is, and to the stream.
            gateway.scripted[("GET", ME)] = [REFUSED]
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
            told: list[SessionEndReason] = []

            async def held_open() -> str | None:
                async with session_from_kept(gateway.target("kb"), kept=kept, on_auth_failed=told.append) as session:
                    await soon(reached(session.client.transport.state, lambda state: state == "open"))
                    return session.token.value

            holding = asyncio.create_task(held_open())
            await soon(gateway.arrived("GET", ME))
            await soon(gateway.arrived("POST", "/bus/subscribe"))
            await settle()
            # Both are waiting on a renewal, and the issuer has been asked for none yet.
            assert gateway.of("POST", TOKEN) == []
            kept.release.set()

            assert await soon(holding) == second
            assert len(gateway.of("POST", TOKEN)) == 1, "an issuer that rotates refresh tokens would have refused the second"
            assert sent_with(gateway, "GET", ME) == [f"Bearer {first}", f"Bearer {second}"]
            assert sent_with(gateway, "POST", "/bus/subscribe") == [f"Bearer {first}", f"Bearer {second}"]
            assert told == []

    run(scenario())


def test_a_renewal_runs_to_its_end_when_the_request_that_asked_for_it_stops_waiting() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, second = access(1), access(2)
            kept = Slowly(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": second, "refresh_token": "refresh-2"})]
            gateway.scripted[("GET", "/api/health")] = [REFUSED]

            async with session_from_kept(gateway.target("kb"), kept=kept, channels=()) as session:
                transport = session.client.transport
                # A caller that gives its request a moment, and no more.
                with pytest.raises(TimeoutError):
                    async with asyncio.timeout(0.1):
                        await transport.health_check()
                assert gateway.of("POST", TOKEN) == []

                kept.release.set()
                await soon(gateway.arrived("POST", TOKEN))
                await settle()
                # The refresh token that was spent bought a sign-in that is kept.
                assert await kept.held() == held(gateway, second, "refresh-2")

    run(scenario())


def test_leaving_a_session_ends_a_renewal_nobody_is_left_to_hear_of() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            kept = Slowly(held(gateway, access(1)))
            gateway.scripted[("GET", "/api/health")] = [REFUSED]

            async with session_from_kept(gateway.target("kb"), kept=kept, channels=()) as session:
                transport = session.client.transport
                with pytest.raises(TimeoutError):
                    async with asyncio.timeout(0.1):
                        await transport.health_check()
            # `run` fails a scenario that leaves a task behind: the renewal, still waiting to read what is kept, was ended.
            assert gateway.of("POST", TOKEN) == []

    run(scenario())


# ── Signing in by the device grant, and signing out ─────────────────────


def test_a_person_signs_in_by_the_device_grant_and_the_sign_in_is_kept_as_semiont_login_keeps_one(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            store = SignInStore(tmp_path / FILE_NAME)
            kept = store.entry("local")
            issued = token(3600, 1, email="alice@example.org", iss=issuer_of(gateway))
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [PENDING, says({"access_token": issued, "refresh_token": "refresh-1"})]
            shown: list[DeviceCode] = []

            await hurried(sign_in_device(gateway.target("local"), kept, shown.append))

            assert [code.user_code for code in shown] == ["WDJB-MJHT"]
            assert await kept.held() == held(gateway, issued)
            written = store.read()["local"]
            assert isinstance(written, dict)
            assert (written["email"], written["issuer"]) == ("alice@example.org", issuer_of(gateway))

            # And a session over it is that person's.
            async with session_from_kept(gateway.target("local"), kept=kept, channels=()) as session:
                assert session.token.value == issued
                assert sent_with(gateway, "GET", ME) == [f"Bearer {issued}"]

    run(scenario())


def test_a_device_grant_that_does_not_sign_in_keeps_nothing() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            kept = MemorySignIn()
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [says({"error": "access_denied"}, 400)]

            with pytest.raises(SignInError) as denied:
                await hurried(sign_in_device(gateway.target("local"), kept, lambda _: None))
            assert denied.value.code == "denied"
            assert await kept.held() is None

    run(scenario())


def test_signing_out_revokes_the_refresh_token_and_forgets_the_sign_in_whatever_the_issuer_answers() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            kept = MemorySignIn(held(gateway, access(1)))
            gateway.scripted[("POST", REVOKE)] = [Answer()]
            await soon(sign_out(kept))
            assert form(gateway.of("POST", REVOKE)[0]) == {
                "token": "refresh-1",
                "token_type_hint": "refresh_token",
                "client_id": "semiont-cli",
            }
            assert await kept.held() is None

            # With nothing kept nobody is told anything.
            await soon(sign_out(kept))
            assert len(gateway.of("POST", REVOKE)) == 1

            for answer in (Answer(status=503), Answer(hang_up=True), NOT_FOUND):
                await kept.keep(held(gateway, access(2)))
                gateway.scripted[("POST", REVOKE)] = [answer]
                await soon(sign_out(kept))
                assert await kept.held() is None

            # An issuer that named no revocation endpoint is told nothing, and the sign-in is forgotten all the same.
            asked = len(gateway.of("POST", REVOKE))
            await kept.keep(HeldSignIn(access=access(3), refresh="r", client_id="semiont-cli", token_endpoint=f"{gateway.origin}{TOKEN}"))
            await soon(sign_out(kept))
            assert await kept.held() is None
            assert len(gateway.of("POST", REVOKE)) == asked

    run(scenario())


# ── A client the application builds ────────────────────────────────────


HEALTH: Final[JsonObject] = {"status": "ok", "message": "serving", "version": "0.0.0", "timestamp": "2026-10-06T05:04:06.111Z"}


def test_an_issuer_and_an_agent_given_a_client_are_asked_through_it_and_it_is_left_open() -> None:
    async def scenario() -> tuple[list[tuple[str, str]], bool, bool]:
        recording = Recording()
        async with GatewayServer() as gateway, httpx.AsyncClient(transport=recording) as http:
            trusting(gateway)
            first = access(1)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": access(2)}), says({"access_token": token(3600, 3)})]
            await soon(discover_issuer(gateway.origin, http=http))
            await soon(renew_kept(MemorySignIn(held(gateway, first)), first, http=http))
            gateway.answers[ME] = agent_named("semiont-smelter")
            async with AgentToken(gateway.origin, service=ServiceToken(account(gateway), http=http), http=http):
                pass
            return recording.seen, gateway.came_through(recording), http.is_closed

    seen, came_through, closed = run(scenario())
    assert seen == [("GET", METADATA), ("GET", CONFIGURATION), ("POST", TOKEN), ("GET", CONFIGURATION), ("POST", TOKEN), ("GET", ME)]
    assert came_through
    # The client is its caller's: nothing here closes it.
    assert not closed


def test_a_person_s_sign_in_session_and_sign_out_given_a_client_are_made_through_it_and_it_is_left_open() -> None:
    async def scenario() -> tuple[list[tuple[str, str]], bool, bool]:
        recording = Recording()
        async with GatewayServer() as gateway, httpx.AsyncClient(transport=recording) as http:
            trusting(gateway)
            kept = MemorySignIn()
            first, second = access(1), access(2)
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [
                PENDING,
                says({"access_token": first, "refresh_token": "refresh-1"}),
                says({"access_token": second}),
            ]
            gateway.answers["/api/health"] = HEALTH
            gateway.scripted[("GET", "/api/health")] = [REFUSED]
            gateway.scripted[("POST", REVOKE)] = [Answer()]

            await hurried(sign_in_device(gateway.target("kb"), kept, lambda _: None, http=http))
            async with session_from_kept(gateway.target("kb"), kept=kept, channels=(), http=http) as session:
                # Refused, its token is renewed at the issuer, and the request made again with the new one.
                await soon(session.client.transport.health_check())
            await soon(sign_out(kept, http=http))
            return recording.seen, gateway.came_through(recording), http.is_closed

    seen, came_through, closed = run(scenario())
    assert [asked for asked in seen if asked != ("POST", "/bus/subscribe")] == [
        ("GET", METADATA),
        ("GET", CONFIGURATION),
        ("POST", DEVICE),
        ("POST", TOKEN),
        ("POST", TOKEN),
        ("GET", ME),
        ("GET", "/api/health"),
        ("POST", TOKEN),
        # The session asks the gateway who the renewed token is before the request is made again with it.
        ("GET", ME),
        ("GET", "/api/health"),
        ("POST", REVOKE),
    ]
    assert came_through
    assert not closed


# ── A session whose client keeps what it holds ──────────────────────────


def test_a_session_with_a_storage_keeps_what_its_queries_hold_and_the_streams_place_with_it_never_ahead() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        resource = ResourceId("res-1")
        described: JsonObject = {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []}
        unanswered: list[JsonObject] = []

        def kept_under(key: str) -> JsonValue:
            stored = storage.get(key)
            return None if stored is None else _JSON.validate_json(stored)

        async with GatewayServer() as gateway:
            trusting(gateway)

            def answering(emit: JsonObject) -> None:
                # The service that answers for a resource does, on the stream; the one that answers for the entity types is slow.
                if emit["channel"] == "browse:resource-requested":
                    answer: JsonObject = {"response": {"resource": described, "lastSequence": 1}}
                    gateway.send(None, {"channel": "browse:resource-result", "payload": answer, "correlationId": emit["correlationId"]})
                else:
                    unanswered.append(emit)

            gateway.on_emit = answering
            kept = MemorySignIn(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                client = session.client
                await soon(reached(client.transport.state, lambda state: state == "open"))
                async with client.browse.resource(resource) as live, client.browse.entity_types():
                    while not isinstance(await soon(anext(live)), Ready):
                        pass
                    await soon(gateway.arrived("POST", "/bus/emit", 2))
                    # The stream reaches a place in the resource's scope.
                    heard = client.transport.frames("mark:added")
                    gateway.send("p-res-1-7", {"channel": "mark:added", "payload": recorded("mark:added", "res-1"), "scope": "res-1"})
                    await soon(anext(heard))

                    # The resource is kept once it has stopped changing. The place is not: a cache is still fetching,
                    # and may not have taken in what the place names.
                    await pass_time(0.2, step=0.01)
                    assert kept_under(cache_key("kb", ALICE_KEY, "resource")) is not None
                    assert kept_under(last_event_id_key("kb", ALICE_KEY)) is None
                    assert not client.persistence_settled

                    # The slow answer comes, and its cache keeps it: every kept cache is at rest, and the place rides that write.
                    (asked,) = unanswered
                    answer: JsonObject = {"response": {"entityTypes": ["Person"]}}
                    gateway.send(
                        None, {"channel": "browse:entity-types-result", "payload": answer, "correlationId": asked["correlationId"]}
                    )
                    await settle()
                    await pass_time(0.2, step=0.01)
                    assert kept_under(cache_key("kb", ALICE_KEY, "entityTypes")) is not None
                    assert kept_under(last_event_id_key("kb", ALICE_KEY)) == {"res-1": "p-res-1-7"}

            # The sign-in it was given names nobody: once the gateway named the person, the sign-in records her, and what
            # the session keeps is kept for her.
            recorded_on = await kept.held()
            assert recorded_on is not None
            assert recorded_on.person_key == ALICE_KEY

            # The next session of the same knowledge base, over the same storage: what was kept is shown at once,
            # and the resource's scope resumes from the place that was kept.
            subscriptions = len(gateway.subscriptions)
            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                await soon(reached(session.client.transport.state, lambda state: state == "open"))
                async with session.client.browse.resource(resource) as live:
                    shown = await soon(anext(live))
                    assert isinstance(shown, Ready)
                    assert shown.value.name == "A resource"

                    async def resumed() -> JsonValue:
                        while True:
                            for subscription in gateway.subscriptions[subscriptions:]:
                                scoped = subscription.get("scoped")
                                if isinstance(scoped, list) and scoped:
                                    return scoped
                            await asyncio.sleep(0.005)

                    scoped = await soon(resumed())
                    assert isinstance(scoped, list)
                    (entry,) = scoped
                    assert isinstance(entry, dict)
                    assert (entry["scope"], entry["lastEventId"]) == ("res-1", "p-res-1-7")

            # A session of another knowledge base, over the same storage, begins with neither.
            async with session_from_kept(gateway.target("another"), kept=kept, storage=storage) as session:
                await soon(reached(session.client.transport.state, lambda state: state == "open"))
                async with session.client.browse.resource(resource) as live:
                    assert await soon(anext(live)) == Pending()

    run(scenario())


def test_a_session_that_never_asks_who_its_token_is_over_a_sign_in_naming_nobody_keeps_for_nobody() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        resource = ResourceId("res-1")
        described: JsonObject = {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []}

        async with GatewayServer() as gateway:
            trusting(gateway)

            def answering(emit: JsonObject) -> None:
                if emit["channel"] == "browse:resource-requested":
                    answer: JsonObject = {"response": {"resource": described, "lastSequence": 1}}
                    gateway.send(None, {"channel": "browse:resource-result", "payload": answer, "correlationId": emit["correlationId"]})

            gateway.on_emit = answering
            kept = MemorySignIn(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, validate=False, storage=storage) as session:
                client = session.client
                await soon(reached(client.transport.state, lambda state: state == "open"))
                assert (await soon(client.browse.resource(resource).fresh())).name == "A resource"
                await pass_time(0.2, step=0.01)
                assert client.persistence_settled

            assert gateway.of("GET", ME) == []
            unnamed = await kept.held()
            assert unnamed is not None
            assert unnamed.person_key is None
            for key in (last_event_id_key("kb", ALICE_KEY), *(cache_key("kb", ALICE_KEY, query) for query in KEPT_QUERIES)):
                assert storage.get(key) is None, key

    run(scenario())


def test_a_session_over_a_registrys_kept_sign_in_puts_back_nothing_that_forgetting_it_deleted() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        kept_resources = cache_key("kb", ALICE_KEY, "resource")

        async with GatewayServer() as gateway:
            trusting(gateway)

            def answering(emit: JsonObject) -> None:
                payload = emit.get("payload")
                if emit["channel"] == "browse:resource-requested" and isinstance(payload, dict):
                    described: JsonObject = {
                        "@context": "https://schema.org",
                        "@id": payload["resourceId"],
                        "name": "A resource",
                        "representations": [],
                    }
                    answer: JsonObject = {"response": {"resource": described, "lastSequence": 1}}
                    gateway.send(None, {"channel": "browse:resource-result", "payload": answer, "correlationId": emit["correlationId"]})

            gateway.on_emit = answering
            # The sign-in a registry keeps, in its storage: a script's session over the same storage is a registry's.
            kept = kept_in(storage, "kb")
            await kept.keep(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                client = session.client
                await soon(reached(client.transport.state, lambda state: state == "open"))
                await soon(client.browse.resource(ResourceId("res-1")).fresh())
                await pass_time(0.2, step=0.01)
                assert storage.get(kept_resources) is not None
                await soon(client.browse.resource(ResourceId("res-2")).fresh())
                # Held, and not yet written.
                assert not client.persistence_settled

                # As a session whose sign-in expired or was refused forgets it.
                await kept.forget()
                assert storage.get(kept_resources) is None

            # Its client closed owing a write, and wrote nothing.
            for key in (last_event_id_key("kb", ALICE_KEY), *(cache_key("kb", ALICE_KEY, query) for query in KEPT_QUERIES)):
                assert storage.get(key) is None, key

    run(scenario())


def test_a_write_a_sessions_storage_refuses_is_still_owed_and_its_close_makes_it() -> None:
    async def scenario() -> None:
        kept_types = cache_key("kb", ALICE_KEY, "entityTypes")
        storage = Refusing(kept_types, times=1)

        async with GatewayServer() as gateway:
            trusting(gateway)

            def answering(emit: JsonObject) -> None:
                if emit["channel"] == "browse:entity-types-requested":
                    answer: JsonObject = {"response": {"entityTypes": ["Person", "Place"]}}
                    gateway.send(None, {"channel": "browse:entity-types-result", "payload": answer, "correlationId": emit["correlationId"]})

            gateway.on_emit = answering
            kept = MemorySignIn(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                heard = Heard(session.errors())
                client = session.client
                await soon(reached(client.transport.state, lambda state: state == "open"))
                # Ready once the gateway has named the person: what the client holds is kept for her from then on.
                await soon(session.ready())
                assert await soon(client.browse.entity_types().fresh()) == ["Person", "Place"]

                # The entity types stop changing, and the session writes what their cache saves: the storage refuses it.
                await pass_time(0.2, step=0.01)
                assert storage.refusals == 1
                assert storage.get(kept_types) is None
                # Nothing of it was kept, so the client still owes it, and is not at rest.
                assert not client.persistence_settled
                # The refusal is said once, as it happened, in the storage's words.
                said = await heard.so_far()
                assert [error.code for error in said] == ["session.save-refused"]
                assert refusals_said(said) == 1

            # The close's flush makes the write the storage refused, and the storage takes it: the close raised
            # nothing, and the session said nothing more.
            said = await heard.ended()
            assert [error.code for error in said] == ["session.save-refused"]
            stored = storage.get(kept_types)
            assert stored is not None
            document = _JSON.validate_json(stored)
            assert isinstance(document, dict)
            entries = document["entries"]
            assert isinstance(entries, list)
            assert [entry[:2] for entry in entries if isinstance(entry, list)] == [["_", ["Person", "Place"]]]

    run(scenario())


@final
class Unreadable(InMemory):
    """A kept sign-in that is read as any is until `failing` is set, and after that cannot be read."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        super().__init__(sign_in)
        self.failing = False

    @override
    async def held(self) -> HeldSignIn | None:
        if self.failing:
            raise OSError("the sign-in could not be read")
        return await super().held()


@final
class ReadOnce(InMemory):
    """A kept sign-in that is read as any is the first time, and after that cannot be read until `readable` is set."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        super().__init__(sign_in)
        self.reads = 0
        self.readable = False

    @override
    async def held(self) -> HeldSignIn | None:
        self.reads += 1
        if self.reads > 1 and not self.readable:
            raise OSError("the sign-in could not be read")
        return await super().held()


KEPT_KEYS: Final = (last_event_id_key("kb", ALICE_KEY), *(cache_key("kb", ALICE_KEY, query) for query in KEPT_QUERIES))
"""Every key a session of knowledge base `kb` keeps Alice's things under."""


def assert_nothing_kept(storage: SessionStorage) -> None:
    for key in KEPT_KEYS:
        assert storage.get(key) is None, key


def describing(gateway: GatewayServer) -> Callable[[JsonObject], None]:
    """What the gateway does with an emit it accepted: a resource asked for is described."""

    def answering(emit: JsonObject) -> None:
        payload = emit.get("payload")
        if emit["channel"] == "browse:resource-requested" and isinstance(payload, dict):
            described: JsonObject = {
                "@context": "https://schema.org",
                "@id": payload["resourceId"],
                "name": "A resource",
                "representations": [],
            }
            answer: JsonObject = {"response": {"resource": described, "lastSequence": 1}}
            gateway.send(None, {"channel": "browse:resource-result", "payload": answer, "correlationId": emit["correlationId"]})

    return answering


def said_by_the_session(said: Sequence[SemiontError]) -> list[tuple[str, str]]:
    """What a session said of itself on its errors stream: each of its own failures' code and knowledge base, in order."""
    return [(error.code, error.kb_id) for error in said if isinstance(error, SessionError)]


async def closed_before_it_ended(session: SemiontSession[HttpTransport]) -> bool:
    """Whether a session's client had closed by the time the session ended, when its token stopped changing."""
    async for _ in session.token:
        pass
    return session.client.bus.destroyed


def refusals_said(said: Sequence[SemiontError]) -> int:
    """How many writes a session of `kb` said its storage refused: each in what the storage said, and with it as the cause."""
    refused = [error for error in said if isinstance(error, SessionError) and error.code == "session.save-refused"]
    for error in refused:
        assert error.kb_id == "kb"
        assert error.message.endswith("the storage is full"), error.message
        assert isinstance(error.__cause__, OSError)
    return len(refused)


def test_a_sign_in_that_cannot_be_read_as_its_session_starts_is_raised_to_whoever_asked_for_the_session() -> None:
    async def scenario(storage: SessionStorage | None) -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            kept = Unreadable(held(gateway, access(1)))
            kept.failing = True
            with pytest.raises(OSError, match="the sign-in could not be read"):
                async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage):
                    pytest.fail("a session was handed over whose sign-in could not be read")
            assert gateway.of("GET", ME) == []

    run(scenario(None))
    run(scenario(MemoryStorage()))


def test_a_renewal_at_the_start_that_cannot_read_the_sign_in_got_no_answer_says_so_and_is_tried_again_on_the_backoff() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            renewed = access(2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": renewed, "refresh_token": "refresh-2"})]
            kept = ReadOnce(held(gateway, expired(email="alice@example.org", iss="https://issuer.example.org")))
            told: list[SessionEndReason] = []

            async def who(_token: str) -> UserResponse:
                return UserResponse.model_validate(ALICE)

            session = SemiontSession(
                kb=gateway.target("kb"),
                client=create_test_client().client,
                token=Variable[str | None](None),
                kept=kept,
                refresh=lambda holding: renew_kept(kept, holding),
                validate=who,
                on_auth_failed=told.append,
            )
            # Heard from before it starts, so what its start says is heard too.
            heard = Heard(session.errors())
            async with session:
                await soon(session.ready())
                # The start's renewal could not read the sign-in: it got no answer, and the sign-in is kept.
                assert (session.token.value, session.user.value, told) == (None, None, [])
                assert said_by_the_session(await heard.so_far()) == [("session.auth-failed", "kb")]
                assert gateway.of("POST", TOKEN) == []

                # The sign-in can be read again: the reconnect backoff renews it, and asks who the token is.
                kept.readable = True
                assert await soon(hurried(reached(session.token, lambda held_token: held_token == renewed))) == renewed
                assert len(gateway.of("POST", TOKEN)) == 1
                assert await kept.held() == held(gateway, renewed, "refresh-2")
            assert told == []
            assert said_by_the_session(await heard.ended()) == [("session.auth-failed", "kb")]

    run(scenario())


def test_a_renewal_that_cannot_read_the_sign_in_got_no_answer_says_so_and_is_tried_again_on_the_backoff() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, renewed = access(1), access(2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": renewed, "refresh_token": "refresh-2"})]
            kept = Unreadable(held(gateway, first))
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.target("kb"), kept=kept, on_auth_failed=told.append) as session:
                heard = Heard(session.errors())
                assert session.token.value == first
                kept.failing = True
                # The gateway refused the token, and its renewal could not read the sign-in: it got no answer.
                assert await soon(session.refresh(session.token.value)) is None
                assert (now(session.token), told) == (None, [])
                assert said_by_the_session(await heard.so_far()) == [("session.refresh-exhausted", "kb")]
                assert gateway.of("POST", TOKEN) == []

                # The sign-in is kept, and can be read again: the reconnect backoff renews the token the gateway
                # refused, so the issuer is asked, and the refused token is not handed back.
                kept.failing = False
                assert await kept.held() == held(gateway, first)
                assert await soon(hurried(reached(session.token, lambda held_token: held_token == renewed))) == renewed
                assert [form(asked)["refresh_token"] for asked in gateway.of("POST", TOKEN)] == ["refresh-1"]
            assert told == []
            assert said_by_the_session(await heard.ended()) == [("session.refresh-exhausted", "kb")]

    run(scenario())


def test_a_renewal_on_the_backoff_is_handed_the_token_the_gateway_refused_and_asks_the_issuer_for_a_new_one() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            first, renewed = access(1), access(2)
            # The issuer does not answer the renewal of the refused token, however often it is tried; then it does.
            gateway.scripted[("POST", TOKEN)] = [*[Answer(hang_up=True)] * 4, says({"access_token": renewed, "refresh_token": "refresh-2"})]
            kept = MemorySignIn(held(gateway, first))
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.target("kb"), kept=kept, on_auth_failed=told.append) as session:
                heard = Heard(session.errors())
                assert session.token.value == first
                # The gateway refused the token, which has not expired, and its renewal got no answer.
                assert await hurried(session.refresh(first)) is None
                assert (now(session.token), told) == (None, [])
                assert said_by_the_session(await heard.so_far()) == [("session.refresh-exhausted", "kb")]
                assert len(gateway.of("POST", TOKEN)) == 4

                # The reconnect backoff renews the token that renewal was for: the issuer is asked again, and the
                # token the gateway refused is not handed back without a grant.
                assert await soon(hurried(reached(session.token, lambda held_token: held_token == renewed))) == renewed
                assert len(gateway.of("POST", TOKEN)) == 5
                assert await kept.held() == held(gateway, renewed, "refresh-2")
            assert told == []
            assert said_by_the_session(await heard.ended()) == [("session.refresh-exhausted", "kb")]

    run(scenario())


@final
class Unrecording(InMemory):
    """A kept sign-in that is read and renewed as any is, on which no person can be recorded: recording one raises."""

    @override
    async def record_person_key(self, access: str, person_key: str) -> bool:
        raise OSError("the person could not be recorded")


def test_a_sign_in_that_cannot_record_who_the_gateway_named_says_keep_failed_once_keeps_nothing_and_the_session_goes_on() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()

        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.on_emit = describing(gateway)
            first, renewed = access(1), access(2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": renewed, "refresh_token": "refresh-2"})]
            kept = Unrecording(held(gateway, first))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                # Said as the session started, before it was handed over: its errors' first reader hears it.
                heard = Heard(session.errors())
                said = [error for error in await heard.so_far() if isinstance(error, SessionError)]
                assert said_by_the_session(said) == [("session.keep-failed", "kb")]
                assert isinstance(said[0].__cause__, OSError)
                # The session goes on: its token is held, and its person signed in.
                assert session.token.value == first
                assert session.user.value == UserResponse.model_validate(ALICE)
                await soon(session.client.browse.resource(ResourceId("res-1")).fresh())
                await pass_time(0.2, step=0.01)

                # A refusal renews the token, and the gateway is asked who the renewed one is: nothing more is said.
                assert await soon(session.refresh(first)) == renewed
                assert session.user.value == UserResponse.model_validate(ALICE)
                await soon(session.client.browse.resource(ResourceId("res-2")).fresh())
                await pass_time(0.2, step=0.01)
                assert len(said_by_the_session(await heard.so_far())) == 1

            assert said_by_the_session(await heard.ended()) == [("session.keep-failed", "kb")]
            held_now = await kept.held()
            assert held_now is not None
            assert held_now.person_key is None
            assert_nothing_kept(storage)

    run(scenario())


def test_a_sign_in_that_names_its_person_and_cannot_record_who_the_gateway_named_ends_the_keeping_it_began_with() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()

        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.on_emit = describing(gateway)
            first = access(1)
            # The sign-in names her already: the client keeps for her from the start, before the gateway is asked.
            kept = Unrecording(replace(held(gateway, first), person_key=ALICE_KEY))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                heard = Heard(session.errors())
                said = [error for error in await heard.so_far() if isinstance(error, SessionError)]
                assert said_by_the_session(said) == [("session.keep-failed", "kb")]
                assert isinstance(said[0].__cause__, OSError)
                # The session goes on, and what its client holds is written nowhere.
                assert session.token.value == first
                assert session.user.value == UserResponse.model_validate(ALICE)
                await soon(session.client.browse.resource(ResourceId("res-1")).fresh())
                await pass_time(0.2, step=0.01)
                assert_nothing_kept(storage)
                assert len(said_by_the_session(await heard.so_far())) == 1

            # Closing writes nothing, and says nothing more.
            assert said_by_the_session(await heard.ended()) == [("session.keep-failed", "kb")]
            assert_nothing_kept(storage)

    run(scenario())


def test_a_session_whose_sign_in_cannot_be_read_when_its_client_saves_keeps_nothing_more_and_says_so_once() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()

        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.on_emit = describing(gateway)
            kept = Unreadable(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                heard = Heard(session.errors())
                client = session.client
                # Ready once the gateway has named the person: what the client holds is kept for her from then on.
                await soon(session.ready())
                await soon(client.browse.resource(ResourceId("res-1")).fresh())
                # Held, and not yet written.
                assert not client.persistence_settled

                kept.failing = True
                await pass_time(0.2, step=0.01)
                assert_nothing_kept(storage)
                assert said_by_the_session(await heard.so_far()) == [("session.keep-failed", "kb")]

                # A sign-in that can be read again does not bring the keeping back.
                kept.failing = False
                await soon(client.browse.resource(ResourceId("res-2")).fresh())
                await pass_time(0.2, step=0.01)
                assert_nothing_kept(storage)
                assert len(said_by_the_session(await heard.so_far())) == 1

            # Closing raises nothing, writes nothing, and says nothing more.
            assert_nothing_kept(storage)
            assert said_by_the_session(await heard.ended()) == [("session.keep-failed", "kb")]

    run(scenario())


def test_a_sign_in_the_closing_flush_cannot_read_is_said_once_on_the_sessions_errors_and_then_they_end() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()

        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.on_emit = describing(gateway)
            kept = Unreadable(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                heard = Heard(session.errors())
                client = session.client
                await soon(client.browse.resource(ResourceId("res-1")).fresh())
                # Held, and not yet written: its save waits, so the close's flush is what writes it.
                assert not client.persistence_settled
                kept.failing = True

            # The flush could not read the sign-in: the one failure the session says, before its errors end.
            said = await heard.ended()
            assert [error.code for error in said] == ["session.keep-failed"]
            assert said_by_the_session(said) == [("session.keep-failed", "kb")]
            assert_nothing_kept(storage)

    run(scenario())


def test_a_write_the_storage_still_refuses_after_the_closing_flush_is_said_on_the_sessions_errors_and_the_close_raises_nothing() -> None:
    async def scenario() -> None:
        kept_types = cache_key("kb", ALICE_KEY, "entityTypes")
        storage = Refusing(kept_types, times=None)

        async with GatewayServer() as gateway:
            trusting(gateway)

            def answering(emit: JsonObject) -> None:
                if emit["channel"] == "browse:entity-types-requested":
                    answer: JsonObject = {"response": {"entityTypes": ["Person", "Place"]}}
                    gateway.send(None, {"channel": "browse:entity-types-result", "payload": answer, "correlationId": emit["correlationId"]})

            gateway.on_emit = answering
            kept = MemorySignIn(held(gateway, access(1)))

            async with session_from_kept(gateway.target("kb"), kept=kept, storage=storage) as session:
                heard = Heard(session.errors())
                client = session.client
                client_first = asyncio.create_task(closed_before_it_ended(session))
                await soon(reached(client.transport.state, lambda state: state == "open"))
                assert await soon(client.browse.entity_types().fresh()) == ["Person", "Place"]

                # The storage refuses the save: it is said once, as it happens, and the save is still owed.
                await pass_time(0.2, step=0.01)
                assert storage.refusals == 1
                assert not client.persistence_settled
                said = await heard.so_far()
                assert [error.code for error in said] == ["session.save-refused"]
                assert refusals_said(said) == 1

            # The client was closed first, and the session ended after its flush.
            assert await soon(client_first)
            # The close's flush is refused too, and what it could not write is lost. Closing raised nothing; each
            # refusal is said once, the closing's among them, and then the errors end.
            assert storage.refusals > 1
            assert storage.get(kept_types) is None
            said = await heard.ended()
            assert [error.code for error in said] == ["session.save-refused"] * storage.refusals
            assert refusals_said(said) == storage.refusals

    run(scenario())
