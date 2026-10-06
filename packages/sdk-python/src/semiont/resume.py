"""A stream's place in each scope, kept so the next client of the same knowledge base resumes from it.

What that client kept of a scope is then brought up to date by the events
recorded since, replayed.

**The place may lag the caches and never leads them.** A place kept ahead of
a cache would have the next client resume past an event the cache it begins
with never took in. So a place is not written when it is reached. It is
remembered, and written with the next write of a cache, and only when the
gate says every kept cache is at rest: one that is still fetching, or owes a
save, has not taken in the event the place names. A place that is not written
is only late, which costs a replay.

What is kept under the key and is not places reads as nothing kept.

    places = CoupledBookmarks(storage, f"semiont.lastEventId.{kb_id}")
    transport = HttpTransport(origin, token=token, bookmarks=places)
    client = SemiontClient(
        transport, transport.content, transport, persistence=CachePersistence(storage=places.storage, key_prefix=kb_id)
    )
    places.set_flush_gate(lambda: client.persistence_settled)
"""

from collections.abc import Callable
from typing import Final, final, override

from pydantic import TypeAdapter, ValidationError

from semiont.identifiers import ResourceId
from semiont.storage import SessionStorage

__all__ = ["CoupledBookmarks"]

_PLACES: Final = TypeAdapter[dict[ResourceId, str]](dict[ResourceId, str])


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


@final
class CoupledBookmarks:
    """See the module's documentation. Places kept in `storage` under `key`."""

    def __init__(self, storage: SessionStorage, key: str) -> None:
        self._storage: Final = storage
        self._key: Final = key
        self._pending: dict[ResourceId, str] = {}
        """The places reached and not yet written."""
        self._at_rest: Callable[[], bool] | None = None
        self.storage: Final[SessionStorage] = _Carrying(storage, self._flush)
        """The storage to give the caches: what they write goes to the storage beneath, and carries the places with it."""

    def load(self) -> dict[ResourceId, str]:
        """The places kept, by scope."""
        stored = self._storage.get(self._key)
        if stored is None:
            return {}
        try:
            return _PLACES.validate_json(stored)
        except ValidationError:
            return {}

    def save(self, scope: ResourceId, event_id: str) -> None:
        """A place was reached in `scope`. Remembered, and written with a later write of a cache."""
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
