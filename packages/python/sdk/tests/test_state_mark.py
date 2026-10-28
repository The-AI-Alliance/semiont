"""The mark unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms: they hold its six states, its three methods and its end.
"""

from collections.abc import AsyncIterable, Callable, Sequence
from typing import final, override

from semiont.channels import BRIDGED_CHANNELS
from semiont.identifiers import ResourceId
from semiont.state import MarkStateUnit
from semiont.testing import FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms
from semiont.types import HighlightingJobParams

PARAMS = HighlightingJobParams(motivation="highlighting")


@final
class Marks(AxiomSubject[MarkStateUnit]):
    """How the axioms reach a mark unit: its six states, its three methods, and its client."""

    @override
    def setup(self) -> Fresh[MarkStateUnit]:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        return Fresh(MarkStateUnit(made.client, ResourceId("res-1"))).given(made.client)

    @override
    def surfaces(self, unit: MarkStateUnit) -> Sequence[AsyncIterable[object]]:
        return (unit.pending_annotation, unit.delegating_motivation, unit.progress, unit.progress_motivation, unit.failure, unit.job_id)

    @override
    def invocations(self, unit: MarkStateUnit) -> Sequence[Callable[[], object]]:
        return (lambda: unit.request_delegate(PARAMS), unit.cancel_pending, unit.dismiss_progress)


def test_mark_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Marks())
