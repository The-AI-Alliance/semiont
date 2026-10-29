"""The liveness harness against compositions that keep its axioms and ones built to break each: an axiom nothing can fail holds nothing.

A composition here is a request, or a wait for a reply, over the transport the
harness gives. A connection here is a model of a client's connections, each
retired as the model says; the real transport is held to L3 in
`test_http_transport.py`, and a real client to L1 and L2 in
`test_live_queries.py`.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Final, Literal, final, override

import pytest
from hypothesis import strategies as st
from spec import JsonObject

from semiont.bus import request
from semiont.errors import SemiontError
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.testing import Deliver, DropReply, FaultAction, FaultyTransport, RejectEmit
from semiont.testing.liveness import (
    DeliveryOp,
    DeliverySubject,
    LivenessScenario,
    LivenessSpec,
    assert_exactly_once_delivery,
    assert_liveness_axioms,
)

TIMEOUT_MS: Final = 50
READ: Final = BROWSE_RESOURCE_REQUESTED
ASKING: Final[JsonObject] = {"resourceId": "res-1"}

type Composition = Callable[[FaultyTransport], AbstractAsyncContextManager[LivenessScenario]]


def liveness_spec(setup: Composition, schedule: Sequence[FaultAction] | None = None) -> LivenessSpec:
    """The composition, under `schedule` alone or, with none, under the schedules the harness draws.

    Every request is answered with a reply that carries no response.
    """
    return LivenessSpec(
        setup=setup,
        timeout_ms=TIMEOUT_MS,
        retry_budget=1,
        cases=25,
        schedules=None if schedule is None else st.just(schedule),
        make_response=lambda operation, payload: None,
    )


def test_a_request_settles_under_every_schedule() -> None:
    @asynccontextmanager
    async def asking(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        yield LivenessScenario(outputs=(), settlements=(request(transport, READ, ASKING, timeout_ms=TIMEOUT_MS),))

    assert_liveness_axioms(liveness_spec(asking))


def test_a_wait_with_no_deadline_breaks_l2() -> None:
    @asynccontextmanager
    async def waiting(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        async def forever() -> None:
            with transport.track_reply("cid", (READ.result.name, READ.failure.name)) as pending:
                await transport.emit(READ.request.name, ASKING, correlation_id="cid")
                await pending.frame()

        yield LivenessScenario(outputs=(), settlements=(forever(),))

    with pytest.raises(AssertionError, match="L2: settlement #0 did not settle"):
        assert_liveness_axioms(liveness_spec(waiting, [DropReply()]))


def test_a_request_sent_again_past_its_budget_breaks_l2() -> None:
    @asynccontextmanager
    async def insisting(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        async def three_times() -> None:
            for _ in range(3):
                try:
                    await request(transport, READ, ASKING, timeout_ms=TIMEOUT_MS)
                except SemiontError:
                    continue
                return

        yield LivenessScenario(outputs=(), settlements=(three_times(),))

    with pytest.raises(AssertionError, match="past the retry budget"):
        assert_liveness_axioms(liveness_spec(insisting, [RejectEmit()]))


def test_a_swallowed_failure_breaks_l2() -> None:
    @asynccontextmanager
    async def swallowing(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        async def told_only_of_success() -> None:
            try:
                await request(transport, READ, ASKING, timeout_ms=TIMEOUT_MS)
            except SemiontError:
                # The failure goes nowhere: the output is told only of success.
                await asyncio.Event().wait()

        yield LivenessScenario(outputs=(told_only_of_success(),), settlements=())

    with pytest.raises(AssertionError, match="its failure was swallowed"):
        assert_liveness_axioms(liveness_spec(swallowing, [RejectEmit()]))


def test_an_output_that_says_nothing_breaks_l1() -> None:
    @asynccontextmanager
    async def silent(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        yield LivenessScenario(outputs=(asyncio.Event().wait(),), settlements=())

    with pytest.raises(AssertionError, match="L1: output #0 said nothing"):
        assert_liveness_axioms(liveness_spec(silent, [Deliver()]))


type Retire = Literal["drain", "abort", "drain and replay"]
"""How a connection is retired when the client moves to another.

By drain, what it had received and not delivered is delivered first. By abort,
it is dropped with whatever it had received. By drain and replay, it is
drained, and the next connection replays the same events.
"""


@final
class Connections(DeliverySubject):
    """A client's connections, each retired as `retire` says."""

    def __init__(self, retire: Retire) -> None:
        self._retire: Final = retire
        self._received: Final[list[str]] = []
        self._delivered: Final[list[str]] = []

    @override
    def write(self, event_id: str) -> None:
        self._received.append(event_id)

    @override
    async def transition(self) -> None:
        match self._retire:
            case "drain":
                self._delivered.extend(self._received)
                self._received.clear()
            case "abort":
                self._received.clear()
            case "drain and replay":
                self._delivered.extend(self._received)

    @override
    async def delivered(self) -> Sequence[str]:
        self._delivered.extend(self._received)
        self._received.clear()
        return list(self._delivered)


WRITE_TRANSITION_WRITE: Final[list[DeliveryOp]] = ["write", "transition", "write"]


def delivery(retire: Retire) -> None:
    @asynccontextmanager
    async def connections() -> AsyncGenerator[DeliverySubject]:
        yield Connections(retire)

    assert_exactly_once_delivery(connections, ops=st.just(WRITE_TRANSITION_WRITE), cases=10)


def test_a_connection_retired_by_drain_delivers_once_under_every_interleaving() -> None:
    delivery("drain")

    @asynccontextmanager
    async def connections() -> AsyncGenerator[DeliverySubject]:
        yield Connections("drain")

    assert_exactly_once_delivery(connections, cases=50)


def test_a_connection_retired_by_abort_breaks_l3() -> None:
    with pytest.raises(AssertionError, match="delivered 0 times"):
        delivery("abort")


def test_an_event_delivered_by_both_connections_breaks_l3() -> None:
    with pytest.raises(AssertionError, match="delivered 2 times"):
        delivery("drain and replay")
