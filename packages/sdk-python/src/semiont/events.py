"""A sequence of events, as each of its readers is given it.

Every reader has a queue of its own, and whoever delivers never waits on one.
So a reader that falls behind loses nothing and delays nobody: what it has not
read yet waits for it, in order. A reader that stops reading says so
(`aclose`); one that is simply dropped is forgotten with it.
"""

import asyncio
import weakref
from collections.abc import Callable
from types import TracebackType
from typing import Final, Self, final

__all__ = ["Broadcast", "Events"]


@final
class _Ended:
    """What a reader's queue holds last: there is nothing after it."""


_ENDED: Final = _Ended()


@final
class Events[T]:
    """One reader's events, from the moment it began to listen: each one, in order.

    Made by a `Broadcast`. It is iterated (`async for`), and can be held with
    `async with`, which stops listening on the way out.
    """

    def __init__(self, queue: asyncio.Queue[T | _Ended], leave: Callable[["Events[T]"], None]) -> None:
        self._queue = queue
        self._leave = leave
        self._over = False

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> T:
        if self._over:
            raise StopAsyncIteration
        item = await self._queue.get()
        if isinstance(item, _Ended):
            self._over = True
            raise StopAsyncIteration
        return item

    async def aclose(self) -> None:
        """Stop listening: nothing more is kept for this reader, and its iteration is over."""
        self._leave(self)
        self._over = True

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.aclose()


@final
class Broadcast[T]:
    """What is delivered to every reader listening when it is delivered."""

    def __init__(self) -> None:
        self._readers: weakref.WeakKeyDictionary[Events[T], asyncio.Queue[T | _Ended]] = weakref.WeakKeyDictionary()
        self._closed = False

    def listen(self) -> Events[T]:
        """A reader of what is delivered from now on. Of a closed broadcast, one that has already ended."""
        queue: asyncio.Queue[T | _Ended] = asyncio.Queue()
        events = Events(queue, self._leave)
        if self._closed:
            queue.put_nowait(_ENDED)
        else:
            self._readers[events] = queue
        return events

    def deliver(self, item: T) -> int:
        """Give `item` to every reader. Returns how many there were."""
        queues = list(self._readers.values())
        for queue in queues:
            queue.put_nowait(item)
        return len(queues)

    def close(self) -> None:
        """End every reader's events, once it has read what was delivered, and every later reader's at once."""
        self._closed = True
        for queue in list(self._readers.values()):
            queue.put_nowait(_ENDED)
        self._readers.clear()

    def _leave(self, events: Events[T]) -> None:
        self._readers.pop(events, None)
