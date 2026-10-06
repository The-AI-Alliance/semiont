"""A value that changes: what it is now, and what it becomes.

Two kinds of thing are observed in this SDK, and they behave differently for a
reader that falls behind. A sequence of events (`semiont.events`) gives its
reader every one. A state is what is true now: its reader always holds the
present value, and one that is slow is given the latest in place of each step
it missed. A connection's state is one; so is the token a transport sends.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Protocol, Self, final

__all__ = ["NeverReached", "Variable", "Watched", "reached"]


class Watched[T](Protocol):
    """What a reader of a changing value holds.

    Iterating gives the value as it is, and then the value again each time it
    has changed. The iteration ends when the value can change no more.
    """

    @property
    def value(self) -> T:
        """The value now."""
        ...

    def __aiter__(self) -> AsyncIterator[T]: ...


@final
class _Changes[T]:
    """One reader's place in a variable's changes."""

    def __init__(self, after: Callable[[int], Awaitable[tuple[int, T] | None]]) -> None:
        self._after = after
        self._seen = -1

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> T:
        changed = await self._after(self._seen)
        if changed is None:
            raise StopAsyncIteration
        self._seen, value = changed
        return value


@final
class Variable[T]:
    """A value its owner changes, and anyone may watch."""

    def __init__(self, value: T) -> None:
        self._value = value
        self._version = 0
        self._ended = False
        self._waiting: set[asyncio.Future[None]] = set()

    @property
    def value(self) -> T:
        """The value now."""
        return self._value

    def set(self, value: T) -> None:
        """Change the value. One equal to the present value is no change, and after `end` nothing is."""
        if self._ended or value == self._value:
            return
        self._value = value
        self._version += 1
        self._wake()

    def end(self) -> None:
        """Say the value will not change again: each reader's iteration ends once it has been given this one."""
        self._ended = True
        self._wake()

    def __aiter__(self) -> AsyncIterator[T]:
        return _Changes(self._after)

    def _wake(self) -> None:
        for waiter in self._waiting:
            if not waiter.done():
                waiter.set_result(None)
        self._waiting.clear()

    async def _after(self, seen: int) -> tuple[int, T] | None:
        """The value and its version, once it is not the version `seen`; nothing when there will be no other."""
        while seen == self._version:
            if self._ended:
                return None
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiting.add(waiter)
            try:
                await waiter
            finally:
                self._waiting.discard(waiter)
        return self._version, self._value


class NeverReached(Exception):
    """A watched value can change no more, and it never came to what was awaited of it."""


async def reached[T](watched: Watched[T], holds: Callable[[T], bool]) -> T:
    """The first value of `watched` that `holds` accepts, now or when it comes. Raises `NeverReached` if it ends without one."""
    async for value in watched:
        if holds(value):
            return value
    raise NeverReached
