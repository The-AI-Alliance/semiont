"""The state-unit axioms, executable.

`assert_state_unit_axioms(subject)` runs each axiom against fresh units the
subject builds, and raises `AssertionError`, naming the axiom, on the first one
a unit breaks. One call per state unit, from that unit's tests; a program's own
units are held to them the same way.

- **A5** `dispose` is idempotent and total: any number of calls, none raises,
  and none disposes what the unit was given.
- **A5b** the unit is inert after `dispose`: its methods do nothing, and a
  surface taken afterwards gives at most the value it held, and has ended.
- **A6** every reader of a surface taken before `dispose` sees it end.
- **A7-passed** disposing the unit does not dispose a dependency it was given:
  a `DisposeProbe` standing in for one, or the client itself.
- **A7-owned** disposing the unit ends the surfaces of the children it made.
- **X1** no surface is a writer: a unit hands out a read-only view of each
  state, never the `Variable` that holds it.
- **X3** instances are isolated: driving one never moves another's surfaces.

Each case runs on an event loop of its own, and the subject builds the unit
inside it, as a unit is built inside a running loop. Before the harness looks,
the loop runs a bounded number of turns, so a unit that acts in a task of its
own has acted on what the harness did. No axiom waits on a timer.

The cases are drawn by Hypothesis, which is this module's alone:
`semiont.testing` imports nothing of it, and it is installed with the extra
`semiont[axioms]`. Call the harness from a test that is not itself running an
event loop.
"""

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterable, AsyncIterator, Callable, Coroutine, Sequence
from dataclasses import dataclass
from typing import Final, Protocol, final, override

from hypothesis import given, settings
from hypothesis import strategies as st

from semiont.client import SemiontClient
from semiont.state_unit import StateUnit
from semiont.transport import Transport
from semiont.watched import Variable

__all__ = ["AxiomSubject", "DisposeProbe", "Fresh", "Given", "assert_state_unit_axioms"]

_CASES: Final = 30
"""How many cases each property is tried on."""

_TURNS: Final = 20
"""How many turns of the loop the harness lets pass before it looks."""


class Given(Protocol):
    """A dependency a unit was given, as the axioms watch it."""

    def disposed(self) -> bool:
        """Whether anything has disposed it."""
        ...


@final
class DisposeProbe(StateUnit, Given):
    """A stand-in for a dependency a unit is given.

    Pass one to the unit and to `Fresh.given`, and the axioms check the unit never disposed it.
    """

    def __init__(self) -> None:
        self.disposals = 0
        """How many times it was disposed."""

    @override
    def dispose(self) -> None:
        self.disposals += 1

    @override
    def disposed(self) -> bool:
        return self.disposals > 0


@final
class _TheClient(Given):
    """A client is disposed when it is closed, and closing it ends its own bus."""

    def __init__(self, client: SemiontClient[Transport]) -> None:
        self._client: Final = client

    @override
    def disposed(self) -> bool:
        return self._client.bus.destroyed


@final
@dataclass(frozen=True, slots=True)
class Fresh[U: StateUnit]:
    """A freshly built unit, and what it was given."""

    unit: U
    passed_in: tuple[Given, ...] = ()

    def given(self, dependency: Given | SemiontClient[Transport]) -> "Fresh[U]":
        """The same, with one more dependency the unit was given: a client, or anything that says whether it was disposed."""
        held = _TheClient(dependency) if isinstance(dependency, SemiontClient) else dependency
        return Fresh(self.unit, (*self.passed_in, held))


class AxiomSubject[U: StateUnit](ABC):
    """How the axioms reach one kind of state unit.

    Only `setup` is required. A means left as it is skips the axioms that need
    it: a unit with no surface is held to no axiom about one.
    """

    @abstractmethod
    def setup(self) -> Fresh[U]:
        """Build a fresh unit, independent of every other one. It is called inside the harness's running loop."""

    def surfaces(self, unit: U) -> Sequence[AsyncIterable[object]]:
        """A new reader of each surface the unit hands out."""
        del unit
        return ()

    def invocations(self, unit: U) -> Sequence[Callable[[], object]]:
        """Each of the unit's methods, as a call with no arguments."""
        del unit
        return ()

    def owned_child_surfaces(self, unit: U) -> Sequence[AsyncIterable[object]]:
        """A new reader of each surface of the children the unit made itself."""
        del unit
        return ()


async def _turns() -> None:
    for _ in range(_TURNS):
        await asyncio.sleep(0)


async def _next_of(items: AsyncIterator[object]) -> bool:
    """Whether `items` gave one more; not, when it has ended."""
    try:
        await anext(items)
    except StopAsyncIteration:
        return False
    return True


@final
class _Reader:
    """One reader of a surface, as the axioms watch it: what it was given since last asked, and whether it has ended."""

    def __init__(self, surface: AsyncIterable[object]) -> None:
        self._items: Final = aiter(surface)
        self._next: asyncio.Task[bool] | None = None
        self._ended = False

    async def _came(self) -> bool:
        """Whether something came since last asked. An end is not something: it is remembered."""
        if self._ended:
            return False
        if self._next is None:
            self._next = asyncio.ensure_future(_next_of(self._items))
        await _turns()
        if not self._next.done():
            return False
        reading, self._next = self._next, None
        if reading.result():
            return True
        self._ended = True
        return False

    async def drained(self) -> int:
        """Take everything that is there now. Returns how much there was."""
        taken = 0
        while await self._came():
            taken += 1
        return taken

    async def moved(self) -> bool:
        return await self.drained() > 0

    async def ended(self) -> bool:
        await self.drained()
        return self._ended


def _run(case: Coroutine[object, object, str | None]) -> str | None:
    """Run one case on a loop of its own. What it left running is cancelled when it ends."""
    return asyncio.run(case)


def _once(axiom: str, case: Callable[[], Coroutine[object, object, str | None]]) -> None:
    try:
        violation = _run(case())
    except Exception as raised:
        raise AssertionError(f"{axiom}: the unit raised {raised!r}") from raised
    if violation is not None:
        raise AssertionError(f"{axiom}: {violation}")


def _property[T](axiom: str, values: st.SearchStrategy[T], case: Callable[[T], Coroutine[object, object, str | None]]) -> None:
    @settings(max_examples=_CASES, database=None, deadline=None, derandomize=True)
    @given(values)
    def holds(value: T) -> None:
        violation = _run(case(value))
        assert violation is None, violation

    try:
        holds()
    except AssertionError as broken:
        raise AssertionError(f"{axiom}: {broken}") from None
    except Exception as raised:
        raise AssertionError(f"{axiom}: the unit raised {raised!r}") from raised


def _undisposed[U: StateUnit](fresh: Fresh[U], when: str) -> str | None:
    for number, dependency in enumerate(fresh.passed_in):
        if dependency.disposed():
            return f"the unit disposed dependency #{number} it was given {when}"
    return None


def _drive(invocations: Sequence[Callable[[], object]], calls: Sequence[int]) -> None:
    for call in calls:
        if not invocations:
            return
        invocations[call % len(invocations)]()


def assert_state_unit_axioms[U: StateUnit](subject: AxiomSubject[U]) -> None:
    """Run every axiom the subject gives the means to check. Raises `AssertionError` naming the first axiom broken, and how."""

    async def a7_passed() -> str | None:
        fresh = subject.setup()
        fresh.unit.dispose()
        await _turns()
        return _undisposed(fresh, "(it does not own it)")

    async def a5(calls: int) -> str | None:
        fresh = subject.setup()
        for _ in range(calls):
            fresh.unit.dispose()
        await _turns()
        return _undisposed(fresh, f"under {calls} dispose() calls")

    async def has_surfaces() -> bool:
        fresh = subject.setup()
        any_surface = bool(subject.surfaces(fresh.unit))
        fresh.unit.dispose()
        return any_surface

    async def a6(readers_each: int) -> str | None:
        fresh = subject.setup()
        readers = [_Reader(surface) for _ in range(readers_each) for surface in subject.surfaces(fresh.unit)]
        for reader in readers:
            await reader.drained()
        fresh.unit.dispose()
        for number, reader in enumerate(readers):
            if not await reader.ended():
                return f"reader #{number} of a surface did not see it end on dispose ({readers_each} readers each)"
        return None

    async def a5b(calls: list[int]) -> str | None:
        fresh = subject.setup()
        fresh.unit.dispose()
        _drive(subject.invocations(fresh.unit), calls)
        await _turns()
        for number, surface in enumerate(subject.surfaces(fresh.unit)):
            reader = _Reader(surface)
            given = await reader.drained()
            if given > 1:
                return f"surface #{number}, taken after dispose, gave {given} values: more than the one it held"
            if not await reader.ended():
                return f"surface #{number}, taken after dispose, has not ended"
        return None

    async def x3(calls: list[int]) -> str | None:
        one, other = subject.setup(), subject.setup()
        watched = [_Reader(surface) for surface in subject.surfaces(other.unit)]
        for reader in watched:
            await reader.drained()
        _drive(subject.invocations(one.unit), calls)
        await _turns()
        moved = [number for number, reader in enumerate(watched) if await reader.moved()]
        one.unit.dispose()
        other.unit.dispose()
        if moved:
            return f"driving one instance moved surface #{moved[0]} of another"
        return None

    async def a7_owned() -> str | None:
        fresh = subject.setup()
        children = [_Reader(surface) for surface in subject.owned_child_surfaces(fresh.unit)]
        for child in children:
            await child.drained()
        fresh.unit.dispose()
        for number, child in enumerate(children):
            if not await child.ended():
                return f"the surface #{number} of a child the unit made did not end when the unit was disposed"
        return None

    async def x1() -> str | None:
        fresh = subject.setup()
        writers = [number for number, surface in enumerate(subject.surfaces(fresh.unit)) if isinstance(surface, Variable)]
        fresh.unit.dispose()
        if writers:
            return f"surface #{writers[0]} is the Variable that holds the state, which a reader could write"
        return None

    _once("A7-passed", a7_passed)
    _property("A5", st.integers(min_value=1, max_value=20), a5)
    if asyncio.run(has_surfaces()):
        _property("A6", st.integers(min_value=1, max_value=10), a6)
    _property("A5b", st.lists(st.integers(min_value=0, max_value=999), max_size=12), a5b)
    _property("X3", st.lists(st.integers(min_value=0, max_value=999), min_size=1, max_size=8), x3)
    _once("A7-owned", a7_owned)
    _once("X1", x1)
