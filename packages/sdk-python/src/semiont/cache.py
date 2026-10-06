"""A read-through cache: what a client's live queries answer from (`docs/protocol/CACHE-SEMANTICS.md`, B1 to B20).

**A key has one state, and every observer of the key holds it**: `Pending`
(no value yet; a fetch may be in flight), `Ready` (a value, which may be the
one shown while a newer is fetched), or `Failed` (a key with no value whose
fetch, and its one retry, failed). `Failed` is a state, not the end of
anything: an observer lives through it, and the next act on the key tries
again.

Two ways to read:

- `observe` is the live view. The first observer of a key with nothing starts
  a fetch; later ones are given what is there. A failed fetch is tried once
  more; a key with a value keeps showing it whatever its refetches do.
- `fetch` is the one-shot read. It always asks, gives what it was answered or
  raises the failure it met, and never retries: its caller sees the failure
  and decides.

`invalidate` asks again and keeps showing the value meanwhile; `set` writes a
value that is known; `remove` ends a key whose entity is gone. `dispose` is
terminal: every observer's states end, and nothing is fetched, retried or
failed after it.

A cache with a `CachePersister` begins with what was kept and saves its values
as they change. A value that was kept is shown at once and asked for again the
first time it is observed: nothing says it is still true.

An observer that falls behind is given the latest state, not each one it
missed: a state is what is true now.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Hashable, Mapping
from dataclasses import dataclass, field
from typing import Final, Literal, Protocol, final

from semiont.errors import BusRequestError, SemiontError
from semiont.watched import Variable

__all__ = ["SAVE_DEBOUNCE_MS", "Cache", "CachePersister", "CacheState", "Failed", "Pending", "Ready", "Runs", "closed"]

SAVE_DEBOUNCE_MS: Final = 50
"""How long a cache waits, after its values change, before it saves them: a burst of changes is one save."""


@final
@dataclass(frozen=True, slots=True)
class Pending:
    """No value yet."""

    status: Literal["pending"] = field(default="pending", init=False)


@final
@dataclass(frozen=True, slots=True)
class Ready[T]:
    """A value."""

    value: T
    status: Literal["ready"] = field(default="ready", init=False)


@final
@dataclass(frozen=True, slots=True)
class Failed:
    """No value, and the fetch for one failed, and failed again."""

    error: SemiontError
    status: Literal["failed"] = field(default="failed", init=False)


type CacheState[T] = Pending | Ready[T] | Failed
"""The state of a key. A `match` over one names all three."""


class CachePersister[K, V](Protocol):
    """Where a cache keeps its values so a later one begins with them."""

    def load(self) -> Mapping[K, V] | None:
        """What was kept, asked once, when the cache is built."""
        ...

    def save(self, entries: Mapping[K, V]) -> None:
        """Keep these: the cache's values, after they changed."""
        ...


class Runs(Protocol):
    """What runs a cache's fetches: tasks that have ended by the time whoever owns them has closed."""

    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        """Run `work` as a task."""
        ...


def closed() -> BusRequestError:
    """What a read of a closed client fails as: what a request of a closed bus does."""
    return BusRequestError("bus.closed", "The client is closed")


@final
class _Key[V]:
    def __init__(self, state: CacheState[V]) -> None:
        self.state: Final = Variable[CacheState[V]](state)
        self.in_flight: tuple[int, asyncio.Task[V]] | None = None
        """The fetch in flight for the key: its number, and its task. An
        `invalidate` lets go of it without waiting, so a fetch whose answer
        will never come cannot hold the key."""

    def known(self) -> bool:
        """Whether anything asked for the key and has not let go of it."""
        return self.in_flight is not None or not isinstance(self.state.value, Pending)


async def _joined[V](fetch: asyncio.Task[V]) -> V:
    """What a fetch gives, to one of those waiting on it: whoever stops waiting does not stop the fetch."""
    try:
        return await asyncio.shield(fetch)
    except asyncio.CancelledError:
        # The fetch was ended by its client's closing, and its caller was not: that is a failure to hear, not a cancellation.
        task = asyncio.current_task()
        if fetch.cancelled() and (task is None or task.cancelling() == 0):
            raise closed() from None
        raise


@final
class _Nothing[T]:
    """The states of a key of a disposed cache: none."""

    def __aiter__(self) -> "_Nothing[T]":
        return self

    async def __anext__(self) -> T:
        raise StopAsyncIteration


@final
class Cache[K: Hashable, V]:
    """See the module's documentation.

    `fetch` asks the service for a key's value. `tasks` runs the fetches.
    With a `persister`, the cache begins with what it kept, and saves its
    values there once they have stopped changing for `SAVE_DEBOUNCE_MS`.
    """

    def __init__(
        self,
        fetch: Callable[[K], Awaitable[V]],
        *,
        tasks: Runs,
        persister: CachePersister[K, V] | None = None,
    ) -> None:
        self._fetch: Final = fetch
        self._tasks: Final = tasks
        self._persister: Final = persister
        self._disposed = False
        self._fetches = 0
        self._saving: asyncio.TimerHandle | None = None
        """The wait before the next save, while one is owed."""
        kept = None if persister is None else persister.load()
        self._keys: Final[dict[K, _Key[V]]] = {key: _Key(Ready(value)) for key, value in (kept or {}).items()}
        self._kept: Final[set[K]] = set(self._keys)
        """Keys whose value was kept by an earlier cache and has not been asked for by this one."""

    def _held(self, key: K) -> _Key[V]:
        held = self._keys.get(key)
        if held is None:
            held = self._keys[key] = _Key(Pending())
        return held

    def _values(self) -> dict[K, V]:
        return {key: held.state.value.value for key, held in self._keys.items() if isinstance(held.state.value, Ready)}

    def _owe_a_save(self) -> None:
        """The values changed: save them once they have stopped changing."""
        if self._persister is None:
            return
        if self._saving is not None:
            self._saving.cancel()
        self._saving = asyncio.get_running_loop().call_later(SAVE_DEBOUNCE_MS / 1000, self._save)

    def _save(self) -> None:
        self._saving = None
        if self._persister is not None:
            self._persister.save(self._values())

    def _fetching(self, key: K) -> asyncio.Task[V]:
        """Start a fetch for `key`, or join the one in flight."""
        # Asked for by this cache now, whichever path asked.
        self._kept.discard(key)
        held = self._held(key)
        if held.in_flight is not None:
            return held.in_flight[1]
        self._fetches += 1
        fetch = self._tasks.run(self._fetched(key, self._fetches))
        held.in_flight = (self._fetches, fetch)
        return fetch

    async def _fetched(self, key: K, number: int) -> V:
        try:
            value = await self._fetch(key)
        finally:
            # Only its own, and on every way out: an `invalidate` may have put a newer fetch in its place.
            held = self._keys.get(key)
            if held is not None and held.in_flight is not None and held.in_flight[0] == number:
                held.in_flight = None
        # A value from any fetch is written, the newest last: each is at least
        # as new as what was there. A failure writes nothing. One answered
        # after the cache was disposed has no key to write to.
        held = self._keys.get(key)
        if held is not None:
            held.state.set(Ready(value))
            self._owe_a_save()
        return value

    def _revalidate(self, key: K) -> None:
        """Fetch for the live view: a failure is tried once more, and a key with no value whose retry also fails becomes `Failed`."""
        self._tasks.run(self._chain(key, self._fetching(key)))

    async def _chain(self, key: K, first: asyncio.Task[V]) -> None:
        try:
            await _joined(first)
        except SemiontError:
            pass
        else:
            return
        if self._disposed:
            return
        try:
            await _joined(self._fetching(key))
        except SemiontError as failure:
            held = self._keys.get(key)
            if held is not None and not isinstance(held.state.value, Ready):
                held.state.set(Failed(failure))

    def observe(self, key: K) -> AsyncIterator[CacheState[V]]:
        """The key's state, now and as it changes, until the cache is disposed.

        Observing is what asks: a key with nothing is fetched, a failed key
        is tried again, and a value an earlier cache kept is asked for anew
        while it is shown.
        """
        if self._disposed:
            return _Nothing[CacheState[V]]()
        was_kept = key in self._kept
        held = self._held(key)
        state = held.state.value
        if isinstance(state, Failed):
            # An observer arriving at a failed key starts over, for everyone: a fetch is in flight for all of them.
            held.state.set(Pending())
            asks = True
        elif isinstance(state, Ready):
            asks = was_kept
        else:
            asks = held.in_flight is None
        observing = aiter(held.state)
        if asks:
            self._revalidate(key)
        return observing

    async def fetch(self, key: K) -> V:
        """Ask for the key's value now.

        What the service answers, which every observer of the key is given
        too; or the failure, which only this caller is. Concurrent asks for
        one key share one fetch.
        """
        if self._disposed:
            raise closed()
        return await _joined(self._fetching(key))

    def get(self, key: K) -> V | None:
        """The key's value now, asking for nothing."""
        held = self._keys.get(key)
        state = None if held is None else held.state.value
        return state.value if isinstance(state, Ready) else None

    def known(self, key: K) -> bool:
        """Whether anything has asked for the key and not let go of it: it has a value or a failure, or a fetch for it is in flight."""
        held = self._keys.get(key)
        return held is not None and held.known()

    def keys(self) -> list[K]:
        """Every key the cache knows."""
        return [key for key, held in self._keys.items() if held.known()]

    @property
    def persistence_pending(self) -> bool:
        """Whether a cache that keeps its values has not yet kept what it knows: a fetch is in flight, or a save is owed."""
        if self._persister is None:
            return False
        return self._saving is not None or any(held.in_flight is not None for held in self._keys.values())

    def invalidate(self, key: K) -> None:
        """The key's value is out of date: ask again, showing what there is meanwhile.

        A fetch already in flight is not waited on: its answer may never come.
        """
        if self._disposed:
            return
        held = self._held(key)
        held.in_flight = None
        if isinstance(held.state.value, Failed):
            held.state.set(Pending())
        self._revalidate(key)

    def invalidate_all(self) -> None:
        """`invalidate`, of every key the cache knows."""
        for key in self.keys():
            self.invalidate(key)

    def remove(self, key: K, gone: SemiontError) -> None:
        """The key's entity is gone: its value is dropped and the key is failed with `gone`, at once, for every observer.

        Nothing is asked for.
        """
        if self._disposed:
            return
        held = self._held(key)
        held.in_flight = None
        held.state.set(Failed(gone))
        self._owe_a_save()

    def set(self, key: K, value: V) -> None:
        """The key's value is known: write it, asking for nothing."""
        if self._disposed:
            return
        self._kept.discard(key)
        self._held(key).state.set(Ready(value))
        self._owe_a_save()

    def dispose(self) -> None:
        """End the cache: a save that was owed is made now, every observer's states end, and nothing is fetched or written after.

        Disposing twice is disposing once.
        """
        if self._saving is not None:
            self._saving.cancel()
            self._save()
        self._disposed = True
        for held in self._keys.values():
            held.state.end()
        self._keys.clear()
        self._kept.clear()
