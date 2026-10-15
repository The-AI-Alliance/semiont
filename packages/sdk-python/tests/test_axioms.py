"""The axiom harness, held to its own word: a unit broken against one axiom is caught under that axiom's name.

A counter stands in for a state unit: it holds a count a reader watches, is
moved by `increment`, is given a dependency it does not own, and makes a child
it does. Each variant below breaks one axiom and keeps the rest, so the harness
must name the one it breaks, and a counter that breaks none must pass.
"""

from collections.abc import AsyncIterable, Callable, Sequence
from typing import ClassVar, Final, final, override

import pytest

from semiont._reading import Reading
from semiont.state_unit import StateUnit
from semiont.testing.axioms import AxiomSubject, DisposeProbe, Fresh, assert_state_unit_axioms
from semiont.watched import Variable, Watched


class Counter(StateUnit):
    """A unit that keeps every axiom: each variant below overrides one thing."""

    def __init__(self, given: DisposeProbe, *, child: "Counter | None" = None) -> None:
        self._given: Final = given
        self._count = Variable(0)
        self._child = child
        self._disposed = False

    @property
    def count(self) -> Watched[int]:
        return Reading(self._count)

    def increment(self) -> None:
        if not self._disposed:
            self._count.set(self._count.value + 1)

    @property
    def child(self) -> "Counter | None":
        return self._child

    @override
    def dispose(self) -> None:
        self._disposed = True
        self._count.end()
        if self._child is not None:
            self._child.dispose()


class GivesBackWhatItWasGiven(Counter):
    @override
    def dispose(self) -> None:
        super().dispose()
        self._given.dispose()


class FailsTheSecondTime(Counter):
    @override
    def dispose(self) -> None:
        if self._disposed:
            raise RuntimeError("disposed twice")
        super().dispose()


class NeverEndsItsCount(Counter):
    @override
    def dispose(self) -> None:
        self._disposed = True
        if self._child is not None:
            self._child.dispose()


class CountsAgainOnceDisposed(Counter):
    @override
    def increment(self) -> None:
        # Once its count has ended, it starts another: a reader taken now is given a count that moves.
        if self._disposed:
            self._count = Variable(self._count.value + 1)
            return
        super().increment()


class MovesTheOthers(Counter):
    _all: ClassVar[list[Variable[int]]] = []

    def __init__(self, given: DisposeProbe, *, child: Counter | None = None) -> None:
        super().__init__(given, child=child)
        MovesTheOthers._all.append(self._count)

    @override
    def increment(self) -> None:
        for count in MovesTheOthers._all:
            count.set(count.value + 1)


class LeavesItsChild(Counter):
    @override
    def dispose(self) -> None:
        self._disposed = True
        self._count.end()


class HandsOutItsWriter(Counter):
    @property
    @override
    def count(self) -> Watched[int]:
        return self._count


@final
class Counters(AxiomSubject[Counter]):
    """How the harness reaches a counter of one kind."""

    def __init__(self, kind: type[Counter]) -> None:
        self._kind: Final = kind

    @override
    def setup(self) -> Fresh[Counter]:
        given = DisposeProbe()
        return Fresh(self._kind(given, child=Counter(DisposeProbe()))).given(given)

    @override
    def surfaces(self, unit: Counter) -> Sequence[AsyncIterable[object]]:
        return (unit.count,)

    @override
    def invocations(self, unit: Counter) -> Sequence[Callable[[], object]]:
        return (unit.increment,)

    @override
    def owned_child_surfaces(self, unit: Counter) -> Sequence[AsyncIterable[object]]:
        return () if unit.child is None else (unit.child.count,)


def test_a_counter_that_breaks_no_axiom_keeps_them_all() -> None:
    assert_state_unit_axioms(Counters(Counter))


@pytest.mark.parametrize(
    ("kind", "axiom"),
    [
        (GivesBackWhatItWasGiven, "A7-passed"),
        (FailsTheSecondTime, "A5"),
        (NeverEndsItsCount, "A6"),
        (CountsAgainOnceDisposed, "A5b"),
        (MovesTheOthers, "X3"),
        (LeavesItsChild, "A7-owned"),
        (HandsOutItsWriter, "X1"),
    ],
    ids=lambda value: value if isinstance(value, str) else value.__name__,
)
def test_a_unit_that_breaks_one_axiom_is_caught_under_its_name(kind: type[Counter], axiom: str) -> None:
    with pytest.raises(AssertionError) as caught:
        assert_state_unit_axioms(Counters(kind))
    assert str(caught.value).startswith(f"{axiom}: "), str(caught.value)
