"""Where a client keeps what must outlive it: text under a key.

The seam an application fills in (a file, a platform's store), so nothing
above it knows where it runs. `MemoryStorage` keeps it for as long as the
process lives: a client that closes and one that opens after it, over the
same storage, are a reload.

More than one context can write a store: two windows, two processes. What is
written from what was read goes through `update`, which a store makes one
step, so one writer's change is never lost under another's; and a store that
hears what another context writes says so to whoever `subscribe`s.

`StoragePersister` keeps one cache's values there, as one document under one
key (`cacheDocument` of `protocol/specs/src/session/stored.json`):
`{version, entries}`, each entry a key, its value, and when that value was
received. A document whose structure is not that one reads as nothing kept,
and an entry whose key or value is not the cache's is skipped. A document
larger than it may be loses the entries received longest ago, until it fits.
"""

import time
from collections.abc import Callable, Hashable, Mapping
from typing import Final, Protocol, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.cache import CachePersister
from semiont.stored import CACHE_DOCUMENT_VERSION

__all__ = ["MemoryStorage", "SessionStorage", "StoragePersister"]


class SessionStorage(Protocol):
    """A store of text by key."""

    def get(self, key: str) -> str | None:
        """What is stored under `key`, when anything is."""
        ...

    def set(self, key: str, value: str) -> None:
        """Store `value` under `key`, in place of what was there."""
        ...

    def delete(self, key: str) -> None:
        """Remove a key. One that is not there is left not there."""
        ...

    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        """Change a key's value as one step.

        `change` is given what is stored, nothing when nothing is, and says
        what is stored next, nothing for nothing. No other writer's change
        falls between the read and the write.
        """
        ...

    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        """Hear what another context writes: another process, another window.

        `on_change` is given the key, and the value written, or nothing when
        the key was removed. The answer ends the subscription. Nothing where
        the environment has no other context: a client then works correctly
        within its own.
        """
        ...


@final
class MemoryStorage(SessionStorage):
    """A `SessionStorage` kept in memory. No other context writes it."""

    def __init__(self) -> None:
        self._stored: Final[dict[str, str]] = {}

    @override
    def get(self, key: str) -> str | None:
        return self._stored.get(key)

    @override
    def set(self, key: str, value: str) -> None:
        self._stored[key] = value

    @override
    def delete(self, key: str) -> None:
        self._stored.pop(key, None)

    @override
    def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
        after = change(self._stored.get(key))
        if after is None:
            self._stored.pop(key, None)
        else:
            self._stored[key] = after

    @override
    def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
        return None


_JSON: Final = TypeAdapter[JsonValue](JsonValue)


def _whole(number: JsonValue) -> int | None:
    """`number` as the whole number it is, however it is written (`1000`, `1000.0`, `1e3`).

    Nothing when it is no number, or has a fraction. A bool is no number.
    """
    match number:
        case bool():
            return None
        case int():
            return number
        case float() if number.is_integer():
            return int(number)
        case _:
            return None


def _entries(raw: str) -> list[tuple[JsonValue, JsonValue, int]] | None:
    """The entries of a document: each its key, its value, and when the value was received.

    Nothing when the document's structure is not `cacheDocument`'s.
    """
    try:
        document = _JSON.validate_json(raw)
    except ValidationError:
        return None
    if not isinstance(document, dict):
        return None
    version, stored = document.get("version"), document.get("entries")
    if _whole(version) != CACHE_DOCUMENT_VERSION or not isinstance(stored, list):
        return None
    entries: list[tuple[JsonValue, JsonValue, int]] = []
    for entry in stored:
        if not isinstance(entry, list) or len(entry) != 3:
            return None
        key, value, written = entry
        stamp = _whole(written)
        if stamp is None or stamp < 0:
            return None
        entries.append((key, value, stamp))
    return entries


@final
class StoragePersister[K: Hashable, V](CachePersister[K, V]):
    """A cache's values in `storage`, under `storage_key`.

    `key` and `value` say how each is read and written, and `max_bytes` how
    large the document may be.
    """

    def __init__(self, storage: SessionStorage, storage_key: str, *, key: TypeAdapter[K], value: TypeAdapter[V], max_bytes: int) -> None:
        self._storage: Final = storage
        self._storage_key: Final = storage_key
        self._key: Final = key
        self._value: Final = value
        self._max_bytes: Final = max_bytes
        self._written: dict[str, tuple[str, int]] = {}
        """Each key's value as last written, and when it was received: an entry whose value has not changed keeps its time."""

    def _texts(self, key: K, value: V) -> tuple[str, str]:
        """An entry's key and value as the document writes them."""
        key_text = _JSON.dump_json(self._key.dump_python(key, mode="json")).decode()
        return key_text, _JSON.dump_json(self._value.dump_python(value, mode="json", exclude_unset=True)).decode()

    @override
    def load(self) -> Mapping[K, V] | None:
        raw = self._storage.get(self._storage_key)
        entries = None if raw is None else _entries(raw)
        if entries is None:
            return None
        kept: dict[K, V] = {}
        written: dict[str, tuple[str, int]] = {}
        for stored_key, stored_value, stamp in entries:
            try:
                # An entry that is not this cache's shape is one it never kept.
                key, value = self._key.validate_python(stored_key), self._value.validate_python(stored_value)
            except ValidationError:
                continue
            kept[key] = value
            key_text, value_text = self._texts(key, value)
            written[key_text] = (value_text, stamp)
        self._written = written
        return kept

    @override
    def save(self, entries: Mapping[K, V]) -> None:
        now = int(time.time() * 1000)
        stored: list[tuple[str, str, int]] = []
        for key, value in entries.items():
            key_text, value_text = self._texts(key, value)
            before = self._written.get(key_text)
            stored.append((key_text, value_text, before[1] if before is not None and before[0] == value_text else now))

        def document() -> bytes:
            kept = ",".join(f"[{key_text},{value_text},{at}]" for key_text, value_text, at in stored)
            return f'{{"version":{CACHE_DOCUMENT_VERSION},"entries":[{kept}]}}'.encode()

        text = document()
        if len(text) > self._max_bytes:
            # The entries that have gone longest without a new value are the first to go.
            stored.sort(key=lambda entry: entry[2])
            while stored and len(text) > self._max_bytes:
                del stored[0]
                text = document()
        self._written = {key_text: (value_text, at) for key_text, value_text, at in stored}
        self._storage.set(self._storage_key, text.decode())
