"""A long-running operation: what it reports as it goes, then its final value.

A `Running` is consumed one of two ways, once:

- awaited, it gives the final value;
- iterated (`async for`), it gives every report and then the final value, and
  ends. A failure is raised where the final value would have been given.

Nothing is sent until it is first awaited or iterated. Its caller abandons it
by cancelling the task that awaits it or reads it: what was sent stays sent,
and nothing more is.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Generator
from typing import Final, Self, final

from semiont.errors import BusRequestError

__all__ = ["Running"]


@final
class _Ended:
    """What an operation's reports hold last: the work is over."""


_ENDED: Final = _Ended()


@final
class Running[T]:
    """See the module's documentation.

    Made with what starts the work: a function that is given where the work
    reports, and returns the task doing it.
    """

    def __init__(self, start: Callable[[Callable[[T], None]], asyncio.Task[T]]) -> None:
        self._start: Final = start
        self._working: asyncio.Task[T] | None = None
        self._reports: Final[asyncio.Queue[T | _Ended]] = asyncio.Queue()
        self._taken = False
        self._over = False

    def _begun(self) -> asyncio.Task[T]:
        if self._working is None:
            self._working = self._start(self._reports.put_nowait)
            self._working.add_done_callback(self._ended)
        return self._working

    def _ended(self, working: asyncio.Task[T]) -> None:
        # What it reported before it ended has been queued, and it reports no more.
        self._reports.put_nowait(_ENDED)
        if not working.cancelled():
            # Its failure is its consumer's to hear. Read here, it is not also said to be unheard.
            working.exception()

    def _take(self) -> None:
        if self._taken:
            raise RuntimeError("a running operation is awaited or read once")
        self._taken = True

    async def _outcome(self) -> T:
        working = self._begun()
        try:
            return await working
        except asyncio.CancelledError:
            # The work was ended by its client's closing, and its consumer was not: that is a failure to hear, not a cancellation.
            task = asyncio.current_task()
            if working.cancelled() and (task is None or task.cancelling() == 0):
                raise BusRequestError("bus.closed", "The client closed before the operation ended") from None
            raise

    def __await__(self) -> Generator[object, None, T]:
        self._take()
        return self._outcome().__await__()

    def __aiter__(self) -> AsyncIterator[T]:
        self._take()
        return _Reading(self._next)

    async def _next(self) -> T:
        if self._over:
            raise StopAsyncIteration
        working = self._begun()
        try:
            report = await self._reports.get()
        except asyncio.CancelledError:
            working.cancel()
            raise
        if isinstance(report, _Ended):
            # Every report has been given: the work's outcome is the last item.
            self._over = True
            return await self._outcome()
        return report


@final
class _Reading[T]:
    """An operation's reports and its final value, as whoever reads them is given them."""

    def __init__(self, following: Callable[[], Awaitable[T]]) -> None:
        self._following: Final = following

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> T:
        return await self._following()
