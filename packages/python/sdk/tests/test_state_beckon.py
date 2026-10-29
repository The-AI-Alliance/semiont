"""The beckon unit: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, and how often its state wakes a reader, which differs by language.
"""

import asyncio
from collections.abc import AsyncIterable, Callable, Sequence
from typing import final, override

from aio import run, soon, turns

from semiont.channels import BRIDGED_CHANNELS
from semiont.identifiers import AnnotationId, ResourceId
from semiont.state import BeckonStateUnit
from semiont.testing import FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms

RES, ANN = ResourceId("res-1"), AnnotationId("ann-1")


def test_a_state_set_to_what_it_already_holds_wakes_nobody() -> None:
    async def scenario() -> None:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        async with made.client as client, BeckonStateUnit(client, RES) as unit:
            readers = aiter(unit.hovered_annotation_id)
            assert await soon(anext(readers)) is None

            client.beckon.hover(ANN)
            assert await soon(anext(readers)) == ANN

            client.beckon.hover(ANN)
            again = asyncio.ensure_future(anext(readers))
            await turns()
            assert not again.done()
            again.cancel()
            await asyncio.gather(again, return_exceptions=True)

    run(scenario())


@final
class Beckons(AxiomSubject[BeckonStateUnit]):
    """How the axioms reach a beckon unit: it holds what is hovered, is told to focus, and is given its client."""

    @override
    def setup(self) -> Fresh[BeckonStateUnit]:
        made = create_test_client(transport=FaultyTransport([], channels=BRIDGED_CHANNELS))
        return Fresh(BeckonStateUnit(made.client, RES)).given(made.client)

    @override
    def surfaces(self, unit: BeckonStateUnit) -> Sequence[AsyncIterable[object]]:
        return (unit.hovered_annotation_id,)

    @override
    def invocations(self, unit: BeckonStateUnit) -> Sequence[Callable[[], object]]:
        return (lambda: unit.focus(ANN),)


def test_beckon_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Beckons())
