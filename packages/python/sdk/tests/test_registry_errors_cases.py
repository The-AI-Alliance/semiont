"""How a registry reads the errors of each session it activates (`protocol/specs/src/session/registry-errors-cases.json`).

`cases`: a registry over `Scripted`, whose session says what the case says,
while its factory builds it or once it is active, and reads none of it. Its
own errors are said by what keeps its client's (`said`), its transport's
failures by its transport, with the case's code and message, and its renewal
records the token it is handed. `closing`: a registry over its HTTP factory,
over a scripted gateway, whose session's client keeps the entity types it
read in a storage that refuses every write of them: the save refused once it
was made is still owed, and the registry's close is what makes it again.
"""

import asyncio
from collections.abc import AsyncGenerator, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Final, Literal, final, override

import pytest
from aio import Heard, pass_time, run, soon, turns
from gateway_server import GatewayServer
from issuer import ALICE, TOKEN, trusting
from pydantic import BaseModel, Field
from spec import SPEC, JsonObject, read, text
from storages import Refusing
from tokens import token

from semiont.channels import BRIDGED_CHANNELS
from semiont.error_codes import SemiontSessionErrorCode, TransportErrorCode
from semiont.errors import SessionError, TransportError
from semiont.events import Broadcast, Events
from semiont.http.session import HttpSessionFactory
from semiont.registry import (
    SemiontBrowser,
    SemiontBrowserConfig,
    SessionFactory,
    SessionFactoryOptions,
    kept_in,
    save_knowledge_bases,
    store_session,
)
from semiont.session import SemiontSession, said_in_full
from semiont.session_signals import PermissionDenied
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import StoredSession, cache_key, person_key
from semiont.testing import FaultyTransport, create_test_client
from semiont.transport import Transport
from semiont.types import HttpEndpoint, KbTarget, KnowledgeBase
from semiont.watched import Variable, reached


class Own(BaseModel, frozen=True, extra="forbid"):
    own: SemiontSessionErrorCode


class Failure(BaseModel, frozen=True, extra="forbid"):
    transport: TransportErrorCode
    message: str


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    while_: Literal["opening", "active"] = Field(alias="while")
    said: list[Own | Failure] = Field(min_length=1)
    registry_errors: list[SemiontSessionErrorCode] = Field(alias="registryErrors")
    renewed_with: Literal["held"] | None = Field(default=None, alias="renewedWith")
    permission_denied: str | None = Field(default=None, alias="permissionDenied")


class Closing(BaseModel, frozen=True, extra="forbid"):
    why: str
    owed: bool
    registry_errors: list[SemiontSessionErrorCode] = Field(alias="registryErrors")


class Table(BaseModel, frozen=True):
    cases: list[Case] = Field(min_length=1)
    closing: list[Closing] = Field(min_length=1)


STATED: Final = read(SPEC / "session/registry-errors-cases.json")
TABLE: Final = Table.model_validate(STATED)

KB: Final = "kb-a"
ALICE_KEY: Final = person_key(text(ALICE["did"], "Alice's did"))
"""The key of the person the scripted gateway names for every token: what the client keeps hers under."""


def test_every_section_of_the_table_is_run_here() -> None:
    assert {section for section, rows in STATED.items() if isinstance(rows, list)} == {"cases", "closing"}


def signed_in(token_endpoint: str) -> StoredSession:
    """A stored sign-in whose token is good for an hour, naming nobody until a gateway names them."""
    return StoredSession(access=token(3600, 1), refresh="refresh-1", client_id="semiont-browser", token_endpoint=token_endpoint)


def holding_signed_in(storage: SessionStorage, kb: KnowledgeBase, token_endpoint: str) -> SessionStorage:
    """`storage`, holding `kb` alone, signed in: the knowledge base a registry over it makes active."""
    save_knowledge_bases(storage, [kb])
    store_session(storage, kb.id, signed_in(token_endpoint))
    return storage


async def active_session(browser: SemiontBrowser) -> SemiontSession[Transport]:
    session = await soon(reached(browser.active_session, lambda session: session is not None), within=10)
    assert session is not None
    return session


# ── cases ───────────────────────────────────────────────────────────────


def scripted_kb() -> KnowledgeBase:
    endpoint = HttpEndpoint(kind="http", host="localhost", port=4000, protocol="http")
    return KnowledgeBase(id=KB, label="KB A", did="did:web:example.org:kb-a", endpoint=endpoint)


def utterance(said: Own | Failure) -> SessionError | TransportError:
    """What a case's session says: one of its own errors, or a failure of its transport with the case's code and message."""
    if isinstance(said, Own):
        return SessionError(said.own, "the session's own error, as the case says", kb_id=KB)
    return TransportError(said.transport, said.message)


@final
class Speaking:
    """A session `Scripted` built, and what it says through: what keeps its client's, and its transport."""

    def __init__(self, session: SemiontSession[FaultyTransport], keeping: Broadcast[SessionError]) -> None:
        self.session: Final = session
        self._keeping: Final = keeping
        self.held_as_refused: Final[list[str | None]] = []
        """The token the session held as each refusal for want of a valid token was said, in order."""

    async def say(self, said: Sequence[SessionError | TransportError]) -> None:
        """Say each of `said`, in order."""
        for each in said:
            if isinstance(each, SessionError):
                self._keeping.deliver(each)
            else:
                if each.code == "unauthorized":
                    self.held_as_refused.append(self.session.token.value)
                self.session.client.transport.fail(each)
            # Own errors and the transport's failures reach the session's errors by relays of their own:
            # each is let through before the next is said, so the session says them in this order.
            await turns()


@final
class Scripted(SessionFactory):
    """Sessions over a scripted transport of their own, each saying `opening` as it is built, before it is handed over.

    It reads nothing a session says: whatever is said of a session here, the
    registry said. The gateway is never asked who a token is, and each
    renewal gives `renewed`, recording the token it was handed.
    """

    def __init__(self, opening: Sequence[SessionError | TransportError]) -> None:
        self._opening: Final = opening
        self.renewed: Final = token(7200, 2)
        self.handed: Final[list[str | None]] = []
        """The token each renewal was handed, in order."""
        self.renewal_handed: Final = asyncio.Event()
        self.built: Final[list[Speaking]] = []

    @override
    @asynccontextmanager
    async def session(self, options: SessionFactoryOptions) -> AsyncGenerator[SemiontSession[FaultyTransport]]:
        transport = FaultyTransport(channels=BRIDGED_CHANNELS)
        client = create_test_client(transport=transport).client
        keeping = Broadcast[SessionError]()

        async def renew(holding: str | None) -> str | None:
            self.handed.append(holding)
            self.renewal_handed.set()
            return self.renewed

        session = SemiontSession(
            kb=KbTarget(id=options.kb.id, label=options.kb.label, endpoint=options.kb.endpoint),
            client=client,
            token=Variable[str | None](None),
            kept=kept_in(options.storage, options.kb.id),
            refresh=renew,
            on_auth_failed=options.signals.notify_session_ended,
            said=keeping.listen(),
        )
        # Entered client, session; left client, what keeps it, the wait until the session has said all it said, the
        # session, then the transport.
        async with AsyncExitStack() as ending:
            ending.push_async_callback(transport.close)
            async with AsyncExitStack() as closing:
                closing.push_async_callback(said_in_full, session)
                closing.callback(keeping.close)
                await closing.enter_async_context(client)
                await ending.enter_async_context(session)
                await session.ready()
                speaking = Speaking(session, keeping)
                self.built.append(speaking)
                await speaking.say(self._opening)
                yield session

    @override
    async def revoke(self, stored: StoredSession) -> None:
        pass


async def said_on(heard: Heard[SessionError], error: SessionError) -> None:
    """Until `heard` has given `error` itself."""
    while not any(each is error for each in await heard.so_far()):
        pass


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_registry_reads_what_its_session_says_as_the_table_states(case: Case) -> None:
    async def scenario() -> None:
        said = [utterance(each) for each in case.said]
        last = said[-1]
        factory = Scripted(said if case.while_ == "opening" else [])
        storage = holding_signed_in(MemoryStorage(), scripted_kb(), "https://issuer.test/token")
        browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=factory))
        # Heard from before the registry is held: everything it says is heard.
        heard = Heard(browser.errors())
        async with browser:
            await active_session(browser)
            signals = browser.active_signals.value
            assert signals is not None
            (speaking,) = factory.built
            if case.while_ == "active":
                await speaking.say(said)

            # What the last thing said does: once it is done, the registry has read everything said before it.
            if isinstance(last, SessionError):
                await soon(said_on(heard, last))
            elif last.code == "unauthorized":
                await soon(factory.renewal_handed.wait())
            elif last.code == "forbidden":
                refused = PermissionDenied(detail=last.message)
                await soon(reached(signals.permission_denied, lambda denied: denied == refused))
            else:
                raise AssertionError(f"the case ends with a failure of its transport that does nothing to wait for: {last.code}")

            assert [error.code for error in await heard.so_far()] == case.registry_errors
            match case.renewed_with:
                case "held":
                    await soon(factory.renewal_handed.wait())
                    assert factory.handed[0] == speaking.held_as_refused[0]
                case None:
                    assert factory.handed == []
            stated = None if case.permission_denied is None else PermissionDenied(detail=case.permission_denied)
            assert signals.permission_denied.value == stated

    run(scenario())


# ── closing ─────────────────────────────────────────────────────────────


def answering_entity_types(gateway: GatewayServer) -> None:
    """Have the gateway answer a read of the entity types, which the client keeps."""

    def answer(emit: JsonObject) -> None:
        if emit["channel"] == "browse:entity-types-requested":
            said: JsonObject = {"response": {"entityTypes": ["Person", "Place"]}}
            gateway.send(None, {"channel": "browse:entity-types-result", "payload": said, "correlationId": emit["correlationId"]})

    gateway.on_emit = answer


def registered(gateway: GatewayServer) -> KnowledgeBase:
    endpoint = gateway.target(KB).endpoint
    assert isinstance(endpoint, HttpEndpoint)
    return KnowledgeBase(id=KB, label="KB A", did="did:web:example.org:kb-a", endpoint=endpoint)


async def every_code(errors: Events[SessionError]) -> list[SemiontSessionErrorCode]:
    """The code of everything `errors` gives, until it ends."""
    return [error.code async for error in errors]


@pytest.mark.parametrize("case", TABLE.closing, ids=lambda case: case.why)
def test_a_registrys_close_reads_its_sessions_errors_to_their_end_as_the_table_states(case: Closing) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            answering_entity_types(gateway)
            # Every write of what the client keeps of the entity types is refused; the registry's own writes are taken.
            refusing = Refusing(cache_key(KB, ALICE_KEY, "entityTypes"), times=None)
            storage = holding_signed_in(refusing, registered(gateway), f"{gateway.origin}{TOKEN}")
            browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=HttpSessionFactory()))
            before = browser.errors()
            async with browser:
                session = await active_session(browser)
                # Ready once the gateway has named the person: what the client holds is kept for her from then on.
                await soon(session.ready())
                client = session.client
                if case.owed:
                    await soon(client.browse.entity_types().fresh())
                    # The entity types stop changing, and the save of them is refused: it is still owed.
                    await pass_time(0.2, step=0.01)
                    assert (await soon(anext(before))).code == "session.save-refused"
                assert client.persistence_settled is not case.owed
                from_close = browser.errors()
            assert await soon(every_code(from_close)) == case.registry_errors

    run(scenario())
