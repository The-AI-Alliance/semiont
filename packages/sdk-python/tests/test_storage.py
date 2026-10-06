"""Where a client keeps what must outlive it: text under a key, and one cache's values as one document there."""

import pytest
from kb import RESOURCE, descriptor
from pydantic import JsonValue, TypeAdapter

from semiont.identifiers import ResourceId
from semiont.storage import MAX_STORED_BYTES, MemoryStorage, StoragePersister
from semiont.types import ResourceDescriptor

KEY = "semiont.cache.kb.resource"
_JSON = TypeAdapter[JsonValue](JsonValue)


def persister(
    storage: MemoryStorage, version: int = 1, max_bytes: int = MAX_STORED_BYTES
) -> StoragePersister[ResourceId, ResourceDescriptor]:
    return StoragePersister(
        storage, KEY, key=TypeAdapter(ResourceId), value=TypeAdapter(ResourceDescriptor), version=version, max_bytes=max_bytes
    )


def at(monkeypatch: pytest.MonkeyPatch, milliseconds: int) -> None:
    """Make it `milliseconds` since the epoch."""
    monkeypatch.setattr("semiont.storage.time.time", lambda: milliseconds / 1000)


def test_storage_in_memory_holds_text_by_key() -> None:
    storage = MemoryStorage()
    assert storage.get("a") is None
    storage.set("a", "one")
    storage.set("b", "two")
    storage.set("a", "three")
    assert (storage.get("a"), storage.get("b")) == ("three", "two")
    storage.delete("a")
    storage.delete("never there")
    assert (storage.get("a"), storage.get("b")) == (None, "two")


def test_a_caches_values_are_kept_as_one_document_as_the_wire_had_them_and_come_back_as_they_were(monkeypatch: pytest.MonkeyPatch) -> None:
    storage = MemoryStorage()
    assert persister(storage).load() is None

    # A description as the knowledge base gave it: with a member the schema does not name, and without those it left out.
    said = {**descriptor(RESOURCE), "addedByALaterRelease": {"kept": True}}
    resource = ResourceDescriptor.model_validate(said)
    at(monkeypatch, 1_000)
    persister(storage).save({RESOURCE: resource})
    stored = storage.get(KEY)
    assert stored is not None
    assert _JSON.validate_json(stored) == {"version": 1, "writtenAt": 1_000, "entries": [[RESOURCE, said, 1_000]]}

    kept = persister(storage).load()
    assert kept is not None
    assert kept == {RESOURCE: resource}
    assert isinstance(next(iter(kept)), ResourceId)
    # What it left out is still left out, so it is written back as it came.
    assert kept[RESOURCE].model_fields_set == resource.model_fields_set
    assert kept[RESOURCE].model_dump(mode="json", exclude_unset=True) == said


def test_an_entry_keeps_the_time_its_value_was_last_written(monkeypatch: pytest.MonkeyPatch) -> None:
    storage = MemoryStorage()
    keeping = persister(storage)
    other = ResourceId("res-2")
    one, two = ResourceDescriptor.model_validate(descriptor(RESOURCE)), ResourceDescriptor.model_validate(descriptor(other))

    def entries() -> JsonValue:
        stored = storage.get(KEY)
        assert stored is not None
        document = _JSON.validate_json(stored)
        assert isinstance(document, dict)
        return [document["writtenAt"], document["entries"]]

    at(monkeypatch, 1_000)
    keeping.save({RESOURCE: one})
    at(monkeypatch, 2_000)
    keeping.save({RESOURCE: one, other: two})
    assert entries() == [2_000, [[RESOURCE, descriptor(RESOURCE), 1_000], [other, descriptor(other), 2_000]]]
    # A value that changed is written now; one that is gone is gone.
    at(monkeypatch, 3_000)
    renamed = ResourceDescriptor.model_validate(descriptor(other, "Renamed"))
    keeping.save({other: renamed})
    assert entries() == [3_000, [[other, descriptor(other, "Renamed"), 3_000]]]

    # The next life's persister knows when each was written from the document, not from having written it.
    at(monkeypatch, 4_000)
    later = persister(storage)
    assert later.load() == {other: renamed}
    later.save({other: renamed, RESOURCE: one})
    assert entries() == [4_000, [[other, descriptor(other, "Renamed"), 3_000], [RESOURCE, descriptor(RESOURCE), 4_000]]]


@pytest.mark.parametrize(
    "stored",
    [
        "not json",
        "[1, 2]",
        '{"version": 2, "writtenAt": 1, "entries": []}',
        '{"version": "1", "writtenAt": 1, "entries": []}',
        '{"writtenAt": 1, "entries": []}',
        '{"version": 1, "writtenAt": 1}',
        '{"version": 1, "writtenAt": 1, "entries": {"res-1": {}}}',
    ],
)
def test_a_document_of_another_version_or_that_does_not_parse_reads_as_nothing_kept(stored: str) -> None:
    storage = MemoryStorage()
    storage.set(KEY, stored)
    assert persister(storage).load() is None
    # And a persister of another version reads this one's as nothing kept.
    storage.set(KEY, '{"version": 1, "writtenAt": 1, "entries": []}')
    assert persister(storage).load() == {}
    assert persister(storage, version=2).load() is None


def test_an_entry_that_is_not_this_caches_shape_is_one_it_never_kept() -> None:
    storage = MemoryStorage()
    good = _JSON.dump_json([RESOURCE, descriptor(RESOURCE), 5]).decode()
    entries = [
        '["not an id", {"@context": "https://schema.org", "@id": "res-9", "name": "n", "representations": []}, 5]',
        '["res-3", {"name": "a description with no id"}, 5]',
        '["res-4", {"@context": "https://schema.org", "@id": "res-4", "name": "n", "representations": []}]',
        '["res-5", {"@context": "https://schema.org", "@id": "res-5", "name": "n", "representations": []}, "when"]',
        '["res-6", {"@context": "https://schema.org", "@id": "res-6", "name": "n", "representations": []}, true]',
        '"res-7"',
        good,
    ]
    storage.set(KEY, '{"version": 1, "writtenAt": 9, "entries": [' + ", ".join(entries) + "]}")
    assert persister(storage).load() == {RESOURCE: ResourceDescriptor.model_validate(descriptor(RESOURCE))}


def test_a_document_too_large_loses_the_entries_that_have_gone_longest_without_a_new_value_until_it_fits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert MAX_STORED_BYTES == 2 * 1024 * 1024
    ids = [ResourceId(f"res-{n}") for n in range(1, 5)]
    values = {each: ResourceDescriptor.model_validate(descriptor(each)) for each in ids}

    def kept(storage: MemoryStorage) -> list[JsonValue]:
        stored = storage.get(KEY)
        assert stored is not None
        document = _JSON.validate_json(stored)
        assert isinstance(document, dict)
        entries = document["entries"]
        assert isinstance(entries, list)
        return [entry[0] for entry in entries if isinstance(entry, list)]

    # How large a document of three of them is, and so the most that keeps three and not four.
    measuring = MemoryStorage()
    at(monkeypatch, 1_000)
    persister(measuring).save({each: values[each] for each in ids[:3]})
    stored = measuring.get(KEY)
    assert stored is not None
    three = len(stored.encode())

    storage = MemoryStorage()
    keeping = persister(storage, max_bytes=three)
    # Written at different times, the second-written first in the mapping.
    at(monkeypatch, 1_000)
    keeping.save({ids[0]: values[ids[0]]})
    at(monkeypatch, 2_000)
    keeping.save({ids[1]: values[ids[1]], ids[0]: values[ids[0]]})
    at(monkeypatch, 3_000)
    keeping.save({ids[2]: values[ids[2]], ids[1]: values[ids[1]], ids[0]: values[ids[0]]})
    assert sorted(kept(storage), key=str) == ids[:3]
    assert len((storage.get(KEY) or "").encode()) == three

    # A fourth does not fit: the one written longest ago goes, wherever the mapping has it.
    at(monkeypatch, 4_000)
    keeping.save({ids[3]: values[ids[3]], ids[2]: values[ids[2]], ids[1]: values[ids[1]], ids[0]: values[ids[0]]})
    assert kept(storage) == [ids[1], ids[2], ids[3]]
    # What went is forgotten: kept again, it is as new as when it came back.
    at(monkeypatch, 5_000)
    keeping.save({ids[0]: values[ids[0]], ids[3]: values[ids[3]]})
    stored = storage.get(KEY)
    assert stored is not None
    document = _JSON.validate_json(stored)
    assert isinstance(document, dict)
    assert document["entries"] == [[ids[0], descriptor(ids[0]), 5_000], [ids[3], descriptor(ids[3]), 4_000]]

    # A document no entry fits in keeps none, and is still a document.
    tiny = MemoryStorage()
    persister(tiny, max_bytes=10).save(values)
    assert kept(tiny) == []
    assert persister(tiny).load() == {}
