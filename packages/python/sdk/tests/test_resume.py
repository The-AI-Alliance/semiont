"""A stream's place in each scope, kept with what the caches keep: never ahead of them."""

import asyncio
from collections.abc import Callable
from typing import final, override

import pytest
from aio import pass_time, run, settle, soon, turns
from gateway_server import GatewayServer
from kb import OTHER, RESOURCE, answer, asked_for, descriptor, knowing, knowing_content, recorded
from pydantic import JsonValue
from spec import JsonObject

from semiont.cache import Ready
from semiont.channels import BRIDGED_CHANNELS
from semiont.client import CachePersistence, SemiontClient
from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.resume import CoupledBookmarks
from semiont.storage import MemoryStorage, SessionStorage
from semiont.stored import cache_key, last_event_id_key, person_key
from semiont.testing import DropReply, FaultyTransport, StubGateway
from semiont.timing import SAVE_DEBOUNCE_MS
from semiont.watched import Variable, reached

PERSON = person_key("did:web:example.org:users:alice")
KEY = last_event_id_key("kb-a", PERSON)
CACHE = cache_key("kb-a", PERSON, "resource")
ANNOTATIONS = cache_key("kb-a", PERSON, "annotations")
QUICK = Timing(reconnect_ms=10, lazy_remove_ms=10, linger_ms=10)


def test_a_place_is_written_with_the_next_write_of_a_cache_and_not_before() -> None:
    storage = MemoryStorage()
    places = CoupledBookmarks(storage, KEY)
    caches = places.storage
    assert places.load() == {}

    places.save(RESOURCE, "p-res-1-7")
    places.save(RESOURCE, "p-res-1-8")
    places.save(OTHER, "p-res-2-3")
    # An id that is no persisted event's is no place.
    places.save(OTHER, "e-res-2-4")
    places.save(OTHER, "p-4")
    assert storage.get(KEY) is None
    # Reading what a cache kept, and forgetting it, write no place.
    assert caches.get(CACHE) is None
    caches.delete(CACHE)
    assert storage.get(KEY) is None

    caches.set(CACHE, "{}")
    assert (storage.get(CACHE), caches.get(CACHE)) == ("{}", "{}")
    assert places.load() == {RESOURCE: "p-res-1-8", OTHER: "p-res-2-3"}
    assert all(isinstance(scope, ResourceId) for scope in places.load())

    # A later place of one scope leaves the other's as it was.
    places.save(OTHER, "p-res-2-4")
    caches.set(CACHE, "{}")
    assert places.load() == {RESOURCE: "p-res-1-8", OTHER: "p-res-2-4"}
    # With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
    storage.set(KEY, '{"res-9": "p-res-9-1"}')
    caches.set(CACHE, "{}")
    assert places.load() == {ResourceId("res-9"): "p-res-9-1"}
    caches.delete(CACHE)
    assert storage.get(CACHE) is None


def test_a_place_waits_for_the_client_it_is_coupled_to_to_be_at_rest() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        places = CoupledBookmarks(storage, KEY)
        # The resource's answer is lost: its fetch is in flight until the test answers it.
        transport = FaultyTransport([DropReply()], make_response=knowing)
        persistence = CachePersistence(storage=places.storage, kb_id="kb-a", person_key=PERSON)
        client = SemiontClient(transport, knowing_content(), StubGateway(), persistence=persistence)
        places.couple_to(client)

        def settled() -> bool:
            return client.persistence_settled

        async with client, client.browse.resource(RESOURCE) as live:
            await turns()
            (asked,) = asked_for(transport, "browse:resource-requested")
            assert not settled()

            places.save(RESOURCE, "p-res-1-7")
            places.storage.set(ANNOTATIONS, "{}")
            # Late, which is safe: the cache that was written is not the one still taking the event in.
            assert storage.get(KEY) is None

            # The answer comes, and the resource's cache keeps it: the client is at rest, and the place rides that write.
            answer(transport, asked, {"resource": descriptor(RESOURCE), "lastSequence": 1})
            while not isinstance(await soon(anext(live)), Ready):
                pass
            await pass_time(SAVE_DEBOUNCE_MS / 1000 + 0.02, step=0.01)
            assert settled()
            assert storage.get(CACHE) is not None
            assert places.load() == {RESOURCE: "p-res-1-7"}

    run(scenario())


def test_what_is_kept_under_the_key_and_is_not_places_is_nothing_kept() -> None:
    storage = MemoryStorage()
    for kept in ("not json", "[1, 2]", '{"res-1": 7}', '{"not an id": "p-x-1"}', '{"res-1": "p-1"}'):
        storage.set(KEY, kept)
        assert CoupledBookmarks(storage, KEY).load() == {}, kept
    # A pair that is no place is skipped, and the rest are kept.
    storage.set(KEY, '{"res-1": 7, "not an id": "p-x-1", "res-2": "p-res-2-3"}')
    assert CoupledBookmarks(storage, KEY).load() == {OTHER: "p-res-2-3"}
    # What is no places is written over by the first places that are.
    storage.set(KEY, "[1, 2]")
    places = CoupledBookmarks(storage, KEY)
    places.save(RESOURCE, "p-res-1-1")
    places.storage.set(CACHE, "{}")
    assert places.load() == {RESOURCE: "p-res-1-1"}


async def places_asked_from(gateway: GatewayServer, scopes: int) -> dict[JsonValue, JsonValue]:
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
        storage.set(KEY, '{"res-1": "p-res-1-41"}')
        places = CoupledBookmarks(storage, KEY)
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK, bookmarks=places) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            heard = transport.frames("mark:added")
            with transport.subscribe_to_resource(RESOURCE), transport.subscribe_to_resource(OTHER):
                # The scope it kept a place in resumes from it; the other begins at the present.
                assert await soon(places_asked_from(gateway, 2)) == {RESOURCE: "p-res-1-41", OTHER: None}

                # A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
                gateway.send("p-res-1-42", {"channel": "mark:added", "payload": {"n": 1}, "scope": RESOURCE})
                gateway.send("e-9", {"channel": "mark:added", "payload": {"n": 2}, "scope": OTHER})
                assert [(await soon(anext(heard))).payload, (await soon(anext(heard))).payload] == [{"n": 1}, {"n": 2}]
                await settle()
                assert storage.get(KEY) == '{"res-1": "p-res-1-41"}'
                places.storage.set(CACHE, "{}")
                assert places.load() == {RESOURCE: "p-res-1-42"}

        # With no bookmarks, a stream begins every scope at the present and keeps nothing.
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            with transport.subscribe_to_resource(RESOURCE):
                assert await soon(places_asked_from(gateway, 1)) == {RESOURCE: None}

    run(scenario())


def test_bookmarks_given_once_the_stream_has_begun_keep_its_places_and_begin_only_the_scopes_it_holds_none_for() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        storage.set(KEY, '{"res-1": "p-res-1-41"}')
        places = CoupledBookmarks(storage, KEY)
        given = MemoryStorage()
        given.set(KEY, '{"res-1": "p-res-1-9", "res-2": "p-res-2-3"}')
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK, bookmarks=places) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            # The place the stream holds stands; a scope it holds none for begins where the bookmarks given say.
            transport.attach_bookmarks(CoupledBookmarks(given, KEY))
            with transport.subscribe_to_resource(RESOURCE), transport.subscribe_to_resource(OTHER):
                assert await soon(places_asked_from(gateway, 2)) == {RESOURCE: "p-res-1-41", OTHER: "p-res-2-3"}

        # A stream given no bookmarks when it was made takes them up all the same, and keeps its places there from then on.
        given.set(KEY, '{"res-2": "p-res-2-3"}')
        kept = CoupledBookmarks(given, KEY)
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=(), timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            transport.attach_bookmarks(kept)
            heard = transport.frames("mark:added")
            with transport.subscribe_to_resource(OTHER):
                assert await soon(places_asked_from(gateway, 1)) == {OTHER: "p-res-2-3"}
                gateway.send("p-res-2-4", {"channel": "mark:added", "payload": {"n": 1}, "scope": OTHER})
                assert (await soon(anext(heard))).payload == {"n": 1}
                await settle()
                kept.storage.set(CACHE, "{}")
                assert kept.load() == {OTHER: "p-res-2-4"}

    run(scenario())


def test_a_place_is_noted_only_once_the_refresher_has_taken_its_event() -> None:
    """B17: a place noted while its event is only queued for the refresher could ride a save that comes first, and lead the caches."""

    async def scenario() -> None:
        storage = MemoryStorage()
        places = CoupledBookmarks(storage, KEY)
        asked: list[JsonObject] = []
        asked_again = asyncio.Event()

        async with (
            GatewayServer() as gateway,
            HttpTransport(
                gateway.origin, token=Variable[str | None]("t"), channels=BRIDGED_CHANNELS, timing=QUICK, bookmarks=places
            ) as transport,
        ):

            def describe(emit: JsonObject, name: str) -> None:
                described: JsonObject = {"response": {"resource": descriptor(RESOURCE, name), "lastSequence": 1}}
                gateway.send(None, {"channel": "browse:resource-result", "payload": described, "correlationId": emit["correlationId"]})

            def answering(emit: JsonObject) -> None:
                # The service that answers for the resource answers its first read at once. A read asked again waits for the test.
                if emit["channel"] == "browse:resource-requested":
                    asked.append(emit)
                    if len(asked) == 1:
                        describe(emit, "A resource")
                    else:
                        asked_again.set()

            gateway.on_emit = answering
            persistence = CachePersistence(storage=places.storage, kb_id="kb-a", person_key=PERSON)
            client = SemiontClient(transport, transport.content, transport, persistence=persistence)
            places.couple_to(client)
            # A reader of the client's own bus, listening from before the client is held. The transport gives each event
            # to the refresher before the bus, so once this reader has one, the refresher has taken it, and the stream
            # notes its place only after that.
            ahead = client.bus.frames_among(["mark:archived"])

            def settled() -> bool:
                return client.persistence_settled

            await soon(reached(transport.state, lambda state: state == "open"))
            async with client, client.browse.resource(RESOURCE) as live:
                while not isinstance(await soon(anext(live)), Ready):
                    pass
                # The stream holds the resource's scope, on a connection that replaced the first, which is gone.
                await soon(places_asked_from(gateway, 1))
                await settle()
                await pass_time(SAVE_DEBOUNCE_MS / 1000 + 0.02, step=0.01)
                document = storage.get(CACHE)
                assert document is not None
                assert settled()

                gateway.send("p-res-1-7", {"channel": "mark:archived", "payload": recorded("mark:archived", "res-1"), "scope": "res-1"})
                await soon(anext(ahead))
                # The event has been delivered, and the refresher took it first: its fetch of the resource is in flight.
                # A kept cache writes now, and no place rides it.
                places.storage.set(CACHE, document)
                assert storage.get(KEY) is None

                # The read asked again reaches the service: that fetch, still in flight, holds the place back.
                await soon(asked_again.wait())
                assert not settled()
                places.storage.set(CACHE, document)
                assert storage.get(KEY) is None

                # The answer comes, and the resource's cache keeps it: every kept cache is at rest, and the place rides that write.
                describe(asked[1], "A resource, archived")
                await settle()
                await pass_time(SAVE_DEBOUNCE_MS / 1000 + 0.02, step=0.01)
                assert places.load() == {RESOURCE: "p-res-1-7"}

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

        @override
        def update(self, key: str, change: Callable[[str | None], str | None]) -> None:
            after = change(self.held.get(key))
            if after is None:
                self.delete(key)
            else:
                self.set(key, after)

        @override
        def subscribe(self, on_change: Callable[[str, str | None], None]) -> Callable[[], None] | None:
            return None

    storage = Full()
    places = CoupledBookmarks(storage, KEY)
    places.save(RESOURCE, "p-res-1-7")
    with pytest.raises(OSError, match="full"):
        places.storage.set(CACHE, "{}")
    # The cache kept nothing of what the place names, and no place says it did.
    assert storage.get(KEY) is None
    places.storage.set(ANNOTATIONS, "{}")
    assert places.load() == {RESOURCE: "p-res-1-7"}
