"""The order a Weaver works in: one lane for each resource.

What is put on a lane is done one at a time, in the order it was put there,
and the lanes work beside each other (`docs/protocol/WEAVER.md` § Order). A
resource's events are applied in a lane of its own, and so is a rebuild of
it: an event that arrives while its resource is being rebuilt waits for the
rebuild, and is not applied into the middle of it.

One piece of work is done with no lane working: a rebuild of everything,
which clears the graph.

A lane lives while it has work. With none left it is gone, so a Weaver that
has followed a million resources holds no lane for them.
"""

import asyncio
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Final, final

__all__ = ["Lanes"]

type Work = Callable[[], Awaitable[None]]
"""One piece of a lane's work. It raises nothing: what it failed at is its own to say."""


@final
class Lanes:
    """The lanes. See the module's documentation."""

    def __init__(self) -> None:
        self._waiting: Final[dict[str, deque[Work]]] = {}
        self._working: Final[dict[str, asyncio.Task[None]]] = {}
        self._turn: Final = asyncio.Condition()
        self._beside = 0
        """How many lanes are in the middle of a piece of work."""
        self._alone = False
        """Whether something is working, or waiting to work, with no lane working."""
        self._awaited: Final[set[asyncio.Future[object]]] = set()
        """What `run` is waiting on: given up when the lanes close, so that nobody waits on work that will not be done."""
        self._closed = False

    def put(self, lane: str, work: Work) -> None:
        """Put a piece of work at the end of a lane. On a closed set of lanes it is dropped: nothing more is done."""
        if self._closed:
            return
        self._waiting.setdefault(lane, deque()).append(work)
        if lane not in self._working:
            self._working[lane] = asyncio.get_running_loop().create_task(self._work(lane))

    async def run[T](self, lane: str, work: Callable[[], Awaitable[T]]) -> T:
        """Do `work` in a lane, in its turn, and answer what it answers. What it raises is raised here.

        Raises `asyncio.CancelledError` where the lanes close before the work is done.
        """
        if self._closed:
            raise RuntimeError("the Weaver is stopping: nothing more is done")
        answered: list[T] = []
        done: asyncio.Future[object] = asyncio.get_running_loop().create_future()

        async def doing() -> None:
            try:
                answered.append(await work())
            except Exception as failure:
                if not done.done():
                    done.set_exception(failure)
            else:
                if not done.done():
                    done.set_result(None)

        self._awaited.add(done)
        try:
            self.put(lane, doing)
            await done
        finally:
            self._awaited.discard(done)
        return answered[0]

    async def _work(self, lane: str) -> None:
        waiting = self._waiting[lane]
        try:
            while waiting:
                work = waiting.popleft()
                async with self._turn:
                    await self._turn.wait_for(lambda: not self._alone)
                    self._beside += 1
                try:
                    await work()
                finally:
                    async with self._turn:
                        self._beside -= 1
                        self._turn.notify_all()
        finally:
            # No turn is given up between finding the lane empty and leaving it: nothing can be put on it in between.
            self._waiting.pop(lane, None)
            self._working.pop(lane, None)

    @asynccontextmanager
    async def alone(self) -> AsyncGenerator[None]:
        """Work with no lane working: every lane finishes what it is in the middle of, and starts nothing until this is over."""
        async with self._turn:
            await self._turn.wait_for(lambda: not self._alone)
            self._alone = True
            await self._turn.wait_for(lambda: self._beside == 0)
        try:
            yield
        finally:
            async with self._turn:
                self._alone = False
                self._turn.notify_all()

    async def settled(self, lanes: Iterable[str] | None = None) -> None:
        """Wait until the lanes named have done all they were given: every lane, where none is named."""
        while True:
            working = [task for lane, task in self._working.items() if lanes is None or lane in lanes]
            if not working:
                return
            await asyncio.wait(working)
            if lanes is not None:
                return

    async def aclose(self) -> None:
        """Stop: what a lane is in the middle of is given up, and what was waiting is dropped."""
        self._closed = True
        working = list(self._working.values())
        for task in working:
            task.cancel()
        await asyncio.gather(*working, return_exceptions=True)
        for awaited in list(self._awaited):
            awaited.cancel()
