"""A stream's place in each scope, kept with what the caches keep: never ahead of them."""

import asyncio
from typing import final, override

import pytest
from aio import run, settle, soon
from kb import OTHER, RESOURCE
from pydantic import JsonValue
from stub_gateway import StubGateway

from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.resume import CoupledBookmarks
from semiont.storage import MemoryStorage, SessionStorage
from semiont.watched import Variable, reached

KEY = "semiont.lastEventId.kb-a"
CACHE = "semiont.cache.kb-a.resource"
QUICK = Timing(reconnect_ms=10, lazy_remove_ms=10, linger_ms=10)


def test_a_place_is_written_with_the_next_write_of_a_cache_and_not_before() -> None:
    storage = MemoryStorage()
    places = CoupledBookmarks(storage, KEY)
    caches = places.storage
    assert places.load() == {}

    places.save(RESOURCE, "p-7")
    places.save(RESOURCE, "p-8")
    places.save(OTHER, "p-3")
    assert storage.get(KEY) is None
    # Reading what a cache kept, and forgetting it, write no place.
    assert caches.get(CACHE) is None
    caches.delete(CACHE)
    assert storage.get(KEY) is None

    caches.set(CACHE, "{}")
    assert (storage.get(CACHE), caches.get(CACHE)) == ("{}", "{}")
    assert places.load() == {RESOURCE: "p-8", OTHER: "p-3"}
    assert all(isinstance(scope, ResourceId) for scope in places.load())

    # A later place of one scope leaves the other's as it was.
    places.save(OTHER, "p-4")
    caches.set(CACHE, "{}")
    assert places.load() == {RESOURCE: "p-8", OTHER: "p-4"}
    # With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
    storage.set(KEY, '{"res-9": "p-1"}')
    caches.set(CACHE, "{}")
    assert places.load() == {ResourceId("res-9"): "p-1"}
    caches.delete(CACHE)
    assert storage.get(CACHE) is None


def test_a_place_waits_for_the_caches_to_be_at_rest() -> None:
    storage = MemoryStorage()
    places = CoupledBookmarks(storage, KEY)
    caches = places.storage
    at_rest = [False]
    places.set_flush_gate(lambda: at_rest[0])

    places.save(RESOURCE, "p-7")
    caches.set(CACHE, "{}")
    # Late, which is safe: the cache that was written may not be the one still taking the event in.
    assert storage.get(KEY) is None

    at_rest[0] = True
    caches.set("semiont.cache.kb-a.annotations", "{}")
    assert places.load() == {RESOURCE: "p-7"}


def test_what_is_kept_under_the_key_and_is_not_places_is_nothing_kept() -> None:
    storage = MemoryStorage()
    for kept in ("not json", "[1, 2]", '{"res-1": 7}', '{"not an id": "p-1"}'):
        storage.set(KEY, kept)
        assert CoupledBookmarks(storage, KEY).load() == {}, kept
    # And is written over by the first places that are.
    places = CoupledBookmarks(storage, KEY)
    places.save(RESOURCE, "p-1")
    places.storage.set(CACHE, "{}")
    assert places.load() == {RESOURCE: "p-1"}


async def places_asked_from(gateway: StubGateway, scopes: int) -> dict[JsonValue, JsonValue]:
    """Where a subscription of `scopes` scopes asks each to begin, once the gateway has been sent one."""
    while True:
        for subscription in reversed(gateway.subscriptions):
            scoped = subscription.get("scoped")
            if isinstance(scoped, list) and len(scoped) == scopes:
                return {entry["scope"]: entry.get("lastEventId") for entry in scoped if isinstance(entry, dict)}
        await asyncio.sleep(0.005)


def test_a_stream_begins_each_scope_where_its_bookmarks_say_and_tells_them_each_recorded_event_it_delivered() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        storage.set(KEY, '{"res-1": "p-41"}')
        places = CoupledBookmarks(storage, KEY)
        async with (
            StubGateway() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK, bookmarks=places) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            heard = transport.frames("mark:added")
            with transport.subscribe_to_resource(RESOURCE), transport.subscribe_to_resource(OTHER):
                # The scope it kept a place in resumes from it; the other begins at the present.
                assert await soon(places_asked_from(gateway, 2)) == {RESOURCE: "p-41", OTHER: None}

                # A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
                gateway.send("p-42", {"channel": "mark:added", "payload": {"n": 1}, "scope": RESOURCE})
                gateway.send("e-9", {"channel": "mark:added", "payload": {"n": 2}, "scope": OTHER})
                assert [(await soon(anext(heard))).payload, (await soon(anext(heard))).payload] == [{"n": 1}, {"n": 2}]
                await settle()
                assert storage.get(KEY) == '{"res-1": "p-41"}'
                places.storage.set(CACHE, "{}")
                assert places.load() == {RESOURCE: "p-42"}

        # With no bookmarks, a stream begins every scope at the present and keeps nothing.
        async with (
            StubGateway() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            with transport.subscribe_to_resource(RESOURCE):
                assert await soon(places_asked_from(gateway, 1)) == {RESOURCE: None}

    run(scenario())


def test_a_place_is_written_after_the_caches_own_write_so_one_that_fails_leaves_no_place_ahead_of_it() -> None:
    @final
    class Full(SessionStorage):
        """A storage that holds what it has, and takes no cache's write."""

        def __init__(self) -> None:
            self.held: dict[str, str] = {}

        @override
        def get(self, key: str) -> str | None:
            return self.held.get(key)

        @override
        def set(self, key: str, value: str) -> None:
            if key == CACHE:
                raise OSError("the storage is full")
            self.held[key] = value

        @override
        def delete(self, key: str) -> None:
            self.held.pop(key, None)

    storage = Full()
    places = CoupledBookmarks(storage, KEY)
    places.save(RESOURCE, "p-7")
    with pytest.raises(OSError, match="full"):
        places.storage.set(CACHE, "{}")
    # The cache kept nothing of what the place names, and no place says it did.
    assert storage.get(KEY) is None
    places.storage.set("semiont.cache.kb-a.annotations", "{}")
    assert places.load() == {RESOURCE: "p-7"}
