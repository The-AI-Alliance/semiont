"""A live query: one of a client's reads that answers from its cache (`semiont.cache`) and stays true as the knowledge base changes.

Building one touches nothing, so a query is made wherever it is convenient to
name it. It is then read one of two ways:

- Held with `async with`, it is the live view: the query's state now, and each
  state after it, until the client is closed. Watching is what asks: the first
  watcher of a query nobody has asked starts its fetch. While a query of one
  resource is held, the client holds that resource's scope, so the events that
  keep the query true reach it. A query is watched inside its client's own
  `async with`, which is what listens for those events: before it, watching
  is a `RuntimeError`.

      async with client.browse.annotations(resource_id) as live:
          async for state in live:
              match state:
                  case Ready(value=annotations): ...
                  case Failed(error=error): ...
                  case Pending(): ...

  A failure is a state, never a raise: the query lives through it.
- `await query.fresh()` is the one-shot read: it asks the service now, and
  gives what it answers or raises the failure it met. Every watcher of the
  query is given the answer too.

`invalidate` says the value is out of date: it is asked for again, and shown
meanwhile.

A value is the one every reader of the query is given: it is read, not changed.
"""

from collections.abc import AsyncIterator, Callable, Hashable
from types import TracebackType
from typing import Final, Protocol, Self, final, override

from semiont.cache import Cache, CacheState, Failed, Pending, Ready
from semiont.identifiers import ResourceId
from semiont.transport import ResourceHold, Transport

__all__ = ["Cached", "Keyed", "Source", "itself", "shown"]


class Source[T](Protocol):
    """What a query answers from: the namespace that made the query supplies it."""

    async def fresh(self) -> T:
        """The value now, from the service."""
        ...

    def watch(self) -> AsyncIterator[CacheState[T]]:
        """The query's state, now and as it changes."""
        ...

    def invalidate(self) -> None:
        """The value is out of date."""
        ...

    def hold(self) -> ResourceHold | None:
        """A hold on the scope of the resource the query is of, when it is of one."""
        ...


@final
class Cached[T]:
    """See the module's documentation."""

    def __init__(self, source: Source[T], *, watchable: Callable[[], None]) -> None:
        self._source: Final = source
        self._watchable: Final = watchable
        """Raises for a watcher nothing would keep true."""
        self._holds: Final[list[ResourceHold | None]] = []
        """The hold each `async with` on the query took, innermost last."""

    async def fresh(self) -> T:
        """The value now, from the service."""
        return await self._source.fresh()

    def invalidate(self) -> None:
        """The value is out of date: ask again, showing it meanwhile."""
        self._source.invalidate()

    async def __aenter__(self) -> AsyncIterator[CacheState[T]]:
        self._watchable()
        # The scope first, so the events that refresh the key are already coming when its value arrives.
        self._holds.append(self._source.hold())
        return self._source.watch()

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        hold = self._holds.pop()
        if hold is not None:
            hold.release()


def itself[V](value: V) -> V:
    """A value as it is: the view of a query that shows its cache's value whole."""
    return value


def shown[V, T](state: CacheState[V], view: Callable[[V], T]) -> CacheState[T]:
    """A state of a cache's value, as a state of what a query shows of it."""
    match state:
        case Ready(value=value):
            return Ready(view(value))
        case Pending() | Failed():
            return state


@final
class _Viewed[V, T]:
    def __init__(self, states: AsyncIterator[CacheState[V]], view: Callable[[V], T]) -> None:
        self._states: Final = states
        self._view: Final = view

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> CacheState[T]:
        return shown(await anext(self._states), self._view)


@final
class Keyed[K: Hashable, V, T](Source[T]):
    """A query answered by one key of one cache, as `view` shows its value.

    `scope` is the resource the query is of, and what holds its scope while
    the query is watched.
    """

    def __init__(self, cache: Cache[K, V], key: K, view: Callable[[V], T], *, scope: tuple[Transport, ResourceId] | None = None) -> None:
        self._cache: Final = cache
        self._key: Final = key
        self._view: Final = view
        self._scope: Final = scope

    @override
    async def fresh(self) -> T:
        return self._view(await self._cache.fetch(self._key))

    @override
    def watch(self) -> AsyncIterator[CacheState[T]]:
        return _Viewed(self._cache.observe(self._key), self._view)

    @override
    def invalidate(self) -> None:
        self._cache.invalidate(self._key)

    @override
    def hold(self) -> ResourceHold | None:
        if self._scope is None:
            return None
        transport, resource_id = self._scope
        return transport.subscribe_to_resource(resource_id)
