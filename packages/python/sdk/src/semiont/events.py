"""A sequence of events, as each of its readers is given it.

Every reader has a queue of its own, and whoever delivers never waits on one.
So a reader that falls behind loses nothing and delays nobody: what it has not
read yet waits for it, in order. A reader that stops reading says so
(`aclose`); one that is simply dropped is forgotten with it. A reader can
instead relay (`relay`): each event is then handed on within its delivery.
"""

import asyncio
import weakref
from collections.abc import Callable, Iterable
from types import TracebackType
from typing import Final, Self, final

__all__ = ["Broadcast", "Events"]


@final
class _Ended:
    """What a reader's queue holds last: there is nothing after it."""


_ENDED: Final = _Ended()


@final
class _Reader[T]:
    """Where a broadcast puts what it delivers to one reader: in its queue, or, once it relays, into what it relays to."""

    def __init__(self) -> None:
        self.waiting: Final[asyncio.Queue[T | _Ended]] = asyncio.Queue()
        self.relayed_to: Callable[[T], object] | None = None

    def take(self, item: T | _Ended) -> None:
        """Keep `item` for the reader, or hand it at once to what the reader relays to, which is handed no end."""
        if self.relayed_to is None:
            self.waiting.put_nowait(item)
        elif not isinstance(item, _Ended):
            self.relayed_to(item)


@final
class Events[T]:
    """One reader's events, from the moment it began to listen: each one, in order.

    Made by a `Broadcast`. It is iterated (`async for`), and can be held with
    `async with`, which stops listening on the way out.
    """

    def __init__(self, reader: _Reader[T], leave: Callable[["Events[T]"], None]) -> None:
        self._reader = reader
        self._leave = leave
        self._over = False

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> T:
        if self._over:
            raise StopAsyncIteration
        item = await self._reader.waiting.get()
        if isinstance(item, _Ended):
            self._over = True
            raise StopAsyncIteration
        return item

    def relay(self, to: Callable[[T], object]) -> Callable[[], None]:
        """Hand `to` what waits for this reader, in order, then each event within its delivery: before whoever delivered it goes on.

        Its iteration is over: nothing more is kept for it. The relay lasts
        while this reader is held, until its events end or what this returns
        is called, which stops listening at once.
        """
        while not self._over and not self._reader.waiting.empty():
            item = self._reader.waiting.get_nowait()
            if isinstance(item, _Ended):
                self._over = True
            else:
                to(item)
        self._over = True
        self._reader.relayed_to = to
        return lambda: self._leave(self)

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
        self._readers: weakref.WeakKeyDictionary[Events[T], _Reader[T]] = weakref.WeakKeyDictionary()
        self._closed = False

    def listen(self) -> Events[T]:
        """A reader of what is delivered from now on. Of a closed broadcast, one that has already ended."""
        return self._admit(_Reader())

    def listen_with(self, kept: Iterable[T]) -> Events[T]:
        """A reader given `kept` first, in order, then what is delivered from now on.

        Of a closed broadcast, one given `kept`, then ended.
        """
        reader: _Reader[T] = _Reader()
        for item in kept:
            reader.take(item)
        return self._admit(reader)

    def _admit(self, reader: _Reader[T]) -> Events[T]:
        events = Events(reader, self._leave)
        if self._closed:
            reader.take(_ENDED)
        else:
            self._readers[events] = reader
        return events

    @property
    def listening(self) -> int:
        """How many readers there are now."""
        return len(self._readers)

    def deliver(self, item: T) -> int:
        """Give `item` to every reader. Returns how many there were."""
        readers = list(self._readers.values())
        for reader in readers:
            reader.take(item)
        return len(readers)

    def close(self) -> None:
        """End every reader's events, once it has read what was delivered, and every later reader's at once."""
        self._closed = True
        for reader in list(self._readers.values()):
            reader.take(_ENDED)
        self._readers.clear()

    def _leave(self, events: Events[T]) -> None:
        self._readers.pop(events, None)
