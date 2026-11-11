"""A read-through cache: what a client's live queries answer from (`protocol/contract/CACHE-SEMANTICS.md`, B1 to B20).

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
value that is known, and lets go of the fetch in flight; `patch` writes part of
one, and is kept with that fetch to be applied to its answer; `remove` ends a
key whose entity is gone. `dispose` is terminal: every observer's states end,
and nothing is fetched, retried or failed after it.

A cache with a `CachePersister` begins with what was kept and saves its values
as they change. A value that was kept is shown at once and asked for again the
first time it is observed: nothing says it is still true. One given its
persister after it began (`attach`) takes what was kept only for the keys it
holds nothing for, alike. A save the persister refuses is still owed: the next
change, or disposal, makes it.

An observer that falls behind is given the latest state, not each one it
missed: a state is what is true now.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Hashable, Mapping
from dataclasses import dataclass, field
from typing import Final, Literal, Protocol, final, override

from semiont.errors import BusRequestError
from semiont.state_unit import StateUnit
from semiont.timing import SAVE_DEBOUNCE_MS
from semiont.watched import Variable

__all__ = ["Cache", "CachePersister", "CacheState", "Failed", "Pending", "Ready", "Runs", "closed"]


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
    """No value, and the fetch for one failed, and failed again: `error` is what the second failed with, whatever it was."""

    error: Exception
    status: Literal["failed"] = field(default="failed", init=False)


type CacheState[T] = Pending | Ready[T] | Failed
"""The state of a key. A `match` over one names all three."""


class CachePersister[K, V](Protocol):
    """Where a cache keeps its values so a later one begins with them."""

    def load(self) -> Mapping[K, V] | None:
        """What was kept, asked once, when the cache is given the persister."""
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
class _Flight[V]:
    """A key's current fetch, and what goes with it when it is let go of."""

    def __init__(self, number: int, task: asyncio.Task[V]) -> None:
        self.number: Final = number
        self.task: Final = task
        self.ask: Literal["first", "retry"] | None = None
        """Which of the live view's asks it is (B14); nothing when no ask waits on it."""
        self.patches: Final[list[Callable[[V], V]]] = []
        """The patches made while it was in flight, to apply to its answer in the order made (B13b)."""


@final
class _Key[V]:
    def __init__(self, state: CacheState[V]) -> None:
        self.state: Final = Variable[CacheState[V]](state)
        self.in_flight: _Flight[V] | None = None
        """The key's current fetch. An `invalidate`, a `set` or a `remove` lets
        go of it without waiting, so a fetch whose answer will never come
        cannot hold the key, and one let go of writes nothing (B9)."""

    def known(self) -> bool:
        """Whether anything asked for the key and has not let go of it."""
        return self.in_flight is not None or not isinstance(self.state.value, Pending)


def _heard(fetch: asyncio.Task[object]) -> None:
    """Retrieve a fetch's failure, which its key (`Cache._failed`) and each awaiter are told: asyncio logs one nobody retrieved."""
    if not fetch.cancelled():
        fetch.exception()


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
class Cache[K: Hashable, V](StateUnit):
    """See the module's documentation.

    `fetch` asks for a key's value, and whatever it fails with is the key's
    failure. `tasks` runs the fetches. With a `persister`, the cache begins
    with what it kept, and saves its values there once they have stopped
    changing for `save_debounce_ms`. One made without is given its persister
    later with `attach`.
    """

    def __init__(
        self,
        fetch: Callable[[K], Awaitable[V]],
        *,
        tasks: Runs,
        persister: CachePersister[K, V] | None = None,
        save_debounce_ms: int = SAVE_DEBOUNCE_MS,
    ) -> None:
        self._fetch: Final = fetch
        self._tasks: Final = tasks
        self._persister: CachePersister[K, V] | None = None
        self._save_debounce_ms: Final = save_debounce_ms
        self._disposed = False
        self._fetches = 0
        self._saving: asyncio.TimerHandle | None = None
        """The wait before the next save."""
        self._owed = False
        """Whether the values changed since the persister last took them."""
        self._keys: Final[dict[K, _Key[V]]] = {}
        self._kept: Final[set[K]] = set()
        """Keys whose value was kept by an earlier cache and has not been asked for by this one."""
        if persister is not None:
            self.attach(persister)

    def attach(self, persister: CachePersister[K, V]) -> None:
        """Keep the cache's values with `persister` from now on, beginning with what it kept.

        What a client does with the caches it keeps for a person, when it
        learns who they are only after it began. A kept value fills only a key
        the cache holds nothing for, and is asked for anew the first time it is
        observed. What the cache holds is saved there from its next change. A
        cache keeps its values with one persister: a second raises
        `RuntimeError`. A disposed cache takes none.
        """
        if self._disposed:
            return
        if self._persister is not None:
            raise RuntimeError("a cache keeps its values with one persister")
        self._persister = persister
        kept = persister.load()
        if kept is None:
            return
        for key, value in kept.items():
            held = self._keys.get(key)
            if held is None or not held.known():
                self._held(key).state.set(Ready(value))
                self._kept.add(key)

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
        self._owed = True
        if self._saving is not None:
            self._saving.cancel()
        self._saving = asyncio.get_running_loop().call_later(self._save_debounce_ms / 1000, self._save)

    def _save(self) -> None:
        """Give the persister the values. One it refuses is still owed, and its refusal is raised."""
        self._saving = None
        if self._persister is None:
            return
        # Owed no longer while the persister writes: a place riding this write (`semiont.resume`) is held back by what else is owed.
        self._owed = False
        try:
            self._persister.save(self._values())
        except BaseException:
            self._owed = True
            raise

    def _fetching(self, key: K) -> _Flight[V]:
        """Start a fetch for `key`, or join the one in flight."""
        # Asked for by this cache now, whichever path asked.
        self._kept.discard(key)
        held = self._held(key)
        if held.in_flight is None:
            self._fetches += 1
            fetch = self._tasks.run(self._fetched(key, self._fetches))
            fetch.add_done_callback(_heard)
            held.in_flight = _Flight(self._fetches, fetch)
        return held.in_flight

    async def _fetched(self, key: K, number: int) -> V:
        try:
            value = await self._fetch(key)
        except Exception as failure:
            self._failed(key, number, failure)
            raise
        except BaseException:
            # A cancellation is no failure: nothing is asked again after it.
            self._settling(key, number)
            raise
        return self._landed(key, number, value)

    def _settling(self, key: K, number: int) -> tuple[_Key[V], _Flight[V]] | None:
        """The key, and its fetch numbered `number`, in the step that fetch settles, if it is still the key's current one.

        From that step it is in flight no more. A fetch an invalidate, a set, a
        removal or the disposal let go of is not the key's: it answers its own
        awaiters, and changes nothing (B9).
        """
        held = self._keys.get(key)
        if held is None or held.in_flight is None or held.in_flight.number != number:
            return None
        flight, held.in_flight = held.in_flight, None
        return held, flight

    def _landed(self, key: K, number: int, value: V) -> V:
        """What a fetch's awaiters are given: its answer, with the patches kept with it applied in the order made (B13b).

        The key stores it while the fetch is its current one.
        """
        settling = self._settling(key, number)
        if settling is None:
            return value
        held, flight = settling
        for change in flight.patches:
            value = change(value)
        held.state.set(Ready(value))
        self._owe_a_save()
        return value

    def _failed(self, key: K, number: int, failure: Exception) -> None:
        """A fetch failed: the live view's first ask is asked once more, at once (B14); a second that failed fails a key with no value.

        So the key is fetching from its first failure until its retry settles.
        The patches kept with the fetch go with it (B13b): the retry is asked
        after their events arrived, so its answer holds them.
        """
        settling = self._settling(key, number)
        if settling is None:
            return
        held, flight = settling
        if flight.ask == "first":
            self._fetching(key).ask = "retry"
        elif flight.ask == "retry" and not isinstance(held.state.value, Ready):
            held.state.set(Failed(failure))

    def _revalidate(self, key: K) -> None:
        """Fetch for the live view: a failure is tried once more, and a key with no value whose retry also fails becomes `Failed`."""
        self._fetching(key).ask = "first"

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

        What the service answers, with the patches made meanwhile, which every
        observer of the key is given too unless an invalidate, a set or a
        removal let go of the fetch first; or the failure, which only this
        caller is. Concurrent asks for one key share one fetch.
        """
        if self._disposed:
            raise closed()
        return await _joined(self._fetching(key).task)

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

    def _fetch_in_flight(self) -> bool:
        return any(held.in_flight is not None for held in self._keys.values())

    @property
    def persistence_pending(self) -> bool:
        """Whether a cache that keeps its values has not yet kept what it knows: a fetch is in flight, or a save is owed.

        A save the persister refused is owed until it is made.
        """
        return self._persister is not None and (self._owed or self._fetch_in_flight())

    @property
    def kept_fetching(self) -> bool:
        """Whether a cache that keeps its values has a fetch in flight: what a disposal drops.

        A key's current fetch is in flight from when it is asked for, before
        its first turn, until its answer is written, in the same turn, or it
        fails. One an invalidate, a set or a removal let go of is in flight no
        more.
        """
        return self._persister is not None and self._fetch_in_flight()

    def invalidate(self, key: K) -> None:
        """The key's value is out of date: ask again, showing what there is meanwhile.

        A fetch already in flight is not waited on: its answer may never come,
        and when it does it goes to that fetch's own awaiters alone.
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

    def remove(self, key: K, gone: Exception) -> None:
        """The key's entity is gone: its value is dropped and the key is failed with `gone`, at once, for every observer.

        Nothing is asked for, and a fetch in flight is let go of: what it answers goes to its own awaiters alone.
        """
        if self._disposed:
            return
        held = self._held(key)
        held.in_flight = None
        held.state.set(Failed(gone))
        self._owe_a_save()

    def set(self, key: K, value: V) -> None:
        """The key's value is known: write it, asking for nothing.

        A fetch in flight is let go of, as a removal lets it go (B13b): it was
        asked before the write, so its answer can be the value the write
        replaced. What it answers goes to its own awaiters alone.
        """
        if self._disposed:
            return
        self._kept.discard(key)
        held = self._held(key)
        held.in_flight = None
        held.state.set(Ready(value))
        self._owe_a_save()

    def patch(self, key: K, change: Callable[[V], V]) -> None:
        """Write part of the key's value: `change` takes the value to the patched one (B13b).

        It is applied to the value now, if the key has one. A fetch in flight
        can hold what the patch does not, so the patch lets go of nothing: it
        is kept with that fetch, and applied to its answer after those made
        before it. A key with neither a value nor a fetch in flight is left as
        it is (B20). A value an earlier cache kept stays one (B18): the rest
        of it is not known to be current.
        """
        if self._disposed:
            return
        held = self._keys.get(key)
        if held is None:
            return
        if held.in_flight is not None:
            held.in_flight.patches.append(change)
        state = held.state.value
        if isinstance(state, Ready):
            held.state.set(Ready(change(state.value)))
            self._owe_a_save()

    @override
    def dispose(self) -> None:
        """End the cache: a save that was owed is made now, every observer's states end, and nothing is fetched or written after.

        Disposing twice is disposing once. A save the persister refuses is raised, and the cache has ended all the same.
        """
        if self._disposed:
            return
        if self._saving is not None:
            self._saving.cancel()
            self._saving = None
        try:
            if self._owed:
                self._save()
        finally:
            self._disposed = True
            for held in self._keys.values():
                held.state.end()
            self._keys.clear()
            self._kept.clear()
