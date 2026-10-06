"""Signing in over HTTP: an agent, a person through a kept sign-in, and a person by the device grant.

One scripted server stands as the gateway and as the issuer it trusts. What
is asked of each, in what form and how often, is what these tests hold: the
issuer's answers decide whether a renewal is tried again, and a refresh token
is spent once.
"""

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import final, override
from urllib.parse import parse_qs

import pytest
from aio import hurried, pass_time, run, settle, soon
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject
from stub_gateway import NOT_FOUND, Answer, Asked, StubGateway
from tokens import expired, token

from semiont.bus import reply_channels_for
from semiont.errors import SignInError, TransportError
from semiont.http import AgentToken, Credential, DeviceCode, HttpTransport, ServiceToken, session_from_kept, sign_in_device, sign_out
from semiont.http.oauth import (
    IssuedTokens,
    discover_issuer,
    issuer_client,
    refresh_at_issuer,
    renew_kept,
    revoke_at_issuer,
    sign_in_with_device_grant,
)
from semiont.identity import agent_did
from semiont.operations import BROWSE_RESOURCE_REQUESTED, MARK_DELETE
from semiont.session import HeldSignIn, MemorySignIn, SessionEndReason, SignInKept
from semiont.sign_in_store import FILE_NAME, SignInStore
from semiont.timing import MIN_REFRESH_DELAY_MS
from semiont.watched import Watched, reached

_JSON = TypeAdapter[JsonValue](JsonValue)

REALM = "/realms/semiont"
CONFIGURATION = f"{REALM}/.well-known/openid-configuration"
TOKEN, DEVICE, REVOKE = f"{REALM}/token", f"{REALM}/device", f"{REALM}/revoke"
METADATA = "/.well-known/oauth-protected-resource"
AGENT = "/api/tokens/agent"
ME = "/api/users/me"
ALICE: JsonObject = {
    "did": "did:web:example.org:users:alice",
    "email": "alice@example.org",
    "name": "Alice",
    "image": None,
    "domain": "example.org",
}
REFUSED = Answer(status=401, body=b'{"error":"The token is not one this gateway admits"}')


def says(body: JsonValue, status: int = 200) -> Answer:
    return Answer(status=status, body=_JSON.dump_json(body))


def issuer_of(gateway: StubGateway) -> str:
    return f"{gateway.origin}{REALM}"


def trusting(gateway: StubGateway, *, device: bool = True, revocation: bool = True) -> None:
    """The gateway names its issuer, and the issuer its endpoints."""
    issuer = issuer_of(gateway)
    gateway.answers[METADATA] = {
        "resource": "https://kb.example.org",
        "authorization_servers": [issuer],
        "bearer_methods_supported": ["header"],
    }
    configuration: JsonObject = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/auth",
        "token_endpoint": f"{gateway.origin}{TOKEN}",
    }
    if device:
        configuration["device_authorization_endpoint"] = f"{gateway.origin}{DEVICE}"
    if revocation:
        configuration["revocation_endpoint"] = f"{gateway.origin}{REVOKE}"
    gateway.answers[CONFIGURATION] = configuration
    gateway.answers[ME] = ALICE


def form(asked: Asked) -> dict[str, str]:
    """A request's body, which is a form: each field once."""
    assert asked.headers["content-type"] == "application/x-www-form-urlencoded"
    fields = parse_qs(asked.body.decode(), keep_blank_values=True, strict_parsing=True)
    assert all(len(values) == 1 for values in fields.values())
    return {name: values[0] for name, values in fields.items()}


def access(n: int, lifetime: int = 3600) -> str:
    return token(lifetime, n, email="alice@example.org", iss="https://issuer.example.org")


def held(gateway: StubGateway, access_token: str, refresh: str = "refresh-1") -> HeldSignIn:
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


def sent_with(gateway: StubGateway, method: str, path: str) -> list[str | None]:
    return [asked.headers.get("authorization") for asked in gateway.of(method, path)]


# ── The issuer a knowledge base trusts ──────────────────────────────────


def test_the_knowledge_base_names_its_issuer_and_the_issuer_its_endpoints() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway, issuer_client() as http:
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


def test_a_kept_sign_in_is_renewed_and_what_the_issuer_rotated_is_kept() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            kept = MemorySignIn(held(gateway, access(1)))
            renewed = access(2)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": renewed, "refresh_token": "refresh-2"})]

            assert await soon(renew_kept(kept)) == renewed
            assert await kept.held() == held(gateway, renewed, "refresh-2")
            assert form(gateway.of("POST", TOKEN)[0])["refresh_token"] == "refresh-1"

            # With nothing kept there is nothing to renew, and nobody is asked: an absence, not a failure.
            assert await soon(renew_kept(MemorySignIn())) is None
            assert len(gateway.of("POST", TOKEN)) == 1

    run(scenario())


def test_a_renewal_the_issuer_did_not_refuse_is_tried_again_inside_its_budget() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            kept = MemorySignIn(held(gateway, access(1)))
            renewed = access(2)
            # "Not now", and no answer at all: neither is the issuer's verdict.
            gateway.scripted[("POST", TOKEN)] = [Answer(status=503), Answer(hang_up=True), says({"access_token": renewed})]

            assert await hurried(renew_kept(kept)) == renewed
            assert len(gateway.of("POST", TOKEN)) == 3
            # The same refresh token each time: it was not spent by an attempt that got no grant.
            assert {form(asked)["refresh_token"] for asked in gateway.of("POST", TOKEN)} == {"refresh-1"}

    run(scenario())


def test_a_refused_grant_is_final_and_a_spent_budget_says_how_many_attempts_it_took() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            first = access(1)
            kept = MemorySignIn(held(gateway, first))

            gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_grant"}, 400)]
            with pytest.raises(SignInError) as refused:
                await hurried(renew_kept(kept))
            assert refused.value.message == "The issuer refused the token request (invalid_grant)"
            assert (refused.value.status, len(gateway.of("POST", TOKEN))) == (400, 1)

            gateway.scripted[("POST", TOKEN)] = [Answer(status=503)] * 9
            with pytest.raises(SignInError) as spent:
                await hurried(renew_kept(kept))
            assert (
                spent.value.message == "The session could not be renewed after 4 attempts: The issuer refused the token request (HTTP 503)"
            )
            assert (spent.value.code, spent.value.status) == ("exchange", 503)
            assert len(gateway.of("POST", TOKEN)) == 1 + 4
            # What is kept is as it was: a renewal that failed changes nothing.
            assert await kept.held() == held(gateway, first)

    run(scenario())


@final
class SignedOutMeanwhile(SignInKept):
    """A sign-in that is signed out between its renewal's request and the keeping of what came back."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        self._kept = MemorySignIn(sign_in)
        self.kept_back = False

    @override
    async def held(self) -> HeldSignIn | None:
        found = await self._kept.held()
        await self._kept.forget()
        return found

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await self._kept.keep(sign_in)

    @override
    async def renewed(self, access: str, refresh: str) -> bool:
        self.kept_back = await self._kept.renewed(access, refresh)
        return self.kept_back

    @override
    async def forget(self) -> None:
        await self._kept.forget()


def test_a_sign_in_that_ended_while_it_was_renewed_is_given_no_token() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            kept = SignedOutMeanwhile(held(gateway, access(1)))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": access(2), "refresh_token": "refresh-2"})]

            # A session that is over is not handed a credential again.
            assert await soon(renew_kept(kept)) is None
            assert not kept.kept_back
            assert len(gateway.of("POST", TOKEN)) == 1

    run(scenario())


def test_revocation_is_one_form_and_a_refusal_is_said() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway, issuer_client() as http:
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


def minted(**stated: JsonValue) -> Answer:
    """The issuer's answer to a device authorization request."""
    return says(
        {"device_code": "the-device-code", "user_code": "WDJB-MJHT", "verification_uri": "https://issuer.example.org/device", **stated}
    )


PENDING = says({"error": "authorization_pending"}, 400)


def test_the_device_grant_shows_the_code_and_asks_at_the_issuers_interval_until_the_tokens_arrive() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
            # Told to slow down, it leaves five seconds more between asks.
            await pass_time(6.8)
            await settle()
            assert polls() == 2
            await pass_time(0.3)
            await soon(gateway.arrived("POST", TOKEN, 3))

            issuer, tokens = await soon(signing)
            assert issuer.token == f"{gateway.origin}{TOKEN}"
            assert tokens == IssuedTokens(access="access-1", refresh="refresh-1")

    run(scenario())


def test_an_issuer_that_states_no_interval_is_asked_every_five_seconds_until_the_code_has_expired() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            gateway.scripted[("POST", DEVICE)] = [minted(expires_in=30)]
            gateway.scripted[("POST", TOKEN)] = [PENDING] * 20

            loop = asyncio.get_running_loop()
            began = loop.time()
            with pytest.raises(SignInError, match="expired before it was approved") as over:
                await hurried(sign_in_with_device_grant(gateway.origin, lambda _: None))
            assert (over.value.code, over.value.status) == ("expired", None)
            # One ask each five seconds of the half minute, and none once it is over.
            assert 5 <= len(gateway.of("POST", TOKEN)) <= 6
            assert 30 <= loop.time() - began < 36

    run(scenario())


def test_an_issuer_that_states_no_lifetime_mints_a_code_good_for_ten_minutes() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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

SECRET = "s3cr3t &=+/"


def account(gateway: StubGateway) -> Credential:
    return Credential(issuer=issuer_of(gateway), client_id="semiont-smelter", client_secret=SECRET)


def agent_token(n: int, lifetime: int = 3600) -> Answer:
    return says({"token": token(lifetime, n), "did": agent_did("example.org", "ollama", "gemma2:27b")})


def test_a_service_account_signs_in_once_and_its_token_is_used_until_it_is_due() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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
        async with StubGateway() as gateway:
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


def test_an_agent_is_signed_in_by_exchanging_its_service_accounts_token_and_feeds_a_transport() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            service_token = token(3600, 0)
            gateway.answers[TOKEN] = {"access_token": service_token}
            gateway.scripted[("POST", AGENT)] = [agent_token(1), agent_token(2)]

            agent = AgentToken(f"{gateway.origin}/", provider="ollama", model="gemma2:27b", service=ServiceToken(account(gateway)))
            assert now(agent.token) is None
            async with agent:
                assert agent.gateway == gateway.origin
                first = agent.token.value
                assert first is not None
                exchanged = gateway.of("POST", AGENT)[0]
                assert exchanged.headers["authorization"] == f"Bearer {service_token}"
                assert exchanged.json() == {"provider": "ollama", "model": "gemma2:27b"}

                # What a service holds: a transport, its agent's token source, and the channels it awaits replies on.
                channels = reply_channels_for(BROWSE_RESOURCE_REQUESTED, MARK_DELETE)
                assert channels == ("browse:resource-result", "browse:resource-failed", "mark:delete-ok", "mark:delete-failed")
                async with HttpTransport(gateway.origin, token=agent.token, refresher=agent.refresh, channels=channels) as transport:
                    await soon(reached(transport.state, lambda state: state == "open"))
                    assert sent_with(gateway, "POST", "/bus/subscribe") == [f"Bearer {first}"]
                    assert gateway.subscriptions[0]["global"] == list(channels)

                    # The gateway refuses the token: the agent exchanges again, and the request is made with what came back.
                    gateway.answers["/api/health"] = {
                        "status": "ok",
                        "message": "serving",
                        "version": "0.0.0",
                        "timestamp": "2026-10-06T05:04:06.111Z",
                    }
                    gateway.scripted[("GET", "/api/health")] = [REFUSED]
                    await soon(transport.health_check())
                    second = agent.token.value
                    assert second not in (None, first)
                    assert sent_with(gateway, "GET", "/api/health") == [f"Bearer {first}", f"Bearer {second}"]
                    assert len(gateway.of("POST", AGENT)) == 2
            with pytest.raises(RuntimeError, match="signed in once"):
                await agent.__aenter__()

    run(scenario())


def test_an_agent_that_cannot_be_signed_in_says_so_on_the_way_in() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
            service = ServiceToken(account(gateway))

            def agent() -> AgentToken:
                return AgentToken(gateway.origin, provider="ollama", model="gemma2:27b", service=service)

            gateway.scripted[("POST", AGENT)] = [Answer(status=403, body=b'{"error":"This account may not act as an agent"}')]
            with pytest.raises(TransportError, match=r"refused the agent token exchange \(HTTP 403\)") as refused:
                async with agent():
                    pass
            assert (refused.value.code, refused.value.status) == ("forbidden", 403)

            gateway.scripted[("POST", AGENT)] = [says({"did": "did:web:example.org:agents:a:b"})]
            with pytest.raises(TransportError, match="did not answer an agent token") as malformed:
                async with agent():
                    pass
            assert (malformed.value.code, malformed.value.status) == ("error", 200)

            gateway.scripted[("POST", AGENT)] = [Answer(hang_up=True)]
            with pytest.raises(TransportError, match="/api/tokens/agent got no answer") as silent:
                async with agent():
                    pass
            assert (silent.value.code, silent.value.status) == ("unavailable", None)

            # Its service account failing is the account's failure.
            gateway.scripted[("POST", TOKEN)] = [Answer(status=401)]
            with pytest.raises(SignInError):
                async with AgentToken(gateway.origin, provider="ollama", model="gemma2:27b", service=ServiceToken(account(gateway))):
                    pass

    run(scenario())


def test_an_agent_renews_its_token_when_it_is_due_and_keeps_the_one_it_has_when_a_renewal_fails() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(86_400, 0)}
            gateway.scripted[("POST", AGENT)] = [agent_token(1, 300), agent_token(2, 30)]

            async with AgentToken(gateway.origin, provider="ollama", model="gemma2:27b", service=ServiceToken(account(gateway))) as agent:
                first = agent.token.value
                # Half its life: not before.
                await pass_time(140)
                await settle()
                assert len(gateway.of("POST", AGENT)) == 1
                await pass_time(12)
                await soon(gateway.arrived("POST", AGENT, 2))
                await settle()
                second = agent.token.value
                assert second not in (None, first)

                # A refusal is final for this renewal: the token is left as it is, and nothing is said.
                gateway.scripted[("POST", AGENT)] = [Answer(status=403)]
                assert await soon(agent.refresh()) is None
                assert agent.token.value == second

                # An outage is tried again inside the renewal budget, and a token that still works is not given up.
                # The token it holds is due a quarter of a minute after it was issued.
                gateway.scripted[("POST", AGENT)] = [Answer(status=503), Answer(hang_up=True), agent_token(3, 300)]
                asked = len(gateway.of("POST", AGENT))
                loop = asyncio.get_running_loop()
                tried: list[float] = []

                async def renewed() -> None:
                    await gateway.arrived("POST", AGENT, asked + 1)
                    tried.append(loop.time())
                    await reached(agent.token, lambda held_token: held_token != second)

                await hurried(renewed())
                assert len(gateway.of("POST", AGENT)) == asked + 3
                # Inside the one renewal's budget, and not a schedule's floor apart.
                assert loop.time() - tried[0] < MIN_REFRESH_DELAY_MS / 1000

    run(scenario())


# ── A person's session over a kept sign-in ──────────────────────────────


def test_a_session_over_what_semiont_login_kept_is_ready_and_renews_through_the_store(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            store = SignInStore(tmp_path / FILE_NAME)
            kept = store.entry("local")
            first, second = access(1), access(2)
            await kept.keep(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": second, "refresh_token": "refresh-2"})]
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.origin, kb_id="local", kept=kept, on_auth_failed=told.append) as session:
                # Ready inside: the gateway has said who the kept token is, and the stream is opening with it.
                assert session.token.value == first
                signed_in = session.user.value
                assert signed_in is not None
                assert signed_in.email == "alice@example.org"
                assert sent_with(gateway, "GET", ME) == [f"Bearer {first}"]
                await soon(reached(session.transport.state, lambda state: state == "open"))
                assert sent_with(gateway, "POST", "/bus/subscribe") == [f"Bearer {first}"]

                # The gateway refuses the token: it is renewed at the issuer the sign-in names, and asked about.
                assert await soon(session.refresh()) == second
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
            assert told == []

    run(scenario())


def test_a_request_the_gateway_refuses_is_made_again_with_the_sessions_renewed_token() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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

            async with session_from_kept(gateway.origin, kb_id="kb", kept=kept, channels=()) as session:
                transport = session.transport
                await soon(transport.health_check())
                assert sent_with(gateway, "GET", "/api/health") == [f"Bearer {first}", f"Bearer {second}"]
                assert session.token.value == second
                assert len(gateway.of("POST", TOKEN)) == 1

    run(scenario())


def test_with_nothing_kept_a_session_is_signed_out_and_its_requests_are_refused() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            gateway.scripted[("GET", "/api/health")] = [REFUSED]
            told: list[SessionEndReason] = []

            async with session_from_kept(gateway.origin, kb_id="kb", kept=MemorySignIn(), on_auth_failed=told.append) as session:
                assert (session.token.value, session.user.value) == (None, None)
                transport = session.transport
                with pytest.raises(TransportError) as refused:
                    await soon(transport.health_check())
                assert refused.value.code == "unauthorized"
            # Nobody was asked who nobody is, no stream was opened, and there was no session to end.
            assert (gateway.of("GET", ME), gateway.of("POST", "/bus/subscribe"), gateway.of("POST", TOKEN), told) == ([], [], [], [])

    run(scenario())


def test_a_session_whose_issuer_will_not_renew_it_is_over_and_its_sign_in_is_forgotten(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
            said: list[str] = []

            async with session_from_kept(
                gateway.origin, kb_id="local", kept=kept, on_auth_failed=told.append, on_error=lambda error: said.append(error.message)
            ) as session:
                # The kept token had expired: it was renewed before anyone was asked.
                assert session.token.value == renewed
                assert sent_with(gateway, "GET", ME) == [f"Bearer {renewed}"]
                assert await soon(session.refresh()) is None
                assert now(session.token) is None
            assert told == ["expired"]
            assert said == ["Token refresh failed: The issuer refused the token request (invalid_grant: Session not active)"]
            assert store.read() == {}

    run(scenario())


@final
class Slowly(SignInKept):
    """A kept sign-in that is read at once the first time, and after that only once it is released."""

    def __init__(self, sign_in: HeldSignIn) -> None:
        self._kept = MemorySignIn(sign_in)
        self.release = asyncio.Event()
        self.reads = 0

    @override
    async def held(self) -> HeldSignIn | None:
        self.reads += 1
        if self.reads > 1:
            await self.release.wait()
        return await self._kept.held()

    @override
    async def keep(self, sign_in: HeldSignIn) -> None:
        await self._kept.keep(sign_in)

    @override
    async def renewed(self, access: str, refresh: str) -> bool:
        return await self._kept.renewed(access, refresh)

    @override
    async def forget(self) -> None:
        await self._kept.forget()


def test_renewals_asked_for_together_spend_one_refresh_token() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
                async with session_from_kept(gateway.origin, kb_id="kb", kept=kept, on_auth_failed=told.append) as session:
                    await soon(reached(session.transport.state, lambda state: state == "open"))
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
        async with StubGateway() as gateway:
            trusting(gateway)
            first, second = access(1), access(2)
            kept = Slowly(held(gateway, first))
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": second, "refresh_token": "refresh-2"})]
            gateway.scripted[("GET", "/api/health")] = [REFUSED]

            async with session_from_kept(gateway.origin, kb_id="kb", kept=kept, channels=()) as session:
                transport = session.transport
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
        async with StubGateway() as gateway:
            trusting(gateway)
            kept = Slowly(held(gateway, access(1)))
            gateway.scripted[("GET", "/api/health")] = [REFUSED]

            async with session_from_kept(gateway.origin, kb_id="kb", kept=kept, channels=()) as session:
                transport = session.transport
                with pytest.raises(TimeoutError):
                    async with asyncio.timeout(0.1):
                        await transport.health_check()
            # `run` fails a scenario that leaves a task behind: the renewal, still waiting to read what is kept, was ended.
            assert gateway.of("POST", TOKEN) == []

    run(scenario())


# ── Signing in by the device grant, and signing out ─────────────────────


def test_a_person_signs_in_by_the_device_grant_and_the_sign_in_is_kept_as_semiont_login_keeps_one(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            store = SignInStore(tmp_path / FILE_NAME)
            kept = store.entry("local")
            issued = token(3600, 1, email="alice@example.org", iss=issuer_of(gateway))
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [PENDING, says({"access_token": issued, "refresh_token": "refresh-1"})]
            shown: list[DeviceCode] = []

            await hurried(sign_in_device(gateway.origin, kept, shown.append))

            assert [code.user_code for code in shown] == ["WDJB-MJHT"]
            assert await kept.held() == held(gateway, issued)
            written = store.read()["local"]
            assert isinstance(written, dict)
            assert (written["email"], written["issuer"]) == ("alice@example.org", issuer_of(gateway))

            # And a session over it is that person's.
            async with session_from_kept(gateway.origin, kb_id="local", kept=kept, channels=()) as session:
                assert session.token.value == issued
                assert sent_with(gateway, "GET", ME) == [f"Bearer {issued}"]

    run(scenario())


def test_a_device_grant_that_does_not_sign_in_keeps_nothing() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
            trusting(gateway)
            kept = MemorySignIn()
            gateway.scripted[("POST", DEVICE)] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [says({"error": "access_denied"}, 400)]

            with pytest.raises(SignInError) as denied:
                await hurried(sign_in_device(gateway.origin, kept, lambda _: None))
            assert denied.value.code == "denied"
            assert await kept.held() is None

    run(scenario())


def test_signing_out_revokes_the_refresh_token_and_forgets_the_sign_in_whatever_the_issuer_answers() -> None:
    async def scenario() -> None:
        async with StubGateway() as gateway:
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
