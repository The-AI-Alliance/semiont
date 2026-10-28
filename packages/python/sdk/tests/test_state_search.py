"""The search pipeline: what its cases in `specs/src/client/state-units.json` cannot state.

Its behaviour is the table's, run by `tests/test_state_cases.py`. Here are the
axioms, and that a search it abandons is closed.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterable, Callable, Sequence
from typing import final, override

from aio import pass_time, run, turns

from semiont.state import SearchPipeline
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms
from semiont.timing import SEARCH_DEBOUNCE_MS


async def never_answered(query: str) -> AsyncGenerator[Sequence[str] | None, None]:
    """A search whose answer never comes."""
    del query
    await asyncio.Event().wait()
    yield None


def test_a_search_that_is_abandoned_is_closed() -> None:
    closed: list[str] = []

    async def remembered(query: str) -> AsyncGenerator[Sequence[str] | None, None]:
        try:
            await asyncio.Event().wait()
            yield None
        finally:
            closed.append(query)

    async def scenario() -> None:
        async with SearchPipeline(remembered, initial_query="paris") as pipeline:
            await turns()
            await pass_time((SEARCH_DEBOUNCE_MS + 2) / 1000)
            assert closed == []

            pipeline.set_query("rome")
            await turns()
            await pass_time((SEARCH_DEBOUNCE_MS + 2) / 1000)
            assert closed == ["paris"]
        # And the one under way when the pipeline ends.
        assert closed == ["paris", "rome"]

    run(scenario())


@final
class Pipelines(AxiomSubject[SearchPipeline[str]]):
    """How the axioms reach a search pipeline: its query and its state, and the query set two ways."""

    @override
    def setup(self) -> Fresh[SearchPipeline[str]]:
        return Fresh(SearchPipeline(never_answered))

    @override
    def surfaces(self, unit: SearchPipeline[str]) -> Sequence[AsyncIterable[object]]:
        return (unit.query, unit.state)

    @override
    def invocations(self, unit: SearchPipeline[str]) -> Sequence[Callable[[], object]]:
        return (lambda: unit.set_query("paris"), lambda: unit.set_query("rome"))


def test_the_search_pipeline_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Pipelines())
