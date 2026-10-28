"""The two things a gather waits on: what `weave:applied` and `smelt:settled` have signalled of each resource, each as a fold.

A gather reads stores that are written after the record
(`docs/protocol/LIBRARIAN.md` § The two waits). The Weaver signals how far it
has applied a resource's events, and the Smelter what it decided of a
resource's bytes. A fold keeps the last of each for every resource, and is
something to wait on: a wait is answered at once where the fold already keeps
what it asks for, when the signal comes where it does not, and with the wait's
own failure where the bound runs out first.

The service tells a fold of each signal (`noted`). A fold knows no bus.

What a fold keeps is in the process's memory and is gone when the process
stops. Nothing is lost by that: a wait is only ever for a signal that is still
to come. An entry more than five minutes old is forgotten, lazily and at most
once a minute, as a signal is noted, by a clock the fold is handed. Every
signal of a resource makes its entry new, one that states nothing new among
them. A fold that hears no signal forgets nothing: it holds no more than it
did, and what it holds still answers a wait. A wait for a forgotten entry
waits out its bound.

A stopped fold lets go of every wait (§ Stopping): a wait for the graph ends
as if the signal had come, and a wait for the index ends with no decision.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, final, override

from semiont.identifiers import ResourceId
from semiont.types import SmeltSettledOutcome

from semiont_librarian.reads import Settled, SmeltWaits, SmeltWaitTimedOut, WeaveWaits, WeaveWaitTimedOut

__all__ = ["SmeltProgress", "WeaveProgress"]

_KEPT_SECONDS: Final = 5 * 60.0
"""How old an entry is when it may be forgotten."""

_SWEEP_SECONDS: Final = 60.0
"""The least time between two sweeps for old entries."""


@final
class _Kept[T]:
    """What a fold keeps of each resource, and when each was kept, by the clock the fold is handed.

    The clock answers seconds that only go forward.
    """

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock: Final = clock
        self._held: Final[dict[ResourceId, tuple[T, float]]] = {}
        self._swept = clock()

    def of(self, resource_id: ResourceId) -> T | None:
        """What is kept of a resource, or `None` where nothing is."""
        held = self._held.get(resource_id)
        return None if held is None else held[0]

    def sweep(self) -> float:
        """The moment it is now, after the old entries are forgotten where a minute has passed since they last were."""
        now = self._clock()
        if now - self._swept >= _SWEEP_SECONDS:
            self._swept = now
            for old in [resource_id for resource_id, (_, at) in self._held.items() if now - at >= _KEPT_SECONDS]:
                del self._held[old]
        return now

    def keep(self, resource_id: ResourceId, value: T, at: float) -> None:
        self._held[resource_id] = (value, at)

    def clear(self) -> None:
        self._held.clear()


@final
class WeaveProgress(WeaveWaits):
    """The highest sequence number `weave:applied` has signalled of each resource, and the waits for one it has not reached."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self._applied: Final = _Kept[int](clock)
        self._waiting: Final[dict[asyncio.Future[None], tuple[ResourceId, int]]] = {}
        self._closed = False

    def noted(self, resource_id: ResourceId, sequence: int) -> None:
        """Keep a signal, and wake every wait for this resource at or below its sequence number.

        A signal no higher than what is kept wakes nothing and keeps what was
        kept, made new: a sequence number kept only ever rises. A stopped
        fold keeps nothing.
        """
        if self._closed:
            return
        now = self._applied.sweep()
        held = self._applied.of(resource_id)
        if held is not None and held >= sequence:
            self._applied.keep(resource_id, held, now)
            return
        self._applied.keep(resource_id, sequence, now)
        for woken, (resource, wanted) in [*self._waiting.items()]:
            if resource == resource_id and sequence >= wanted:
                del self._waiting[woken]
                if not woken.done():
                    woken.set_result(None)

    @override
    async def when_applied(self, resource_id: ResourceId, sequence: int, within: float) -> None:
        if self._closed:
            return
        held = self._applied.of(resource_id)
        if held is not None and held >= sequence:
            return
        woken: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiting[woken] = (resource_id, sequence)
        try:
            await asyncio.wait_for(woken, within)
        except TimeoutError:
            # A signal that came in the turn the bound ran out in is a signal that came.
            if woken.done() and not woken.cancelled():
                return
            raise WeaveWaitTimedOut(f"weave:applied did not reach {sequence} for {resource_id} within {within} seconds") from None
        finally:
            self._waiting.pop(woken, None)

    async def aclose(self) -> None:
        """Stop: every wait ends as if its signal had come, and a wait made from now on returns at once. What is kept is forgotten."""
        self._closed = True
        for woken in [*self._waiting]:
            if not woken.done():
                woken.set_result(None)
        self._waiting.clear()
        self._applied.clear()


@final
@dataclass(frozen=True, slots=True)
class _Decision:
    """What the Smelter decided of a resource's bytes: the checksum of the bytes it decided of, and the decision."""

    checksum: str
    outcome: SmeltSettledOutcome


@final
class SmeltProgress(SmeltWaits):
    """The last decision `smelt:settled` has signalled of each resource, and the waits for a decision of bytes it has not signalled.

    One decision is kept for a resource: the latest. A wait is for the
    decision of exactly the bytes a checksum is of, so a wait for another
    checksum than the one kept waits.
    """

    def __init__(self, clock: Callable[[], float]) -> None:
        self._settled: Final = _Kept[_Decision](clock)
        self._waiting: Final[dict[asyncio.Future[Settled], tuple[ResourceId, str]]] = {}
        self._closed = False

    def noted(self, resource_id: ResourceId, checksum: str, outcome: SmeltSettledOutcome) -> None:
        """Keep a decision in place of any kept for the resource, and wake every wait for this resource at this checksum.

        A stopped fold keeps nothing.
        """
        if self._closed:
            return
        now = self._settled.sweep()
        self._settled.keep(resource_id, _Decision(checksum, outcome), now)
        for decided, (resource, wanted) in [*self._waiting.items()]:
            if resource == resource_id and wanted == checksum:
                del self._waiting[decided]
                if not decided.done():
                    decided.set_result(outcome)

    @override
    async def when_settled(self, resource_id: ResourceId, checksum: str, within: float) -> Settled:
        if self._closed:
            return "inert"
        held = self._settled.of(resource_id)
        if held is not None and held.checksum == checksum:
            return held.outcome
        decided: asyncio.Future[Settled] = asyncio.get_running_loop().create_future()
        self._waiting[decided] = (resource_id, checksum)
        try:
            return await asyncio.wait_for(decided, within)
        except TimeoutError:
            # A decision that came in the turn the bound ran out in is a decision that came.
            if decided.done() and not decided.cancelled():
                return decided.result()
            raise SmeltWaitTimedOut(f"smelt:settled did not state {checksum} for {resource_id} within {within} seconds") from None
        finally:
            self._waiting.pop(decided, None)

    async def aclose(self) -> None:
        """Stop: every wait ends with no decision (`inert`), and so does a wait made from now on. What is kept is forgotten."""
        self._closed = True
        for decided in [*self._waiting]:
            if not decided.done():
                decided.set_result("inert")
        self._waiting.clear()
        self._settled.clear()
