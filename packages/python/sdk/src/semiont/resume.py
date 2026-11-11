"""A stream's place in each scope, kept so the person's next client of the same knowledge base resumes from it.

What that client kept of a scope is then brought up to date by the events
recorded since, replayed.

**The place may lag the caches and never leads them.** A place kept ahead of
a cache would have the next client resume past an event the cache it begins
with never took in. So a place is not written when it is reached. It is
remembered, and written with the next write of a cache, and only when the
client the places are coupled to (`couple_to`) is at rest: no kept cache is
fetching or owes a save, and the refresher owes no refetch. A cache that is
still fetching, owes a save, or is still to be asked again has not taken in
the event the place names. The client's close reads that once, before it
disposes anything: the places reached until then ride the saves the close
makes only if no kept cache was fetching and no refetch was owed, since
closing drops both, and a place reached after is not kept. A place that is
not written is only late, which costs a replay.

The places are kept as `semiont.stored.LastEventIds`. A pair that is not a
resource's id and a recorded event's id (`is_recorded_event_id`) is no place,
and is skipped; what is kept under the key and is no JSON object is no places.

    places = CoupledBookmarks(storage, last_event_id_key(kb_id, person))
    transport = HttpTransport(origin, token=token, channels=BRIDGED_CHANNELS, bookmarks=places)
    persistence = CachePersistence(storage=places.storage, kb_id=kb_id, person_key=person)
    client = SemiontClient(transport, transport.content, transport, persistence=persistence)
    places.couple_to(client)
"""

from collections.abc import Callable
from typing import Final, Protocol, TypeGuard, final, override
from weakref import WeakKeyDictionary

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont._required import fault_of
from semiont.identifiers import ResourceId
from semiont.storage import SessionStorage
from semiont.stored import LastEventIds
from semiont.types import PersistedEventId

__all__ = ["CoupledBookmarks", "is_recorded_event_id"]

_JSON: Final = TypeAdapter[JsonValue](JsonValue)
_PLACES: Final = TypeAdapter[LastEventIds](LastEventIds)


class _Coupled(Protocol):
    """A client, as places coupled to it read it (`semiont.client.SemiontClient`)."""

    @property
    def persistence_settled(self) -> bool: ...


_SEALS: Final = WeakKeyDictionary[_Coupled, Callable[[bool], None]]()
"""What each client's close tells whether the places coupled to it may ride the saves it makes, until that close."""


def seal_coupled_places(client: _Coupled, settled: bool) -> None:
    """What a client's close calls, before it disposes anything: the places coupled to it keep only what was reached before, if `settled`.

    Its close drops a kept cache's fetch in flight and a refetch owed, so
    either holds the places back from the saves it makes; a save owed does
    not, since the close makes it. A client with no places coupled to it
    seals none.
    """
    if client in _SEALS:
        _SEALS.pop(client)(settled)


def is_recorded_event_id(event_id: JsonValue) -> TypeGuard[str]:
    """Whether `event_id` is a recorded event's id (`PersistedEventId`): a scope's place, which a stream resumes from."""
    return fault_of(PersistedEventId, event_id) is None


@final
class _Carrying(SessionStorage):
    """The storage beneath, where each write carries the places with it."""

    def __init__(self, storage: SessionStorage, flush: Callable[[], None]) -> None:
        self._storage: Final = storage
        self._flush: Final = flush

    @override
    def get(self, key: str) -> str | None:
        return self._storage.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        self._storage.set(key, value)
        self._flush()

    @override
    def delete(self, key: str) -> None:
        self._storage.delete(key)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        self._storage.update(key, change)
        self._flush()

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        return self._storage.subscribe(on_change)


@final
class CoupledBookmarks:
    """See the module's documentation. Places kept in `storage` under `key`."""

    def __init__(self, storage: SessionStorage, key: str) -> None:
        self._storage: Final = storage
        self._key: Final = key
        self._pending: LastEventIds = {}
        """The places reached and not yet written."""
        self._at_rest: Callable[[], bool] | None = None
        """Whether the client the places are coupled to is at rest: with none, every write of a cache carries what is remembered."""
        self._sealed = False
        """Whether the client's close has read whether it was at rest: what is remembered is then written with the next write of a cache."""
        self.storage: Final[SessionStorage] = _Carrying(storage, self._flush)
        """The storage to give the caches: what they write goes to the storage beneath, and carries the places with it."""

    def load(self) -> LastEventIds:
        """The places kept, by scope."""
        stored = self._storage.get(self._key)
        if stored is None:
            return {}
        try:
            places = _JSON.validate_json(stored)
        except ValidationError:
            return {}
        kept: LastEventIds = {}
        if isinstance(places, dict):
            for scope, place in places.items():
                resource = ResourceId.parse(scope)
                if resource is not None and is_recorded_event_id(place):
                    kept[resource] = place
        return kept

    def save(self, scope: ResourceId, event_id: str) -> None:
        """A place was reached in `scope`. Remembered, and written with a later write of a cache.

        An id that is not a recorded event's is no place, and is not kept;
        nor is a place reached once the coupled client's close has begun.
        """
        if is_recorded_event_id(event_id) and not self._sealed:
            self._pending[scope] = event_id

    def couple_to(self, client: _Coupled) -> None:
        """Write places only while `client` is at rest, and once its close has begun, only those reached before, if it was at rest then.

        A client's places are coupled once: a second coupling raises `RuntimeError`.
        """
        if client in _SEALS:
            raise RuntimeError("a client's places are coupled once")
        self._at_rest = lambda: client.persistence_settled
        _SEALS[client] = self._seal

    def _seal(self, settled: bool) -> None:
        """The coupled client's close read whether it was `settled`: what is remembered is kept only if it was."""
        if self._sealed:
            return
        self._sealed = True
        if not settled:
            self._pending = {}

    def _flush(self) -> None:
        """Write what is remembered, when the coupled client is at rest, or its close said it was."""
        if not self._pending or (not self._sealed and self._at_rest is not None and not self._at_rest()):
            return
        reached, self._pending = self._pending, {}
        self._storage.set(self._key, _PLACES.dump_json({**self.load(), **reached}).decode())
