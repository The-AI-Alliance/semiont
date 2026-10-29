"""The liveness axioms, executable.

The state-unit axioms (`semiont.testing.axioms`) make a unit's wrongness
detectable; these make silence detectable: under any behaviour of the wire,
something is eventually delivered.

- **L1** every output says something, a value or a failure, within the bound.
  Pending forever is the violation.
- **L2** every awaited path settles within the bound; a request is sent again
  no more often than its retry budget allows; and one whose last attempt was
  faulted is either sent again or surfaced, never swallowed.
- **L3** every event written to a live connection is delivered exactly once,
  wherever a client-initiated transition (a handoff, a reopening, a change of
  scope) lands relative to it: a connection is retired by drain, never by
  abort.

`assert_liveness_axioms` runs L1 and L2 against a composition over a
`FaultyTransport`, under generated fault schedules. `assert_exactly_once_delivery`
runs L3 against generated interleavings of writes and transitions, on anything
shaped like a connection: a model of one, or a real transport over real
sockets. Each raises `AssertionError` naming the axiom broken, how, and under
what.

A composition and a subject are each built by an asynchronous context manager:
built on the way in, ended on the way out, as the client, the transport and the
session they are built of are held. Each case runs on an event loop of its own
whose clock is the real one, so a subject may do real I/O. A case of L1 and L2
is over when every output has said something and every path has settled, or
when its bound has passed, whichever is first: a composition is given small
timeouts.

The cases are drawn by Hypothesis, which is installed with the extra
`semiont[axioms]` and imported when a harness runs or a strategy is asked for:
every module of the package, this one among them, imports without it. Call a
harness from a test that is not itself running an event loop.
"""

import asyncio
from abc import ABC, abstractmethod
from collections import Counter
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, final

from semiont.testing.transport import (
    Delay,
    Deliver,
    DropReply,
    DuplicateReply,
    FaultAction,
    FaultyTransport,
    MakeResponse,
    RejectEmit,
    RequestLogEntry,
    refuse_unscripted_operation,
)

if TYPE_CHECKING:
    from hypothesis.strategies import SearchStrategy

__all__ = [
    "DeliveryOp",
    "DeliverySubject",
    "LivenessScenario",
    "LivenessSpec",
    "assert_exactly_once_delivery",
    "assert_liveness_axioms",
    "delivery_ops",
    "fault_actions",
    "fault_schedules",
]

_SLACK: Final = 4
"""How many times its reckoned bound a case is given: the room a scheduler's jitter takes."""

_LONGEST: Final = 12
"""The most steps of a drawn interleaving, when no interleavings are given."""


def _held[T](values: "SearchStrategy[T]", cases: int, case: Callable[[T], Coroutine[object, object, str | None]]) -> None:
    """Run `case` on each of `cases` values drawn, each on a loop of its own, and raise the violation one gives as an `AssertionError`."""
    from hypothesis import given, settings

    @settings(max_examples=cases, database=None, deadline=None, derandomize=True)
    @given(values)
    def holds(value: T) -> None:
        violation = asyncio.run(case(value))
        if violation is not None:
            raise AssertionError(violation)

    holds()


# ── L1, L2 ──────────────────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class LivenessScenario:
    """What one fresh run of a composition exposes to the axioms."""

    outputs: Sequence[Awaitable[object]]
    """One per output: it completes when the output has said something, a value or a failure (L1).

    A live query's first state, `Pending`, is nothing said: an output of one
    completes on the first state that is not.
    """
    settlements: Sequence[Awaitable[object]]
    """One per awaited path: it completes when the path has settled, by returning or by raising (L2)."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class LivenessSpec:
    """A composition, and the schedules it is run under."""

    setup: Callable[[FaultyTransport], AbstractAsyncContextManager[LivenessScenario]]
    """Build a fresh composition over the transport it is given, and give what it exposes.

    Called once per case, inside the case's loop. What it opened it ends on
    the way out, and the transport is closed after.
    """
    timeout_ms: int
    """The time the composition gives a bus request.

    The bound is derived from it: the timeout times one more than the retry
    budget, and the schedule's delays, all of it four times over.
    """
    retry_budget: int
    """How often a logical request may be sent again."""
    cases: int
    """How many schedules it is run under."""
    schedules: "SearchStrategy[Sequence[FaultAction]] | None" = None
    """The schedules drawn; with none, `fault_schedules()`'s."""
    make_response: MakeResponse = refuse_unscripted_operation
    """What the gateway answers a request nothing queued an answer for, as `FaultyTransport`'s `make_response` does."""


def fault_actions() -> "SearchStrategy[FaultAction]":
    """A wire behaviour, each as likely as the others. A delay is of 5 ms at most."""
    from hypothesis import strategies as st

    return st.one_of(
        st.just(Deliver()),
        st.just(DropReply()),
        st.integers(min_value=0, max_value=5).map(Delay),
        st.just(DuplicateReply()),
        st.just(RejectEmit()),
    )


def fault_schedules() -> "SearchStrategy[list[FaultAction]]":
    """A fault schedule of one to eight behaviours."""
    from hypothesis import strategies as st

    return st.lists(fault_actions(), min_size=1, max_size=8)


def _described(schedule: Sequence[FaultAction]) -> str:
    """A schedule as a violation names it."""
    return ",".join(f"delay({action.ms})" if isinstance(action, Delay) else action.kind for action in schedule)


async def _watched(scenario: LivenessScenario, bound_ms: int) -> tuple[list[bool], list[bool]]:
    """Wait until every output has said something and every path has settled, or the bound has passed.

    Gives which outputs said something, and which paths settled.
    """
    outputs = [asyncio.ensure_future(output) for output in scenario.outputs]
    settlements = [asyncio.ensure_future(settlement) for settlement in scenario.settlements]
    watched = [*outputs, *settlements]
    if watched:
        await asyncio.wait(watched, timeout=bound_ms / 1000)
    notified = [output.done() for output in outputs]
    settled = [settlement.done() for settlement in settlements]
    # What is still waiting is stopped before the composition is ended. Either way is settled: what one raised is no axiom's business.
    for task in watched:
        task.cancel()
    await asyncio.gather(*watched, return_exceptions=True)
    return notified, settled


def _liveness_violation(
    retry_budget: int,
    bound_ms: int,
    schedule: Sequence[FaultAction],
    notified: list[bool],
    settled: list[bool],
    log: Sequence[RequestLogEntry],
) -> str | None:
    """What a case broke, or nothing."""
    under = f"under schedule ⟨{_described(schedule)}⟩"
    # L2 first: where it applies it names the mechanism. L1 is the broader net, and would shadow it.
    if False in settled:
        return f"L2: settlement #{settled.index(False)} did not settle within {bound_ms}ms {under}"
    sent = Counter[str]()
    last_faulted: dict[str, bool] = {}
    for entry in log:
        sent[entry.retry_key] += 1
        last_faulted[entry.retry_key] = isinstance(entry.action, DropReply | RejectEmit)
    silent = True not in notified
    for key, times in sent.items():
        if times > 1 + retry_budget:
            return f"L2: request ⟨{key}⟩ was sent {times} times, past the retry budget (1 + {retry_budget}) {under}"
        if last_faulted[key] and times <= retry_budget and len(notified) > 0 and silent:
            return f"L2: faulted request ⟨{key}⟩ was neither sent again nor surfaced {under}: its failure was swallowed"
    if False in notified:
        return f"L1: output #{notified.index(False)} said nothing within {bound_ms}ms {under}: silently pending"
    return None


def assert_liveness_axioms(spec: LivenessSpec) -> None:
    """Run L1 and L2 across fault schedules. Raises `AssertionError` naming the first axiom broken, how, and under which schedule."""
    schedules = fault_schedules() if spec.schedules is None else spec.schedules

    async def case(schedule: Sequence[FaultAction]) -> str | None:
        delays = sum(action.ms for action in schedule if isinstance(action, Delay))
        bound_ms = (spec.timeout_ms * (1 + spec.retry_budget) + delays) * _SLACK
        transport = FaultyTransport(schedule, make_response=spec.make_response)
        try:
            async with spec.setup(transport) as scenario:
                notified, settled = await _watched(scenario, bound_ms)
                return _liveness_violation(spec.retry_budget, bound_ms, schedule, notified, settled, transport.request_log)
        finally:
            await transport.close()

    _held(schedules, spec.cases, case)


# ── L3 ──────────────────────────────────────────────────────────────────


class DeliverySubject(ABC):
    """Something shaped like a connection.

    It accepts writes to whichever connection is live, can be told to change
    connections, and delivers.
    """

    @abstractmethod
    def write(self, event_id: str) -> None:
        """Write the event with this id to the connection that is live now."""

    @abstractmethod
    async def transition(self) -> None:
        """Make a client-initiated transition: a handoff, a reopening, a change of scope."""

    @abstractmethod
    async def delivered(self) -> Sequence[str]:
        """Let whatever is in flight be delivered, then give the ids delivered, in order."""


type DeliveryOp = Literal["write", "transition"]
"""One step of an interleaving."""


def _writing(ops: list[DeliveryOp]) -> list[DeliveryOp]:
    """The interleaving, with a write at its end when it has none."""
    return ops if "write" in ops else [*ops, "write"]


def delivery_ops(longest: int) -> "SearchStrategy[list[DeliveryOp]]":
    """Interleavings of writes and transitions, of one to `longest` steps.

    Each has at least one write: a sequence that writes nothing checks nothing.
    """
    from hypothesis import strategies as st

    steps: tuple[DeliveryOp, ...] = ("write", "transition")
    return st.lists(st.sampled_from(steps), min_size=1, max_size=longest).map(_writing)


def _delivery_violation(ops: Sequence[DeliveryOp], written: Sequence[str], delivered: Sequence[str]) -> str | None:
    """The first event written that was not delivered exactly once, or nothing."""
    under = f"under ⟨{','.join(ops)}⟩"
    for event_id in written:
        times = delivered.count(event_id)
        if times == 0:
            return f"L3: event ⟨{event_id}⟩ was delivered 0 times {under}: lost across a transition"
        if times > 1:
            return f"L3: event ⟨{event_id}⟩ was delivered {times} times {under}"
    return None


def assert_exactly_once_delivery(
    setup: Callable[[], AbstractAsyncContextManager[DeliverySubject]],
    *,
    ops: "SearchStrategy[Sequence[DeliveryOp]] | None" = None,
    cases: int,
) -> None:
    """Run L3 across `cases` interleavings, drawn from `ops`; with none, `delivery_ops(12)`'s.

    `setup` builds a fresh subject for each, inside the case's loop, and ends
    it on the way out. Raises `AssertionError` naming the event lost or
    doubled, and the interleaving.
    """
    interleavings = delivery_ops(_LONGEST) if ops is None else ops

    async def case(steps: Sequence[DeliveryOp]) -> str | None:
        written: list[str] = []
        async with setup() as subject:
            # No settling between steps: the races that matter are a transition landing before a write has been delivered.
            for number, step in enumerate(steps):
                match step:
                    case "write":
                        event_id = f"e{number}"
                        subject.write(event_id)
                        written.append(event_id)
                    case "transition":
                        await subject.transition()
            return _delivery_violation(steps, written, await subject.delivered())

    _held(interleavings, cases, case)
