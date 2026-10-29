"""A registry of knowledge bases over HTTP, and a person's sign-in by a page redirect.

One scripted server stands as the gateway and as the issuer it trusts. The
gateway says who a token is, holds streams, and answers on every stream a
request to describe itself, as it describes itself or refusing, and a request
for a resource. What a registry's sessions, a redirect sign-in and a completed
sign-in's question ask of each, and what they keep, is what these tests hold.
"""

import asyncio
from collections.abc import Callable
from typing import Final, final
from urllib.parse import parse_qs, urlsplit

import pytest
from aio import run, soon
from gateway_server import Asked, GatewayServer
from issuer import CONFIGURATION, ME, REFUSED, REVOKE, TOKEN, issuer_of, says, trusting
from kb import recorded
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject
from tokens import expired, token

from semiont.cache import Ready
from semiont.errors import IdentityUnverifiableError, SignInError
from semiont.http.oauth import (
    BeginAuthorizationOptions,
    IssuedTokens,
    PendingAuthorization,
    begin_authorization,
    code_challenge,
    complete_authorization,
)
from semiont.http.session import HttpSessionFactory, begin_sign_in, complete_sign_in, describe_connection
from semiont.identifiers import ResourceId
from semiont.registry import SemiontBrowser, SemiontBrowserConfig, save_knowledge_bases, store_session, stored_session
from semiont.session import SemiontSession
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import PENDING_AUTHORIZATION_KEY, StoredSession
from semiont.transport import Transport
from semiont.types import HttpEndpoint, KnowledgeBase, LocalEndpoint
from semiont.watched import reached

_JSON = TypeAdapter[JsonValue](JsonValue)

DID_A: Final = "did:web:example.org:kb-a"
REDIRECT: Final = "http://127.0.0.1:9/callback"
DESCRIBED: Final[JsonObject] = {"name": "KB A", "domain": "example.org:kb-a", "gitBranch": "main"}
PLACES: Final = "semiont.lastEventId.kb-a"
"""Where a session of `kb-a` keeps its stream's place in each scope."""


@final
class Describing:
    """The knowledge base behind the gateway: what it answers a request to describe itself, and a request for a resource.

    `describes` is what it says of itself; none refuses to say.
    """

    def __init__(self, gateway: GatewayServer) -> None:
        self._gateway: Final = gateway
        self.describes: JsonObject | None = DESCRIBED
        gateway.on_emit = self._answer

    def _answer(self, emit: JsonObject) -> None:
        correlation = emit.get("correlationId")
        payload = emit.get("payload")
        if correlation is None or not isinstance(payload, dict):
            return
        match emit.get("channel"):
            case "browse:kb-requested" if self.describes is None:
                refused: JsonObject = {"message": "this knowledge base cannot say what it is"}
                self._gateway.send(None, {"channel": "browse:kb-failed", "payload": refused, "correlationId": correlation})
            case "browse:kb-requested":
                said: JsonObject = {"response": self.describes}
                self._gateway.send(None, {"channel": "browse:kb-result", "payload": said, "correlationId": correlation})
            case "browse:resource-requested":
                resource = payload.get("resourceId")
                described: JsonObject = {"@context": "https://schema.org", "@id": resource, "name": resource, "representations": []}
                answer: JsonObject = {"response": {"resource": described, "lastSequence": 1}}
                self._gateway.send(None, {"channel": "browse:resource-result", "payload": answer, "correlationId": correlation})
            case _:
                pass


def endpoint_of(gateway: GatewayServer) -> HttpEndpoint:
    """The HTTP endpoint the gateway is at."""
    endpoint = gateway.target("kb").endpoint
    assert isinstance(endpoint, HttpEndpoint)
    return endpoint


def registered(gateway: GatewayServer, kb_id: str) -> KnowledgeBase:
    return KnowledgeBase(id=kb_id, label="KB A", did=DID_A, endpoint=endpoint_of(gateway))


def stored(gateway: GatewayServer, access: str, refresh: str) -> StoredSession:
    """A session kept for the browser client, renewed and revoked at the gateway's issuer."""
    return StoredSession(
        access=access,
        refresh=refresh,
        client_id="semiont-browser",
        token_endpoint=f"{gateway.origin}{TOKEN}",
        revocation_endpoint=f"{gateway.origin}{REVOKE}",
    )


def granting(gateway: GatewayServer, *grants: tuple[str, str]) -> None:
    """Have the issuer's token endpoint grant these tokens, one each, and refuse after them."""
    gateway.scripted[("POST", TOKEN)] = [
        says({"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600}) for access, refresh in grants
    ]


def fields(asked: Asked) -> dict[str, str]:
    """A request's body, which is a form: each field once."""
    return {name: values[0] for name, values in parse_qs(asked.body.decode(), keep_blank_values=True).items()}


def query(address: str) -> dict[str, str]:
    """What an address asks: each name once."""
    return {name: values[0] for name, values in parse_qs(urlsplit(address).query, keep_blank_values=True).items()}


def browser_over(storage: SessionStorage) -> SemiontBrowser:
    return SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=HttpSessionFactory()))


async def live(browser: SemiontBrowser) -> SemiontSession[Transport]:
    """The registry's live session, once it has one."""
    session = await soon(reached(browser.active_session, lambda session: session is not None), within=10)
    assert session is not None
    return session


async def until(what: str, seen: Callable[[], bool]) -> None:
    """Wait, ten seconds at most, for `seen` to hold."""
    for _ in range(1000):
        if seen():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"{what} did not happen")


async def sent_back(gateway: GatewayServer, browser: SemiontBrowser, options: BeginAuthorizationOptions) -> str:
    """Begin a sign-in through the registry, and give the address the issuer would send the person back to."""
    address = await soon(begin_sign_in(browser, options))
    return f"{REDIRECT}?state={query(address)['state']}&code=the-code"


# ── A registry's sessions over HTTP ─────────────────────────────────────


def test_a_registry_brings_up_a_session_that_says_who_it_is_and_renews_an_expired_token() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            storage = MemoryStorage()
            save_knowledge_bases(storage, [registered(gateway, "kb-a")])
            store_session(storage, "kb-a", stored(gateway, expired(), "r1"))
            renewed = token(3600, 2)
            granting(gateway, (renewed, "r2"))

            async with browser_over(storage) as browser:
                session = await live(browser)

                assert session.token.value == renewed
                # The gateway was asked about the renewed token alone: the expired one was renewed before anyone was asked.
                assert [asked.headers.get("authorization") for asked in gateway.of("GET", ME)] == [f"Bearer {renewed}"]
                user = session.user.value
                assert user is not None
                assert user.did == "did:web:example.org:users:alice"
                assert fields(gateway.of("POST", TOKEN)[0]) == {
                    "grant_type": "refresh_token",
                    "refresh_token": "r1",
                    "client_id": "semiont-browser",
                }
                assert stored_session(storage, "kb-a") == stored(gateway, renewed, "r2")

    run(scenario())


def test_renewals_asked_for_together_are_one_request_of_the_issuer() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            storage = MemoryStorage()
            save_knowledge_bases(storage, [registered(gateway, "kb-a")])
            store_session(storage, "kb-a", stored(gateway, token(3600, 1), "r1"))

            async with browser_over(storage) as browser:
                session = await live(browser)
                renewed = token(3600, 2)
                granting(gateway, (renewed, "r2"))

                renewals = await soon(asyncio.gather(session.refresh(), session.refresh(), session.refresh()))

                assert list(renewals) == [renewed, renewed, renewed]
                assert len(gateway.of("POST", TOKEN)) == 1, "an issuer that rotates refresh tokens would have refused the second"

    run(scenario())


def test_a_registry_over_http_cannot_build_a_session_for_what_is_not_at_a_gateway() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        here = KnowledgeBase(id="kb-local", label="Here", did=DID_A, endpoint=LocalEndpoint(kind="local", kb_id="here"))
        save_knowledge_bases(storage, [here])
        browser = browser_over(storage)
        async with browser.errors() as errors, browser:
            refused = await soon(anext(errors))
            assert (refused.code, refused.kb_id, refused.message) == (
                "session.construct-failed",
                "kb-local",
                'A session over HTTP cannot be built for endpoint kind "local"',
            )
            assert browser.active_session.value is None

    run(scenario())


def test_a_registry_over_http_puts_no_host_that_is_no_hosts_name_into_a_url() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        nowhere = HttpEndpoint(kind="http", host="evil.example/x", port=4000, protocol="https")
        save_knowledge_bases(storage, [KnowledgeBase(id="kb-a", label="KB A", did=DID_A, endpoint=nowhere)])
        browser = browser_over(storage)
        async with browser.errors() as errors, browser:
            refused = await soon(anext(errors))
            assert (refused.code, refused.kb_id, refused.message) == (
                "session.construct-failed",
                "kb-a",
                'Invalid KB hostname: "evil.example/x"',
            )

    run(scenario())


def test_signing_out_of_a_registry_revokes_the_refresh_token_at_its_issuer() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            gateway.answers[REVOKE] = {}
            storage = MemoryStorage()
            save_knowledge_bases(storage, [registered(gateway, "kb-a")])
            store_session(storage, "kb-a", stored(gateway, token(3600, 1), "r1"))

            async with browser_over(storage) as browser:
                await live(browser)

                await soon(browser.sign_out("kb-a"))
                await soon(gateway.arrived("POST", REVOKE))

                assert fields(gateway.of("POST", REVOKE)[0]) == {
                    "token": "r1",
                    "token_type_hint": "refresh_token",
                    "client_id": "semiont-browser",
                }
                assert stored_session(storage, "kb-a") is None
                assert browser.active_session.value is None

    run(scenario())


def test_a_registrys_session_resumes_its_stream_from_the_place_its_storage_kept() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            storage = MemoryStorage()
            save_knowledge_bases(storage, [registered(gateway, "kb-a")])
            store_session(storage, "kb-a", stored(gateway, token(3600, 1), "r1"))
            storage.set(PLACES, '{"res-1":"p-5"}')

            def resumed_from() -> JsonValue:
                for subscription in gateway.subscriptions:
                    scoped = subscription.get("scoped")
                    if isinstance(scoped, list):
                        for entry in scoped:
                            if isinstance(entry, dict) and entry.get("scope") == "res-1" and "lastEventId" in entry:
                                return entry["lastEventId"]
                return None

            def kept_places() -> JsonValue:
                kept = storage.get(PLACES)
                return None if kept is None else _JSON.validate_json(kept)

            async with browser_over(storage) as browser:
                session = await live(browser)
                # Watching a query of the resource holds its scope.
                async with session.client.browse.resource(ResourceId("res-1")) as watched:
                    while not isinstance(await soon(anext(watched)), Ready):
                        pass
                    await until("the stream names the scope", lambda: resumed_from() is not None)
                    assert resumed_from() == "p-5"

                    # A recorded event of the scope moves the place, and the place is kept once the caches have taken the
                    # event in and written what they hold: an archived resource is asked for again, and its description written.
                    gateway.send("p-9", {"channel": "mark:archived", "scope": "res-1", "payload": recorded("mark:archived", "res-1")})
                    await until("the place is kept", lambda: kept_places() == {"res-1": "p-9"})

    run(scenario())


# ── A registry's sign-in by a page redirect ─────────────────────────────


def test_a_registrys_sign_in_registers_the_knowledge_base_under_what_it_says_it_is() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            storage = MemoryStorage()
            access = token(3600, 1)
            granting(gateway, (access, "a-refresh-token"))

            async with browser_over(storage) as browser:
                options = BeginAuthorizationOptions(
                    target=endpoint_of(gateway),
                    redirect_uri=REDIRECT,
                    expected_did="did:web:example.org:another",
                    expected_name="Another",
                )
                outcome = await soon(complete_sign_in(browser, await sent_back(gateway, browser, options)))

                assert (outcome.kb.did, outcome.kb.label, outcome.kb.endpoint) == (DID_A, "KB A", endpoint_of(gateway))
                assert outcome.kb.last_read is not None
                assert outcome.kb.last_read.git_branch == "main"
                # What the person believed they clicked is said back, not acted on.
                assert outcome.expected is not None
                assert (outcome.expected.did, outcome.expected.name) == ("did:web:example.org:another", "Another")
                assert [(kb.id, kb.did) for kb in browser.kbs.value] == [(outcome.kb.id, DID_A)]
                assert stored_session(storage, outcome.kb.id) == stored(gateway, access, "a-refresh-token")
                assert (await live(browser)).kb.id == outcome.kb.id
                # The code was exchanged for the browser client, with the verifier the pending sign-in kept.
                exchanged = fields(gateway.of("POST", TOKEN)[0])
                assert (exchanged["grant_type"], exchanged["client_id"], exchanged["code"]) == (
                    "authorization_code",
                    "semiont-browser",
                    "the-code",
                )

    run(scenario())


def test_a_knowledge_base_that_cannot_say_who_it_is_is_not_registered() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            describing = Describing(gateway)
            storage = MemoryStorage()

            async with browser_over(storage) as browser:
                options = BeginAuthorizationOptions(target=endpoint_of(gateway), redirect_uri=REDIRECT)

                describing.describes = None
                granting(gateway, (token(3600, 1), "r"))
                with pytest.raises(IdentityUnverifiableError) as unreported:
                    await soon(complete_sign_in(browser, await sent_back(gateway, browser, options)))
                assert unreported.value.code == "not-reported"

                # An emit the gateway refuses reaches nobody to ask.
                describing.describes = DESCRIBED
                gateway.scripted[("POST", "/bus/emit")] = [REFUSED]
                granting(gateway, (token(3600, 2), "r"))
                with pytest.raises(IdentityUnverifiableError) as unreached:
                    await soon(complete_sign_in(browser, await sent_back(gateway, browser, options)))
                assert unreached.value.code == "unreachable"

                assert (browser.kbs.value, browser.active_kb_id.value) == ((), None)

    run(scenario())


def test_a_callback_that_is_not_the_pending_sign_ins_registers_nothing() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            async with browser_over(MemoryStorage()) as browser:
                await sent_back(gateway, browser, BeginAuthorizationOptions(target=endpoint_of(gateway), redirect_uri=REDIRECT))

                with pytest.raises(SignInError) as refused:
                    await soon(complete_sign_in(browser, f"{REDIRECT}?state=another&code=the-code"))

                assert (refused.value.code, refused.value.message) == (
                    "state",
                    "The sign-in response does not belong to the pending sign-in",
                )
                assert browser.kbs.value == ()
                assert gateway.of("POST", TOKEN) == []

    run(scenario())


def test_asked_with_a_token_the_knowledge_base_says_who_it_is() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            Describing(gateway)
            asking = token(3600, 1)

            identity = await soon(describe_connection(endpoint_of(gateway), asking))

            assert identity.did == DID_A
            assert (identity.description.name, identity.description.git_branch) == ("KB A", "main")
            # Asked with the token it was given, on a stream that names the operation's replies.
            assert [asked.headers.get("authorization") for asked in gateway.of("POST", "/bus/emit")] == [f"Bearer {asking}"]
            assert [emit["channel"] for emit in gateway.emits] == ["browse:kb-requested"]

    run(scenario())


def test_a_knowledge_base_at_a_host_that_is_no_hosts_name_is_not_asked_who_it_is() -> None:
    async def scenario() -> None:
        nowhere = HttpEndpoint(kind="http", host="evil.example/x", port=4000, protocol="https")
        with pytest.raises(IdentityUnverifiableError) as refused:
            await describe_connection(nowhere, token(3600, 1))
        assert (refused.value.code, refused.value.message) == ("unreachable", 'Invalid KB hostname: "evil.example/x"')

    run(scenario())


# ── The authorization-code grant, with PKCE ─────────────────────────────


def pending_in(storage: SessionStorage) -> PendingAuthorization | None:
    """The sign-in pending in `storage`, when one is."""
    kept = storage.get(PENDING_AUTHORIZATION_KEY)
    return None if kept is None else PendingAuthorization.model_validate_json(kept)


async def begun(gateway: GatewayServer, storage: SessionStorage) -> PendingAuthorization:
    """A sign-in begun at the gateway, as `storage` remembers it."""
    await soon(begin_authorization(BeginAuthorizationOptions(target=endpoint_of(gateway), redirect_uri=REDIRECT), storage))
    record = pending_in(storage)
    assert record is not None
    return record


def test_the_challenge_is_the_one_rfc_7636_gives_for_its_verifier() -> None:
    assert code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_beginning_a_sign_in_remembers_it_and_builds_the_url_around_what_it_remembered() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()

            address = await soon(
                begin_authorization(
                    BeginAuthorizationOptions(
                        target=endpoint_of(gateway),
                        redirect_uri=REDIRECT,
                        kb_id="kb-a",
                        expected_did="did:web:example.org:kb-a",
                        expected_name="KB A",
                    ),
                    storage,
                )
            )

            record = pending_in(storage)
            assert record is not None
            assert address.startswith(f"{issuer_of(gateway)}/auth?")
            assert query(address) == {
                "response_type": "code",
                "client_id": "semiont-browser",
                "redirect_uri": REDIRECT,
                "scope": "openid email profile offline_access",
                "state": record.state,
                "code_challenge": code_challenge(record.verifier),
                "code_challenge_method": "S256",
            }
            assert record.target == endpoint_of(gateway)
            assert record.issuer.token == f"{gateway.origin}{TOKEN}"
            assert (record.kb_id, record.expected_did, record.expected_name) == ("kb-a", "did:web:example.org:kb-a", "KB A")
            # Neither is guessable, and neither is the other.
            assert len(record.verifier) >= 43
            assert len(record.state) >= 32
            assert record.verifier != record.state

    run(scenario())


def test_an_issuers_authorization_address_that_already_asks_something_keeps_it() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            asking = f"{issuer_of(gateway)}/auth?prompt=login"
            gateway.answers[CONFIGURATION] = {**gateway.answers[CONFIGURATION], "authorization_endpoint": asking}

            address = await soon(
                begin_authorization(BeginAuthorizationOptions(target=endpoint_of(gateway), redirect_uri=REDIRECT), MemoryStorage())
            )

            assert address.startswith(f"{asking}&")
            asked = query(address)
            assert (asked["prompt"], asked["response_type"], asked["code_challenge_method"]) == ("login", "code", "S256")

    run(scenario())


def test_a_sign_in_to_a_host_that_is_no_hosts_name_asks_nobody_and_remembers_nothing() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        nowhere = HttpEndpoint(kind="http", host="evil.example/x", port=4000, protocol="https")
        with pytest.raises(SignInError) as refused:
            await begin_authorization(BeginAuthorizationOptions(target=nowhere, redirect_uri=REDIRECT), storage)
        assert (refused.value.code, refused.value.message) == ("discovery", 'Invalid KB hostname: "evil.example/x"')
        assert pending_in(storage) is None

    run(scenario())


def test_completing_a_sign_in_exchanges_the_code_with_its_verifier_once() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()
            record = await begun(gateway, storage)
            granting(gateway, ("an-access-token", "a-refresh-token"))
            callback = f"{REDIRECT}?state={record.state}&code=the-code"

            completed, tokens = await soon(complete_authorization(callback, storage))

            assert completed == record
            assert tokens == IssuedTokens(access="an-access-token", refresh="a-refresh-token")
            assert [fields(asked) for asked in gateway.of("POST", TOKEN)] == [
                {
                    "grant_type": "authorization_code",
                    "code": "the-code",
                    "redirect_uri": REDIRECT,
                    "client_id": "semiont-browser",
                    "code_verifier": record.verifier,
                }
            ]
            # The pending record is gone: the same callback again completes nothing.
            assert pending_in(storage) is None
            with pytest.raises(SignInError) as replayed:
                await soon(complete_authorization(callback, storage))
            assert replayed.value.code == "no-pending"
            assert len(gateway.of("POST", TOKEN)) == 1

    run(scenario())


@pytest.mark.parametrize(
    ("response", "code", "message"),
    [
        ("state=another&code=the-code", "state", "The sign-in response does not belong to the pending sign-in"),
        ("error=access_denied&error_description=The+person+said+no", "denied", "The person said no"),
        ("error=server_error", "exchange", "server_error"),
        ("code=the-code", "state", "The sign-in response does not belong to the pending sign-in"),
    ],
)
def test_a_response_that_is_not_the_pending_sign_ins_is_refused_and_nothing_is_exchanged(response: str, code: str, message: str) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()
            granting(gateway, ("an-access-token", "a-refresh-token"))
            await begun(gateway, storage)

            with pytest.raises(SignInError) as refused:
                await soon(complete_authorization(f"{REDIRECT}?{response}", storage))

            assert (refused.value.code, refused.value.message) == (code, message)
            # Refused by what came back, not by the issuer: no status, as though the issuer had answered.
            assert refused.value.status is None
            # Refused or not, a sign-in is completed once.
            assert pending_in(storage) is None
            assert gateway.of("POST", TOKEN) == []

    run(scenario())


def test_a_response_that_carries_no_code_or_is_no_url_is_refused_and_nothing_is_exchanged() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()

            record = await begun(gateway, storage)
            with pytest.raises(SignInError) as without_a_code:
                await soon(complete_authorization(f"{REDIRECT}?state={record.state}", storage))
            assert (without_a_code.value.code, without_a_code.value.message) == (
                "exchange",
                "The sign-in response carries no authorization code",
            )

            record = await begun(gateway, storage)
            with pytest.raises(SignInError) as relative:
                await soon(complete_authorization(f"/callback?state={record.state}&code=the-code", storage))
            assert relative.value.code == "exchange"
            assert relative.value.message.startswith("The sign-in response is not a URL")

            assert gateway.of("POST", TOKEN) == []

    run(scenario())


def test_what_is_pending_and_does_not_read_as_a_sign_in_is_no_sign_in_and_is_taken() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        storage.set(PENDING_AUTHORIZATION_KEY, '{"state":"s"}')
        with pytest.raises(SignInError) as refused:
            await complete_authorization(f"{REDIRECT}?state=s&code=the-code", storage)
        assert (refused.value.code, refused.value.message) == ("no-pending", "No sign-in is pending here")
        assert storage.get(PENDING_AUTHORIZATION_KEY) is None

    run(scenario())


def test_a_token_endpoint_that_refuses_the_code_says_what_it_said_and_the_status_it_answered() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()
            record = await begun(gateway, storage)
            gateway.scripted[("POST", TOKEN)] = [says({"error": "invalid_grant", "error_description": "Code not valid"}, 400)]

            with pytest.raises(SignInError) as refused:
                await soon(complete_authorization(f"{REDIRECT}?state={record.state}&code=the-code", storage))

            assert (refused.value.code, refused.value.status) == ("exchange", 400)
            assert refused.value.message == "The issuer refused the token request (invalid_grant: Code not valid)"

    run(scenario())


def test_a_token_endpoint_that_issues_no_refresh_token_is_refused() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            storage = MemoryStorage()
            record = await begun(gateway, storage)
            gateway.scripted[("POST", TOKEN)] = [says({"access_token": "an-access-token", "token_type": "Bearer", "expires_in": 3600})]

            with pytest.raises(SignInError) as refused:
                await soon(complete_authorization(f"{REDIRECT}?state={record.state}&code=the-code", storage))

            assert refused.value.code == "exchange"
            assert "no refresh token" in refused.value.message

    run(scenario())
