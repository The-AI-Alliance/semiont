"""The match unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms: it holds no state, and is given its client.
"""

from typing import final, override

from semiont.channels import BRIDGED_CHANNELS
from semiont.state import MatchStateUnit
from semiont.testing import DropReply, FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms


@final
class Matches(AxiomSubject[MatchStateUnit]):
    """How the axioms reach a match unit: over a client's stream, where nothing answers."""

    @override
    def setup(self) -> Fresh[MatchStateUnit]:
        made = create_test_client(
            transport=FaultyTransport([DropReply()], make_response=lambda operation, payload: None, channels=BRIDGED_CHANNELS)
        )
        return Fresh(MatchStateUnit(made.client)).given(made.client)


def test_match_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Matches())
