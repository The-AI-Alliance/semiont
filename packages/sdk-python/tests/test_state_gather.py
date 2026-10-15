"""The gather unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, and the gate that holds what `gather_resource` takes to what
`client.gather.resource` takes, which it restates.
"""

import inspect
from collections.abc import AsyncIterable, Callable, Sequence
from typing import final, override

from semiont.channels import BRIDGED_CHANNELS
from semiont.identifiers import ResourceId
from semiont.namespaces.gather import GatherNamespace
from semiont.state import GatherStateUnit
from semiont.testing import FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms

RESOURCE = ResourceId("res-1")


def test_gather_resource_takes_what_the_gather_namespace_takes() -> None:
    unit = list(inspect.signature(GatherStateUnit.gather_resource).parameters.values())
    namespace = list(inspect.signature(GatherNamespace.resource).parameters.values())
    # Each after `self`: by name, kind, default and type.
    assert unit[1:] == namespace[1:]


@final
class Gatherings(AxiomSubject[GatherStateUnit]):
    """How the axioms reach a gather unit: seven states, a resource's gather to ask for, and its client."""

    @override
    def setup(self) -> Fresh[GatherStateUnit]:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        return Fresh(GatherStateUnit(made.client, RESOURCE)).given(made.client)

    @override
    def surfaces(self, unit: GatherStateUnit) -> Sequence[AsyncIterable[object]]:
        return (
            unit.context,
            unit.loading,
            unit.error,
            unit.annotation_id,
            unit.resource_context,
            unit.resource_loading,
            unit.resource_error,
        )

    @override
    def invocations(self, unit: GatherStateUnit) -> Sequence[Callable[[], object]]:
        return (lambda: unit.gather_resource(RESOURCE),)


def test_gather_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Gatherings())
