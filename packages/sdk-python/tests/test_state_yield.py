"""The yield unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, and the gate that holds what `generate` takes after its parameters to
what `client.yield_.delegate` takes, which it restates.
"""

import inspect
from collections.abc import AsyncIterable, Callable, Sequence
from typing import final, override

from semiont.channels import BRIDGED_CHANNELS
from semiont.namespaces.yield_ import YieldNamespace
from semiont.state import YieldStateUnit
from semiont.testing import FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms
from semiont.types import GatheredContext, GenerationJobParams

PARAMS = GenerationJobParams(
    title="A title",
    storage_uri="file://generated.md",
    context=GatheredContext.model_validate(
        {
            "focus": {
                "kind": "resource",
                "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []},
            },
            "graph": {"nodes": [], "edges": []},
            "metadata": {},
        }
    ),
)


def test_generate_takes_what_yield_delegate_takes() -> None:
    unit = list(inspect.signature(YieldStateUnit.generate).parameters.values())
    namespace = list(inspect.signature(YieldNamespace.delegate).parameters.values())
    # Each after `self`: by name, kind, default and type.
    assert unit[1:] == namespace[1:]


@final
class Yields(AxiomSubject[YieldStateUnit]):
    """How the axioms reach a yield unit: five states, a run to begin and its display to dismiss, and its client."""

    @override
    def setup(self) -> Fresh[YieldStateUnit]:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        return Fresh(YieldStateUnit(made.client, "en")).given(made.client)

    @override
    def surfaces(self, unit: YieldStateUnit) -> Sequence[AsyncIterable[object]]:
        return (unit.is_generating, unit.progress, unit.outcome, unit.failure, unit.job_id)

    @override
    def invocations(self, unit: YieldStateUnit) -> Sequence[Callable[[], object]]:
        return (lambda: unit.generate(PARAMS), unit.dismiss_progress)


def test_yield_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Yields())
