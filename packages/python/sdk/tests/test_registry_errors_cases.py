"""How a registry reads the errors of each session it activates (`protocol/specs/src/session/registry-errors-cases.json`).

`cases`: a registry over `Scripted`, whose session says what the case says,
while its factory builds it or once it is active, and reads none of it. Its
own errors are said by what keeps its client's (`said`), its transport's
failures by its transport, with the case's code and message, and its renewal
records each token it is handed, so a case fails if the registry renews
anything. `closing`: a registry over its HTTP factory, over a scripted
gateway, whose session's client keeps the entity types it read in a storage
that refuses every write of them, on a loop whose clock does not move: the
save the read leaves owed still waits out its debounce as the registry's close
begins, and the close is the first to make it.

Beside the table, over `Scripted`: what the registry's own errors keep for a
first reader who has not come, and drop as the registry closes.
"""

from collections.abc import AsyncGenerator, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Final, Literal, final, override

import pytest
from aio import Heard, run, run_still, soon
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
from semiont.session import SemiontSession
from semiont.session_signals import PermissionDenied
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import StoredSession, cache_key, person_key
from semiont.testing import FaultyTransport, create_test_client
from semiont.timing import ERRORS_KEPT_FOR_FIRST_READER_COUNT
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

    def say(self, said: Sequence[SessionError | TransportError]) -> None:
        """Say each of `said`, in order."""
        for each in said:
            if isinstance(each, SessionError):
                self._keeping.deliver(each)
            else:
                self.session.client.transport.fail(each)


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
        self.built: Final[list[Speaking]] = []

    @override
    @asynccontextmanager
    async def session(self, options: SessionFactoryOptions) -> AsyncGenerator[SemiontSession[FaultyTransport]]:
        transport = FaultyTransport(channels=BRIDGED_CHANNELS)
        client = create_test_client(transport=transport).client
        keeping = Broadcast[SessionError]()

        async def renew(holding: str | None) -> str | None:
            self.handed.append(holding)
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
        # Entered client, session; left client, what keeps it, the session, then the transport.
        async with AsyncExitStack() as ending:
            ending.push_async_callback(transport.close)
            async with AsyncExitStack() as closing:
                closing.callback(keeping.close)
                await closing.enter_async_context(client)
                await ending.enter_async_context(session)
                await session.ready()
                speaking = Speaking(session, keeping)
                self.built.append(speaking)
                speaking.say(self._opening)
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
                speaking.say(said)

            # What the last thing said does: once it is done, the registry has read everything said before it.
            if isinstance(last, SessionError):
                await soon(said_on(heard, last))
            elif last.code == "forbidden":
                refused = PermissionDenied(detail=last.message)
                await soon(reached(signals.permission_denied, lambda denied: denied == refused))
            else:
                raise AssertionError(f"the case ends with a failure of its transport that does nothing to wait for: {last.code}")

            assert [error.code for error in await heard.so_far()] == case.registry_errors
            assert factory.handed == []
            stated = None if case.permission_denied is None else PermissionDenied(detail=case.permission_denied)
            assert signals.permission_denied.value == stated

    run(scenario())


# ── what the registry's errors keep for a first reader ──────────────────


LAST_WORD: Final = TransportError("forbidden", "refused for lack of permission, said last")
"""Said after what a case has the session say: once the registry has said it through the signals, it has read everything before it."""


async def speaking_once_read(browser: SemiontBrowser, factory: Scripted, said: Sequence[SessionError]) -> None:
    """Have the active session say each of `said`, then `LAST_WORD`, and wait until the registry has read them all."""
    await active_session(browser)
    signals = browser.active_signals.value
    assert signals is not None
    (speaking,) = factory.built
    speaking.say([*said, LAST_WORD])
    heard_last = PermissionDenied(detail=LAST_WORD.message)
    await soon(reached(signals.permission_denied, lambda denied: denied == heard_last))


def test_the_first_reader_of_a_registrys_errors_is_given_the_latest_said_before_it_came_in_order_and_no_more() -> None:
    beyond = 3
    said = [
        SessionError("session.save-refused", f"write {serial} refused", kb_id=KB)
        for serial in range(ERRORS_KEPT_FOR_FIRST_READER_COUNT + beyond)
    ]

    async def scenario() -> None:
        factory = Scripted([])
        storage = holding_signed_in(MemoryStorage(), scripted_kb(), "https://issuer.test/token")
        async with SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=factory)) as browser:
            await speaking_once_read(browser, factory, said)
            errors = browser.errors()
            given = [(await soon(anext(errors))).message for _ in range(ERRORS_KEPT_FOR_FIRST_READER_COUNT)]
        assert given == [error.message for error in said[beyond:]]

    run(scenario())


def test_a_registry_drops_what_it_kept_for_a_first_reader_as_it_closes_so_a_reader_who_comes_after_hears_nothing() -> None:
    async def scenario() -> None:
        factory = Scripted([])
        storage = holding_signed_in(MemoryStorage(), scripted_kb(), "https://issuer.test/token")
        browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=factory))
        async with browser:
            await speaking_once_read(browser, factory, [SessionError("session.save-refused", "said before anyone read", kb_id=KB)])
        assert [error async for error in browser.errors()] == []

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
            async with browser:
                session = await active_session(browser)
                # Ready once the gateway has named the person: what the client holds is kept for her from then on.
                await soon(session.ready())
                client = session.client
                if case.owed:
                    # The entity types the client now holds owe a save, whose debounce the still clock never ends.
                    await soon(client.browse.entity_types().fresh())
                assert client.persistence_settled is not case.owed
                from_close = browser.errors()
            assert await soon(every_code(from_close)) == case.registry_errors

    # The loop's clock moves only when the test moves it, and this one never does: no debounce falls due.
    run_still(scenario())
