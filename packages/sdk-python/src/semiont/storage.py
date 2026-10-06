"""Where a client keeps what must outlive it: text under a key.

The seam an application fills in (a file, a platform's store), so nothing
above it knows where it runs. `MemoryStorage` keeps it for as long as the
process lives: a client that closes and one that opens after it, over the
same storage, are a reload.

`StoragePersister` keeps one cache's values there, as one document under one
key: `{version, writtenAt, entries}`, each entry a key, its value, and when
that value was last written. A document of another version, or one that does
not parse, reads as nothing kept. A document larger than it may be loses the
entries that have gone longest without a new value, until it fits.
"""

import time
from collections.abc import Hashable, Mapping
from typing import Final, Protocol, final, override

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.cache import CachePersister

__all__ = ["MAX_STORED_BYTES", "MemoryStorage", "SessionStorage", "StoragePersister"]


MAX_STORED_BYTES: Final = 2 * 1024 * 1024
"""The largest document a client's cache keeps, in bytes."""


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


@final
class MemoryStorage(SessionStorage):
    """A `SessionStorage` kept in memory."""

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


_DOCUMENT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])
_JSON: Final = TypeAdapter[JsonValue](JsonValue)


@final
class StoragePersister[K: Hashable, V](CachePersister[K, V]):
    """A cache's values in `storage`, under `storage_key`.

    `key` and `value` say how each is read and written, `version` which
    documents are this cache's to read, and `max_bytes` how large the
    document may be.
    """

    def __init__(
        self, storage: SessionStorage, storage_key: str, *, key: TypeAdapter[K], value: TypeAdapter[V], version: int, max_bytes: int
    ) -> None:
        self._storage: Final = storage
        self._storage_key: Final = storage_key
        self._key: Final = key
        self._value: Final = value
        self._version: Final = version
        self._max_bytes: Final = max_bytes
        self._written: dict[str, tuple[str, int]] = {}
        """Each key's value as last written, and when: an entry whose value has not changed keeps its time."""

    @override
    def load(self) -> Mapping[K, V] | None:
        raw = self._storage.get(self._storage_key)
        if raw is None:
            return None
        try:
            document = _DOCUMENT.validate_json(raw)
        except ValidationError:
            return None
        stored = document.get("entries")
        if document.get("version") != self._version or not isinstance(stored, list):
            return None
        kept: dict[K, V] = {}
        written: dict[str, tuple[str, int]] = {}
        for entry in stored:
            if not isinstance(entry, list) or len(entry) != 3 or isinstance(entry[2], bool) or not isinstance(entry[2], int):
                continue
            try:
                # An entry that is not this cache's shape is one it never kept.
                kept[self._key.validate_python(entry[0])] = self._value.validate_python(entry[1])
            except ValidationError:
                continue
            written[_JSON.dump_json(entry[0]).decode()] = (_JSON.dump_json(entry[1]).decode(), entry[2])
        self._written = written
        return kept

    @override
    def save(self, entries: Mapping[K, V]) -> None:
        now = int(time.time() * 1000)
        stored: list[tuple[str, str, int]] = []
        for key, value in entries.items():
            key_text = _JSON.dump_json(self._key.dump_python(key, mode="json")).decode()
            value_text = _JSON.dump_json(self._value.dump_python(value, mode="json", exclude_unset=True)).decode()
            before = self._written.get(key_text)
            stored.append((key_text, value_text, before[1] if before is not None and before[0] == value_text else now))

        def document() -> bytes:
            kept = ",".join(f"[{key_text},{value_text},{at}]" for key_text, value_text, at in stored)
            return f'{{"version":{self._version},"writtenAt":{now},"entries":[{kept}]}}'.encode()

        text = document()
        if len(text) > self._max_bytes:
            # The entries that have gone longest without a new value are the first to go.
            stored.sort(key=lambda entry: entry[2])
            while stored and len(text) > self._max_bytes:
                del stored[0]
                text = document()
        self._written = {key_text: (value_text, at) for key_text, value_text, at in stored}
        self._storage.set(self._storage_key, text.decode())
