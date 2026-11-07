"""A stream's place in each scope, kept so the next client of the same knowledge base resumes from it.

What that client kept of a scope is then brought up to date by the events
recorded since, replayed.

**The place may lag the caches and never leads them.** A place kept ahead of
a cache would have the next client resume past an event the cache it begins
with never took in. So a place is not written when it is reached. It is
remembered, and written with the next write of a cache, and only when the
gate says every kept cache is at rest and the refresher owes no refetch: a
cache that is still fetching, owes a save, or is still to be asked again has
not taken in the event the place names. A place that is not written is only
late, which costs a replay.

The places are kept as `semiont.stored.LastEventIds`. A pair that is not a
resource's id and a recorded event's id (`is_recorded_event_id`) is no place,
and is skipped; what is kept under the key and is no JSON object is no places.

    places = CoupledBookmarks(storage, last_event_id_key(kb_id))
    transport = HttpTransport(origin, token=token, bookmarks=places)
    client = SemiontClient(
        transport, transport.content, transport, persistence=CachePersistence(storage=places.storage, key_prefix=kb_id)
    )
    places.set_flush_gate(lambda: client.persistence_settled)
"""

from collections.abc import Callable
from typing import Final, TypeGuard, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont._required import fault_of
from semiont.identifiers import ResourceId
from semiont.storage import SessionStorage
from semiont.stored import LastEventIds
from semiont.types import PersistedEventId

__all__ = ["CoupledBookmarks", "is_recorded_event_id"]

_JSON: Final = TypeAdapter[JsonValue](JsonValue)
_PLACES: Final = TypeAdapter[LastEventIds](LastEventIds)


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

        An id that is not a recorded event's is no place, and is not kept.
        """
        if is_recorded_event_id(event_id):
            self._pending[scope] = event_id

    def set_flush_gate(self, at_rest: Callable[[], bool]) -> None:
        """Say when the caches are at rest. With no gate every write of a cache carries what is remembered."""
        self._at_rest = at_rest

    def _flush(self) -> None:
        """Write what is remembered, when the gate allows it."""
        if not self._pending or (self._at_rest is not None and not self._at_rest()):
            return
        reached, self._pending = self._pending, {}
        self._storage.set(self._key, _PLACES.dump_json({**self.load(), **reached}).decode())
