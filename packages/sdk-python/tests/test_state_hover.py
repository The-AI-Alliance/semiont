"""The hover dwell: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms: it holds no state, so they hold its end and its methods afterwards.
"""

from collections.abc import Callable, Sequence
from typing import final, override

from semiont.identifiers import AnnotationId
from semiont.state import HoverDwell
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms
from semiont.timing import HOVER_DELAY_MS


@final
class Dwells(AxiomSubject[HoverDwell]):
    """How the axioms reach a hover dwell: the pointer enters and leaves, and what it says is said to nobody."""

    @override
    def setup(self) -> Fresh[HoverDwell]:
        return Fresh(HoverDwell(lambda hovered: None, HOVER_DELAY_MS))

    @override
    def invocations(self, unit: HoverDwell) -> Sequence[Callable[[], object]]:
        return (lambda: unit.enter(AnnotationId("ann-1")), unit.leave)


def test_the_dwell_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Dwells())
