"""What a client keeps of its queries and of its stream, held to `protocol/specs/src/session/cache-cases.json`.

Every SDK's persister runs that table. Each case runs through the persister
a client keeps the case's query with (`KeptPersisters`), over a storage in
memory, under the key `semiont.stored` gives it. What a load keeps is read
back by that persister's own save, so each value is compared as the document
writes it.
"""

from collections.abc import Hashable
from typing import Final, assert_never

import pytest
from aio import run
from kb import NothingRuns, nothing_fetched
from pydantic import BaseModel, Field, JsonValue, TypeAdapter
from spec import SPEC

from semiont.cache import Cache
from semiont.client import CachePersistence
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.live import KeptPersisters
from semiont.resume import CoupledBookmarks
from semiont.storage import MemoryStorage, StoragePersister
from semiont.stored import KeptQuery, WholeKey, cache_key, last_event_id_key, person_key
from semiont.types import Annotation, GetAnnotationsResponse, ResourceDescriptor, TagSchema

type Entry = tuple[JsonValue, JsonValue]
"""An entry as the table states it: its key as the document writes it, and its value."""


class Stored(BaseModel, frozen=True, extra="forbid"):
    """A load of a document kept as JSON."""

    name: str
    query: KeptQuery
    stored: JsonValue
    kept: list[Entry]


class StoredText(BaseModel, frozen=True, extra="forbid"):
    """A load of text kept as it is."""

    name: str
    query: KeptQuery
    stored_text: str = Field(alias="storedText")
    kept: list[Entry]


class Written(BaseModel, frozen=True, extra="forbid"):
    version: int
    entries: list[Entry]


class Write(BaseModel, frozen=True, extra="forbid"):
    """A save of what a cache holds once its answers came."""

    name: str
    query: KeptQuery
    held: list[Entry]
    written: Written


class StoredPlaces(BaseModel, frozen=True, extra="forbid"):
    name: str
    stored: JsonValue
    kept: dict[ResourceId, str]


class StoredPlacesText(BaseModel, frozen=True, extra="forbid"):
    name: str
    stored_text: str = Field(alias="storedText")
    kept: dict[ResourceId, str]


class Table(BaseModel, frozen=True, extra="forbid"):
    comment: str = Field(alias="$comment")
    run_by: dict[str, list[str]] = Field(alias="runBy")
    cases: list[Stored | StoredText]
    writes: list[Write]
    places: list[StoredPlaces | StoredPlacesText]


TABLE: Final = Table.model_validate_json((SPEC / "session/cache-cases.json").read_bytes())

KB: Final = "kb"
"""The knowledge base whose queries and places are kept."""
PERSON: Final = person_key("did:web:example.org:users:alice")
"""The person they are kept for."""

_JSON: Final = TypeAdapter[JsonValue](JsonValue)
_RESOURCE_ID: Final = TypeAdapter(ResourceId)
_ANNOTATION_ID: Final = TypeAdapter(AnnotationId)
_WHOLE_KEY: Final = TypeAdapter[WholeKey](WholeKey)


def by_key(entries: list[Entry]) -> dict[str, JsonValue]:
    """Entries by their key's JSON: the table's are compared as a map, as their order is no part of the rule."""
    return {_JSON.dump_json(key).decode(): value for key, value in entries}


def persisters(storage: MemoryStorage) -> KeptPersisters:
    return KeptPersisters(CachePersistence(storage=storage, kb_id=KB, person_key=PERSON))


def written_under(storage: MemoryStorage, query: KeptQuery) -> dict[str, JsonValue]:
    """The document kept under `query`'s key, each of its stamps held to be one."""
    stored = storage.get(cache_key(KB, PERSON, query))
    assert stored is not None, f"nothing is kept under {query}'s key"
    document = _JSON.validate_json(stored)
    assert isinstance(document, dict)
    entries = document["entries"]
    assert isinstance(entries, list)
    for entry in entries:
        assert isinstance(entry, list)
        assert len(entry) == 3
        stamp = entry[2]
        assert isinstance(stamp, int)
        assert not isinstance(stamp, bool)
        assert stamp >= 0
    return document


def entries_of(document: dict[str, JsonValue]) -> dict[str, JsonValue]:
    entries = document["entries"]
    assert isinstance(entries, list)
    return by_key([(entry[0], entry[1]) for entry in entries if isinstance(entry, list)])


def read_back[K: Hashable, V](persister: StoragePersister[K, V], storage: MemoryStorage, query: KeptQuery) -> dict[str, JsonValue]:
    """What `persister` keeps of what is kept under `query`'s key, as its own save writes it back."""
    kept = persister.load()
    if kept is None:
        return {}
    persister.save(kept)
    return entries_of(written_under(storage, query))


def kept_of(query: KeptQuery, storage: MemoryStorage) -> dict[str, JsonValue]:
    """What the client's persister for `query` keeps of what `storage` holds."""
    kept = persisters(storage)
    match query:
        case "resource":
            return read_back(kept.resource, storage, query)
        case "annotations":
            return read_back(kept.annotations, storage, query)
        case "annotation":
            return read_back(kept.annotation, storage, query)
        case "entityTypes":
            return read_back(kept.entity_types, storage, query)
        case "tagSchemas":
            return read_back(kept.tag_schemas, storage, query)
        case _:
            assert_never(query)


def hold[K: Hashable, V](persister: StoragePersister[K, V], key: TypeAdapter[K], value: TypeAdapter[V], held: list[Entry]) -> None:
    """A cache that keeps its values with `persister` holds `held`, and ends: what it owed is saved."""
    cache = Cache[K, V](nothing_fetched, tasks=NothingRuns(), persister=persister)
    for each_key, each_value in held:
        cache.set(key.validate_python(each_key), value.validate_python(each_value))
    cache.dispose()


def held_by(query: KeptQuery, storage: MemoryStorage, held: list[Entry]) -> None:
    """The client's cache of `query`, kept in `storage`, holds `held`, and ends."""
    kept = persisters(storage)
    match query:
        case "resource":
            hold(kept.resource, _RESOURCE_ID, TypeAdapter(ResourceDescriptor), held)
        case "annotations":
            hold(kept.annotations, _RESOURCE_ID, TypeAdapter(GetAnnotationsResponse), held)
        case "annotation":
            hold(kept.annotation, _ANNOTATION_ID, TypeAdapter(Annotation), held)
        case "entityTypes":
            hold(kept.entity_types, _WHOLE_KEY, TypeAdapter[list[str]](list[str]), held)
        case "tagSchemas":
            hold(kept.tag_schemas, _WHOLE_KEY, TypeAdapter[list[TagSchema]](list[TagSchema]), held)
        case _:
            assert_never(query)


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.name)
def test_a_load_keeps_what_the_shared_table_states(case: Stored | StoredText) -> None:
    storage = MemoryStorage()
    storage.set(
        cache_key(KB, PERSON, case.query), case.stored_text if isinstance(case, StoredText) else _JSON.dump_json(case.stored).decode()
    )
    assert kept_of(case.query, storage) == by_key(case.kept)


@pytest.mark.parametrize("case", TABLE.writes, ids=lambda case: case.name)
def test_a_save_writes_what_the_shared_table_states(case: Write) -> None:
    storage = MemoryStorage()

    async def scenario() -> None:
        held_by(case.query, storage, case.held)

    run(scenario())
    written = written_under(storage, case.query)
    assert set(written) == set(case.written.model_dump())
    assert written["version"] == case.written.version
    assert entries_of(written) == by_key(case.written.entries)


@pytest.mark.parametrize("case", TABLE.places, ids=lambda case: case.name)
def test_a_load_of_the_streams_places_keeps_what_the_shared_table_states(case: StoredPlaces | StoredPlacesText) -> None:
    storage = MemoryStorage()
    key = last_event_id_key(KB, PERSON)
    storage.set(key, case.stored_text if isinstance(case, StoredPlacesText) else _JSON.dump_json(case.stored).decode())
    assert CoupledBookmarks(storage, key).load() == case.kept
