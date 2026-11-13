"""How a registry activates a knowledge base (`protocol/specs/src/session/registry-activation-cases.json`).

And what it says when its factory fails with something that is not one of the
session's own errors (`protocol/specs/src/session/registry-factory-failure-cases.json`).

Every row runs a registry over a storage in which each of its knowledge bases
is registered, signed in, with kb-a the active one, so the registry activates
kb-a as it is held. Its factory records each knowledge base it is asked for a
session of, in order, and then refuses as the row says, or builds the session
`HttpSessionFactory` builds, over the tests' gateway server, which names Alice
for every token.

Where a row's first session owes a save, a read of the entity types, on a loop
whose clock does not move, leaves its client owing it, still waiting out its
debounce, and the storage records its write in the list the factory records
its asks in: `switching` holds the order of the two to the rule. `closed`
begins an activation of kb-b by running its first step and no further: once
the registry's close has returned, or, while it is closing, from within the
write of that save, which a storage makes synchronously while the close waits
for it. An activation refused at the call is refused at that step.
"""

from collections.abc import AsyncGenerator, Callable, Coroutine
from contextlib import asynccontextmanager
from typing import Final, Literal, final, override

import pytest
from aio import Heard, run, run_still, soon, turns
from gateway_server import GatewayServer
from issuer import TOKEN, trusting
from pydantic import BaseModel, Field
from registry_runners import (
    ALICE_KEY,
    KB_A,
    UNREACHED_ISSUER,
    active_session,
    answering_entity_types,
    holding_signed_in,
    ready_owing,
    registered,
    unreached,
)
from spec import SPEC, read
from storages import Telling

from semiont.error_codes import SemiontSessionErrorCode, TransportErrorCode
from semiont.errors import BusRequestError, SemiontError, SessionError, TransportError
from semiont.http.session import HttpSessionFactory
from semiont.http.transport import HttpTransport
from semiont.registry import SemiontBrowser, SemiontBrowserConfig, SessionFactory, SessionFactoryOptions
from semiont.session import SemiontSession
from semiont.storage import MemoryStorage
from semiont.stored import ACTIVE_KEY, KEPT_QUERIES, StoredSession, cache_key, last_event_id_key
from semiont.types import KnowledgeBase
from semiont.watched import reached


class Own(BaseModel, frozen=True, extra="forbid"):
    """One of the session's own errors, by its code, with its message."""

    own: SemiontSessionErrorCode
    message: str


class Said(BaseModel, frozen=True, extra="forbid"):
    """What a registry says on its errors, by its code and its message."""

    code: SemiontSessionErrorCode
    message: str


class Refused(BaseModel, frozen=True, extra="forbid"):
    why: str
    refusal: Own
    registry_errors: list[Said] = Field(alias="registryErrors")


class Closed(BaseModel, frozen=True, extra="forbid"):
    why: str
    while_: Literal["closed", "closing"] = Field(alias="while")


class Switching(BaseModel, frozen=True, extra="forbid"):
    why: str
    storage: Literal["writes", "refuses"]
    next: Literal["built"] | Own
    registry_errors: list[SemiontSessionErrorCode] = Field(alias="registryErrors")
    active: bool


class Activation(BaseModel, frozen=True):
    refused: list[Refused] = Field(min_length=1)
    closed: list[Closed] = Field(min_length=1)
    switching: list[Switching] = Field(min_length=1)


class Failure(BaseModel, frozen=True, extra="forbid"):
    """A failure of the factory's transport, by its code, with its message."""

    transport: TransportErrorCode
    message: str


class FactoryFailure(BaseModel, frozen=True, extra="forbid"):
    why: str
    failure: Failure
    registry_errors: list[Said] = Field(alias="registryErrors")


class FactoryFailures(BaseModel, frozen=True):
    cases: list[FactoryFailure] = Field(min_length=1)


ACTIVATION_STATED: Final = read(SPEC / "session/registry-activation-cases.json")
ACTIVATION: Final = Activation.model_validate(ACTIVATION_STATED)
FACTORY_FAILURE_STATED: Final = read(SPEC / "session/registry-factory-failure-cases.json")
FACTORY_FAILURES: Final = FactoryFailures.model_validate(FACTORY_FAILURE_STATED)

KB_B: Final = "kb-b"
"""The knowledge base activated next, at the same gateway."""

OWED_SAVE: Final = cache_key(KB_A, ALICE_KEY, "entityTypes")
"""Where the save the first session's client owes is written: what it keeps of the entity types it read."""

FIRST_CLIENTS_KEYS: Final = frozenset({*(cache_key(KB_A, ALICE_KEY, query) for query in KEPT_QUERIES), last_event_id_key(KB_A, ALICE_KEY)})
"""Every key the first session's client writes under: its kept queries' documents and its stream's places."""

WROTE_THE_OWED_SAVE: Final = "wrote the owed save"


def asked_for(kb_id: str) -> str:
    return f"asked for {kb_id}"


def test_every_section_of_each_table_is_run_here() -> None:
    assert {section for section, rows in ACTIVATION_STATED.items() if isinstance(rows, list)} == {"refused", "closed", "switching"}
    assert {section for section, rows in FACTORY_FAILURE_STATED.items() if isinstance(rows, list)} == {"cases"}


@final
class Recording(SessionFactory):
    """A factory that records in `steps` each knowledge base it is asked for a session of.

    It then refuses with what `refusal` gives for that knowledge base, or,
    given nothing, builds the session `HttpSessionFactory` builds.
    """

    def __init__(self, steps: list[str], refusal: Callable[[str], SemiontError | None]) -> None:
        self._steps: Final = steps
        self._refusal: Final = refusal
        self._building: Final = HttpSessionFactory()

    @override
    @asynccontextmanager
    async def session(self, options: SessionFactoryOptions) -> AsyncGenerator[SemiontSession[HttpTransport]]:
        self._steps.append(asked_for(options.kb.id))
        refusal = self._refusal(options.kb.id)
        if refusal is not None:
            raise refusal
        async with self._building.session(options) as session:
            yield session

    @override
    async def revoke(self, stored: StoredSession) -> None:
        raise AssertionError("no row signs out")


def at_gateway(gateway: GatewayServer) -> list[KnowledgeBase]:
    """kb-a and kb-b, each registered at `gateway`."""
    return [registered(gateway, KB_A, "KB A"), registered(gateway, KB_B, "KB B")]


# ── refused, and a factory's other failures ─────────────────────────────


async def until_asked(steps: list[str]) -> None:
    """Until the factory has been asked for a session, letting what is ready run meanwhile."""
    while not steps:
        await turns()


async def refused_with(refusal: SemiontError) -> list[tuple[SemiontSessionErrorCode, str]]:
    """What a registry says on its errors once its activation of kb-a, over a factory that refuses with `refusal`, has returned.

    Each is given by its code and its message. Then no session is active, its
    factory was asked for one session, and the storage's active key names kb-a.
    """
    steps: list[str] = []
    storage = holding_signed_in(MemoryStorage(), [unreached(KB_A, "KB A")], UNREACHED_ISSUER)
    browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=Recording(steps, lambda kb_id: refusal)))
    # Heard from before the registry is held: everything it says is heard.
    heard = Heard(browser.errors())
    async with browser:
        # Held, it activates kb-a: under way once its factory has been asked, and returned once it is not activating.
        await soon(until_asked(steps))
        await soon(reached(browser.session_activating, lambda activating: not activating))
        said: list[tuple[SemiontSessionErrorCode, str]] = [(error.code, error.message) for error in await heard.so_far()]
        assert steps == [asked_for(KB_A)]
        assert browser.active_session.value is None
        assert storage.get(ACTIVE_KEY) == KB_A
    return said


@pytest.mark.parametrize("row", ACTIVATION.refused, ids=lambda row: row.why)
def test_a_factorys_refusal_that_is_one_of_the_sessions_own_errors_is_said_as_it_is_as_the_table_states(row: Refused) -> None:
    said = run(refused_with(SessionError(row.refusal.own, row.refusal.message, kb_id=KB_A)))
    assert said == [(each.code, each.message) for each in row.registry_errors]


@pytest.mark.parametrize("row", FACTORY_FAILURES.cases, ids=lambda row: row.why)
def test_a_factory_that_fails_otherwise_is_said_as_one_that_could_not_build_the_session_as_the_table_states(row: FactoryFailure) -> None:
    said = run(refused_with(TransportError(row.failure.transport, row.failure.message)))
    assert said == [(each.code, each.message) for each in row.registry_errors]


# ── closed ──────────────────────────────────────────────────────────────


type AtTheCall = SemiontError | Literal["returned", "waited"]
"""What an activation came to at its first step: what it was refused with, that it returned, or that it waited for something."""


def at_the_call(activation: Coroutine[object, object, None]) -> AtTheCall:
    """Run `activation`'s first step here, and no further: what it came to then."""
    try:
        activation.send(None)
    except StopIteration:
        return "returned"
    except SemiontError as refusal:
        return refusal
    activation.close()
    return "waited"


@pytest.mark.parametrize("row", ACTIVATION.closed, ids=lambda row: row.why)
def test_an_activation_once_the_registrys_close_has_begun_is_refused_at_the_call_as_the_table_states(row: Closed) -> None:
    closing = row.while_ == "closing"

    async def scenario() -> None:
        steps: list[str] = []
        made: list[SemiontBrowser] = []
        refusals: list[AtTheCall] = []

        # The owed save is written, and nothing refused. While the registry is
        # closing, its activation is begun from within that write: whatever it
        # comes to is recorded, since the client says what its write raises.
        def write(key: str) -> bool:
            if key == OWED_SAVE:
                steps.append(WROTE_THE_OWED_SAVE)
                if closing:
                    refusals.extend(at_the_call(registry.set_active_kb(KB_B)) for registry in made)
            return False

        async with GatewayServer() as gateway:
            trusting(gateway)
            answering_entity_types(gateway)
            storage = holding_signed_in(Telling(write), at_gateway(gateway), f"{gateway.origin}{TOKEN}")
            browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=Recording(steps, lambda kb_id: None)))
            made.append(browser)
            heard = Heard(browser.errors())
            async with browser:
                await ready_owing(await active_session(browser), a_save=closing)
            if not closing:
                refusals.append(at_the_call(browser.set_active_kb(KB_B)))

            (refusal,) = refusals
            assert isinstance(refusal, BusRequestError), refusal
            assert refusal.code == "bus.closed"
            asked = [asked_for(KB_A), WROTE_THE_OWED_SAVE] if closing else [asked_for(KB_A)]
            assert steps == asked
            assert await heard.ended() == []
            assert storage.get(ACTIVE_KEY) == KB_A

            # A second close does nothing.
            await browser.close()
            assert steps == asked

    # The loop's clock moves only when the test moves it, and this one never does: no debounce falls due.
    run_still(scenario())


# ── switching ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("row", ACTIVATION.switching, ids=lambda row: row.why)
def test_a_switch_ends_the_session_that_was_active_before_its_factory_is_asked_for_the_next_as_the_table_states(row: Switching) -> None:
    next_refused = row.next if isinstance(row.next, Own) else None

    async def scenario() -> None:
        steps: list[str] = []

        # The row's storage writes, or refuses every write the first session's client makes.
        def write(key: str) -> bool:
            if key == OWED_SAVE:
                steps.append(WROTE_THE_OWED_SAVE)
            return row.storage == "refuses" and key in FIRST_CLIENTS_KEYS

        def refusal(kb_id: str) -> SessionError | None:
            if kb_id != KB_B or next_refused is None:
                return None
            return SessionError(next_refused.own, next_refused.message, kb_id=kb_id)

        async with GatewayServer() as gateway:
            trusting(gateway)
            answering_entity_types(gateway)
            storage = holding_signed_in(Telling(write), at_gateway(gateway), f"{gateway.origin}{TOKEN}")
            browser = SemiontBrowser(SemiontBrowserConfig(storage=storage, session_factory=Recording(steps, refusal)))
            heard = Heard(browser.errors())
            async with browser:
                await ready_owing(await active_session(browser), a_save=True)
                await soon(browser.set_active_kb(KB_B))

                # The first session ended, its owed save written once, by its closing flush, before the next was asked for.
                assert steps == [asked_for(KB_A), WROTE_THE_OWED_SAVE, asked_for(KB_B)]
                assert [error.code for error in await heard.so_far()] == row.registry_errors
                assert (browser.active_session.value is not None) is row.active

    # The loop's clock moves only when the test moves it, and this one never does: no debounce falls due.
    run_still(scenario())
