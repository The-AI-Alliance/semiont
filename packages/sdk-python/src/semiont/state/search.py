"""A search as it is typed: a query, and the results of the query it last settled on.

The query is whatever was last set. Once it has stayed the same for the
debounce, it is searched for, unless it is the query already searched for. A
query of nothing but spaces searches for nothing and has no results. A new query
abandons the search before it. The query it begins with settles like any other.

What it searches with is a function from a query to an async generator of
answers: `None` while the answer is on its way, the results once they are known,
and again each time they change. A live query of the client is such a generator,
once each of its states is read as one or the other. A search that is abandoned
is closed (`aclose`).
"""

import asyncio
from collections.abc import AsyncGenerator, Callable, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final, override

from semiont.state._reading import Reading
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.timing import SEARCH_DEBOUNCE_MS
from semiont.watched import Variable, Watched

__all__ = ["SearchPipeline", "SearchState"]


@final
@dataclass(frozen=True, slots=True)
class SearchState[T]:
    """What a search shows: its results, and whether more are on their way."""

    results: tuple[T, ...]
    is_searching: bool


@final
class SearchPipeline[T](StateUnit):
    """See the module's documentation. `debounce_ms` is how long a query must stay the same before it is searched for."""

    def __init__(
        self,
        search: Callable[[str], AsyncGenerator[Sequence[T] | None, None]],
        *,
        debounce_ms: int = SEARCH_DEBOUNCE_MS,
        initial_query: str = "",
    ) -> None:
        self._search: Final = search
        self._debounce: Final = debounce_ms / 1000
        self._query: Final = Variable(initial_query)
        self._state: Final = Variable[SearchState[T]](SearchState((), is_searching=False))
        self._tasks: Final = Tasks()
        self._searched: str | None = None
        """The query last searched for."""
        self._following: asyncio.Task[None] | None = None
        """The search under way, abandoned when the next query settles."""
        self._tasks.run(self._settle())

    @property
    def query(self) -> Watched[str]:
        """The query as it was last set."""
        return Reading(self._query)

    @property
    def state(self) -> Watched[SearchState[T]]:
        return Reading(self._state)

    def set_query(self, value: str) -> None:
        self._query.set(value)

    async def _settle(self) -> None:
        changes = aiter(self._query)
        # The query it begins with, which settles like any other.
        await anext(changes)
        while True:
            try:
                async with asyncio.timeout(self._debounce):
                    changed = await anext(changes, None)
            except TimeoutError:
                self._settled(self._query.value)
                changed = await anext(changes, None)
            if changed is None:
                return

    def _settled(self, settled: str) -> None:
        if settled == self._searched:
            return
        self._searched = settled
        if self._following is not None:
            self._following.cancel()
            self._following = None
        wanted = settled.strip()
        if not wanted:
            self._state.set(SearchState((), is_searching=False))
            return
        self._state.set(SearchState((), is_searching=True))
        self._following = self._tasks.run(self._follow(self._search(wanted)))

    async def _follow(self, answers: AsyncGenerator[Sequence[T] | None, None]) -> None:
        try:
            async for found in answers:
                self._state.set(SearchState((), is_searching=True) if found is None else SearchState(tuple(found), is_searching=False))
        finally:
            await answers.aclose()

    @override
    def dispose(self) -> None:
        self._tasks.stop()
        self._query.end()
        self._state.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
