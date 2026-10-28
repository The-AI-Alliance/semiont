"""The gather unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, the gates that hold what `gather_resource` and `gather_annotation`
take to what `client.gather.resource` and `client.gather.annotation` take,
which they restate, and that a gather asked of a unit disposed before the gather
runs leaves no coroutine unawaited.
"""

import gc
import inspect
import warnings
from collections.abc import AsyncIterable, Callable, Sequence
from typing import Final, final, override

import pytest
from aio import run, turns

from semiont.channels import BRIDGED_CHANNELS
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.gather import GatherNamespace
from semiont.state import GatherStateUnit
from semiont.testing import FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms

RESOURCE = ResourceId("res-1")
ANNOTATION = AnnotationId("ann-1")


def test_gather_resource_takes_what_the_gather_namespace_takes() -> None:
    unit = list(inspect.signature(GatherStateUnit.gather_resource).parameters.values())
    namespace = list(inspect.signature(GatherNamespace.resource).parameters.values())
    # Each after `self`: by name, kind, default and type.
    assert unit[1:] == namespace[1:]


def test_gather_annotation_takes_what_the_gather_namespace_takes_but_the_resource() -> None:
    unit = list(inspect.signature(GatherStateUnit.gather_annotation).parameters.values())
    namespace = list(inspect.signature(GatherNamespace.annotation).parameters.values())
    # Each after `self`, and the namespace's after `resource_id`, which is the unit's own: by name, kind, default and type.
    assert unit[1:] == namespace[2:]


ASKS: Final[Sequence[Callable[[GatherStateUnit], None]]] = (
    lambda unit: unit.gather_annotation(ANNOTATION),
    lambda unit: unit.gather_resource(RESOURCE),
)


@pytest.mark.parametrize("ask", ASKS, ids=["gather_annotation", "gather_resource"])
def test_a_gather_disposed_before_it_runs_leaves_no_coroutine_unawaited(ask: Callable[[GatherStateUnit], None]) -> None:
    async def scenario() -> None:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        async with made.client as client:
            unit = GatherStateUnit(client, RESOURCE)
            ask(unit)
            unit.dispose()
            await turns()

    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        run(scenario())
        gc.collect()
    assert [str(warning.message) for warning in seen if issubclass(warning.category, RuntimeWarning)] == []


@final
class Gatherings(AxiomSubject[GatherStateUnit]):
    """How the axioms reach a gather unit: seven states, an annotation's gather and a resource's to ask for, and its client."""

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
        return (lambda: unit.gather_annotation(ANNOTATION), lambda: unit.gather_resource(RESOURCE))


def test_gather_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Gatherings())
