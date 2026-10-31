"""A client's live queries: what watching one holds, what a read gives its watchers, and what a client keeps of them.

Under any behaviour of the wire, a watcher is told something (L1, L2:
`semiont.testing.liveness`).

What each query asks is `test_surface.py`'s, the cache's own rules are
`test_cache.py`'s, and what an event does to a query is `test_refresher.py`'s.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from contextlib import AsyncExitStack, asynccontextmanager

import pytest
from aio import pass_time, run, soon, turns
from kb import (
    ANNOTATION,
    LIMITS,
    OTHER,
    RESOURCE,
    SilentContent,
    annotation,
    answer,
    asked_for,
    descriptor,
    event,
    knowing,
    knowing_content,
    refuse,
    refusing,
    silent,
)
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject

from semiont.cache import CacheState, Failed, Pending, Ready
from semiont.client import CachePersistence, ClientTiming, SemiontClient
from semiont.errors import BusRequestError
from semiont.identifiers import ResourceId
from semiont.namespaces.browse import EngineWithLimits
from semiont.refresh import CACHE_QUERIES, CacheQuery
from semiont.storage import MemoryStorage
from semiont.testing import FaultyTransport, StubGateway, create_test_client, refuse_unscripted_operation
from semiont.testing.liveness import LivenessScenario, LivenessSpec, assert_liveness_axioms
from semiont.timing import SAVE_DEBOUNCE_MS

type Client = SemiontClient[FaultyTransport]

_DOCUMENT = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def world(persistence: CachePersistence | None = None, *, answered: bool = True) -> tuple[Client, FaultyTransport]:
    """A client over doubles that answer every read a live query makes, or, when it is not `answered`, that answer none: the test does."""
    transport = FaultyTransport(make_response=knowing) if answered else silent()
    content = knowing_content() if answered else SilentContent()
    client: Client = SemiontClient(transport, content, StubGateway(), persistence=persistence)
    return client, transport


def test_watching_a_query_of_a_resource_holds_its_scope_from_before_it_asks_until_the_watcher_leaves() -> None:
    async def scenario() -> None:
        client, transport = world(answered=False)
        async with client:
            query = client.browse.events(RESOURCE)
            # Naming a query touches nothing.
            await turns()
            assert (transport.scopes, transport.emitted) == ([], [])
            async with query as live:
                # The scope is held before the request is made: the events that refresh the value are coming when it arrives.
                assert (transport.holds(RESOURCE), transport.emitted) == (1, [])
                assert await soon(anext(live)) == Pending()
                await turns()
                assert len(transport.emitted) == 1
                # A second watcher, of the same query or of another of the resource, is a second hold.
                async with query, client.browse.annotation(RESOURCE, ANNOTATION), client.gather.referenced_by(OTHER):
                    assert (transport.holds(RESOURCE), transport.holds(OTHER)) == (3, 1)
                assert (transport.holds(RESOURCE), transport.scopes) == (1, [RESOURCE])
            assert transport.scopes == []

            # Every query of a resource holds its scope while it is watched.
            for of_a_resource in (
                client.browse.resource(OTHER),
                client.browse.annotations(OTHER),
                client.browse.annotation(OTHER, ANNOTATION),
                client.browse.events(OTHER),
                client.gather.referenced_by(OTHER),
            ):
                async with of_a_resource:
                    assert (transport.holds(OTHER), transport.scopes) == (1, [OTHER])
                assert transport.scopes == []

            # A query of the knowledge base holds no scope, and neither does a read of any query.
            async with (
                client.browse.resources(),
                client.match.resources("text"),
                client.browse.entity_types(),
                client.browse.tag_schemas(),
                client.browse.engines(),
            ):
                assert transport.scopes == []
            reading = asyncio.ensure_future(client.browse.resource(RESOURCE).fresh())
            await turns()
            assert transport.scopes == []
            reading.cancel()

    run(scenario())


def test_a_watcher_that_cannot_be_given_its_scope_is_not_left_holding_anything() -> None:
    async def scenario() -> None:
        client, transport = world()
        async with client:
            query = client.browse.resource(RESOURCE)
            async with query:
                with pytest.raises(ValueError, match="left early"):
                    async with query:
                        raise ValueError("left early")
                assert transport.holds(RESOURCE) == 1
            assert transport.scopes == []

    run(scenario())


def test_a_read_gives_what_the_service_answers_now_and_every_watcher_is_given_it_too() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply(
            "browse:resource-requested",
            [{"resource": descriptor(RESOURCE, name), "lastSequence": 1} for name in ("first", "second")],
        )
        async with client, client.browse.resource(RESOURCE) as live:
            assert await soon(anext(live)) == Pending()
            first = await soon(anext(live))
            assert isinstance(first, Ready)
            assert first.value.name == "first"
            # A read asks, whatever is held.
            assert (await soon(client.browse.resource(RESOURCE).fresh())).name == "second"
            second = await soon(anext(live))
            assert isinstance(second, Ready)
            assert second.value.name == "second"
            # And raises the failure it meets, which no watcher is shown: the value stays.
            transport.refuse_when(refusing("browse:resource-requested"))
            with pytest.raises(BusRequestError):
                await soon(client.browse.resource(RESOURCE).fresh())
            reading = asyncio.ensure_future(anext(live))
            await turns(20)
            assert not reading.done()
            reading.cancel()
            assert len(asked_for(transport, "browse:resource-requested")) == 3

    run(scenario())


def test_invalidating_a_query_asks_again_and_shows_its_value_meanwhile() -> None:
    async def scenario() -> None:
        client, transport = world()
        async with client, client.browse.entity_types() as live:
            assert await soon(anext(live)) == Pending()
            assert await soon(anext(live)) == Ready(["Person"])
            transport.queue_reply("browse:entity-types-requested", [{"entityTypes": ["Person", "Place"]}])
            client.browse.entity_types().invalidate()
            assert await soon(anext(live)) == Ready(["Person", "Place"])
            assert len(asked_for(transport, "browse:entity-types-requested")) == 2

    run(scenario())


def test_a_resources_annotations_are_the_list_and_a_list_or_a_search_is_one_query_per_set_of_filters() -> None:
    async def scenario() -> None:
        client, transport = world()
        async with client:
            listed = await soon(client.browse.annotations(RESOURCE).fresh())
            assert [each.id for each in listed] == [ANNOTATION]

            async with AsyncExitStack() as held:
                for query in (
                    client.browse.resources(),
                    client.browse.resources(limit=100),
                    client.browse.resources(archived=True),
                    client.browse.resources(entity_type="Person"),
                    client.browse.resources(limit=5),
                ):
                    await held.enter_async_context(query)
                await turns(20)
                # Stating the limit a list has anyway is the same list.
                asked = [frame.payload for frame in asked_for(transport, "browse:resources-requested")]
                assert {"limit": 100, "offset": 0} in asked
                assert {"limit": 100, "offset": 0, "archived": True} in asked
                assert {"limit": 100, "offset": 0, "entityType": "Person"} in asked
                assert {"limit": 5, "offset": 0} in asked
                assert len(asked) == 4

            before = len(asked_for(transport, "match:resources-requested"))
            async with client.match.resources("a"), client.match.resources("a"), client.match.resources("b", archived=False):
                await turns(20)
            searched = [frame.payload for frame in asked_for(transport, "match:resources-requested")[before:]]
            assert searched == [{"search": "a", "limit": 100, "offset": 0}, {"search": "b", "limit": 100, "offset": 0, "archived": False}]

    run(scenario())


def test_the_engines_are_shown_as_they_are_answered_and_each_holders_limits_as_it_reports_them() -> None:
    async def scenario() -> None:
        gemma: JsonObject = {"provider": "ollama", "model": "gemma2:27b"}
        claude: JsonObject = {"provider": "anthropic", "model": "claude-opus-5-5"}
        client, transport = world(answered=False)

        def limits_of(engines: list[EngineWithLimits]) -> list[float | None]:
            return [None if each.limits is None else each.limits.context_tokens for each in engines]

        async with client, client.browse.engines() as live:
            assert await soon(anext(live)) == Pending()
            await turns()
            # The engines are asked for first, and each key holder after them.
            assert [frame.channel for frame in transport.emitted] == ["browse:engines-requested", *LIMITS]
            engines, gather, job, match = transport.emitted

            # A holder that answers before the engines are has nothing to be shown on yet.
            answer(transport, job, {"limits": [{"engine": gemma, "limits": {"contextTokens": 8192, "maxOutputTokens": 1}}]})
            reading = asyncio.ensure_future(anext(live))
            await turns(20)
            assert not reading.done()

            # The engines are shown when they are answered, with what has been reported so far: they wait for no holder.
            answer(transport, engines, {"engines": [{"engine": gemma}, {"engine": claude}]})
            shown = await soon(reading)
            assert isinstance(shown, Ready)
            assert [(each.entry.engine.provider, each.entry.engine.model) for each in shown.value] == [
                ("ollama", "gemma2:27b"),
                ("anthropic", "claude-opus-5-5"),
            ]
            assert limits_of(shown.value) == [8192, None]

            # A holder that reports later delays only its own engines' limits.
            answer(transport, gather, {"limits": [{"engine": claude, "limits": {"contextTokens": 9, "maxOutputTokens": 1}}]})
            shown = await soon(anext(live))
            assert isinstance(shown, Ready)
            assert limits_of(shown.value) == [8192, 9]

            # And one that fails reports none: nothing changes, and nothing is failed.
            refuse(transport, match)
            reading = asyncio.ensure_future(anext(live))
            await turns(20)
            assert not reading.done()
            assert len(transport.emitted) == 4

            # Asking again asks for the engines and every holder again, and shows what there is meanwhile.
            client.browse.engines().invalidate()
            await turns()
            assert [frame.channel for frame in transport.emitted[4:]] == ["browse:engines-requested", *LIMITS]
            assert not reading.done()
            answer(transport, transport.emitted[4], {"engines": [{"engine": claude}]})
            shown = await soon(reading)
            assert isinstance(shown, Ready)
            assert [(each.entry.engine.provider, each.entry.engine.model) for each in shown.value] == [("anthropic", "claude-opus-5-5")]
            assert limits_of(shown.value) == [9]

    run(scenario())


def test_engines_that_fail_are_a_failed_state_whatever_their_holders_report_and_a_read_of_them_raises() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.refuse_when(refusing("browse:engines-requested"))
        async with client:
            with pytest.raises(BusRequestError) as refused:
                await soon(client.browse.engines().fresh())
            assert refused.value.code == "bus.rejected"
            async with client.browse.engines() as live:
                assert await soon(anext(live)) == Pending()
                state = await soon(anext(live))
                while not isinstance(state, Failed):
                    state = await soon(anext(live))
                assert state.error.code == "bus.rejected"
        # A closed client's engines are nobody's to watch.
        async with client.browse.engines() as live:
            assert await soon(anext(live, None)) is None

    run(scenario())


def test_a_client_keeps_its_small_queries_and_the_next_client_shows_them_at_once_and_asks_for_them_anew() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        persistence = CachePersistence(storage=storage, key_prefix="kb")

        def kept(name: str) -> JsonObject | None:
            document = storage.get(f"semiont.cache.kb.{name}")
            return None if document is None else _DOCUMENT.validate_json(document)

        def settled(client: Client) -> bool:
            return client.persistence_settled

        client, transport = world(persistence)
        async with client:
            assert settled(client)
            for read in (
                client.browse.resource(RESOURCE).fresh(),
                client.browse.annotations(RESOURCE).fresh(),
                client.browse.annotation(RESOURCE, ANNOTATION).fresh(),
                client.browse.entity_types().fresh(),
                client.browse.tag_schemas().fresh(),
                client.browse.events(RESOURCE).fresh(),
                client.gather.referenced_by(RESOURCE).fresh(),
                client.browse.resources().fresh(),
                client.match.resources("text").fresh(),
                client.browse.engines().fresh(),
            ):
                await soon(read)
            # What it knows is owed to storage until it has stopped changing.
            assert not settled(client)
            assert kept("resource") is None
            await pass_time(SAVE_DEBOUNCE_MS / 1000 + 0.02, step=0.01)
            assert settled(client)

            # An event about an annotation nobody holds changes nothing the client keeps: nothing is owed.
            transport.deliver(event("mark:delete-ok", of="ann-nobody-holds"))
            await turns(20)
            assert settled(client)

        # The five small queries, each a document under the client's prefix; a list, a search and a history are not kept.
        names = ("resource", "annotations", "annotation-detail", "entity-types", "tag-schemas")
        documents = {name: kept(name) for name in names}
        assert all(document is not None and document["version"] == 1 for document in documents.values())
        for unkept in ("lists", "resources", "events", "referenced-by", "matched-resources", "searches", "engines", "limits"):
            assert kept(unkept) is None
        resource = documents["resource"]
        assert resource is not None
        entries = resource["entries"]
        assert isinstance(entries, list)
        (entry,) = entries
        assert isinstance(entry, list)
        # As the wire had it: by the wire's names, and without what the knowledge base never said.
        assert entry[:2] == [RESOURCE, descriptor(RESOURCE)]
        annotations = documents["annotations"]
        assert annotations is not None
        kept_annotations = annotations["entries"]
        assert isinstance(kept_annotations, list)
        (listed,) = kept_annotations
        assert isinstance(listed, list)
        assert listed[:2] == [RESOURCE, {"annotations": [annotation(ANNOTATION, RESOURCE)], "total": 1}]

        # The next client of the same knowledge base, over the same storage.
        again, asked = world(persistence)
        async with again, again.browse.resource(RESOURCE) as live, again.browse.entity_types() as types:
            # Shown at once: no pending before it. And asked for anew, once.
            shown = await soon(anext(live))
            assert isinstance(shown, Ready)
            assert shown.value.name == "A resource"
            assert await soon(anext(types)) == Ready(["Person"])
            await turns(20)
            assert [frame.channel for frame in asked.emitted] == ["browse:resource-requested", "browse:entity-types-requested"]
            # An annotation that was kept is asked for anew too, by a request that names its resource.
            async with again.browse.annotation(RESOURCE, ANNOTATION) as one:
                assert isinstance(await soon(anext(one)), Ready)
                await turns(20)
                assert asked.emitted[-1].payload == {"resourceId": RESOURCE, "annotationId": ANNOTATION}

        # A client of another knowledge base, over the same storage, begins with nothing of this one's.
        other, _ = world(CachePersistence(storage=storage, key_prefix="another"))
        async with other, other.browse.resource(RESOURCE) as live:
            assert await soon(anext(live)) == Pending()

    run(scenario())


def test_a_client_that_keeps_nothing_is_always_settled() -> None:
    async def scenario() -> None:
        client, _ = world()
        async with client:
            reading = asyncio.ensure_future(client.browse.resource(RESOURCE).fresh())
            assert client.persistence_settled
            await soon(reading)
            assert client.persistence_settled

    run(scenario())


KEPT = ("resource", "annotations", "annotation", "entityTypes", "tagSchemas")
"""The queries a client with a storage keeps."""


@pytest.mark.parametrize("query", CACHE_QUERIES)
def test_a_client_is_settled_unless_a_query_it_keeps_is_being_fetched_or_is_owed_to_storage(query: CacheQuery) -> None:
    async def scenario() -> None:
        client, _ = world(CachePersistence(storage=MemoryStorage(), key_prefix="kb"), answered=False)
        named = {
            "resource": client.browse.resource(RESOURCE),
            "annotations": client.browse.annotations(RESOURCE),
            "annotation": client.browse.annotation(RESOURCE, ANNOTATION),
            "events": client.browse.events(RESOURCE),
            "referencedBy": client.gather.referenced_by(RESOURCE),
            "resources": client.browse.resources(),
            "matchedResources": client.match.resources("text"),
            "entityTypes": client.browse.entity_types(),
            "tagSchemas": client.browse.tag_schemas(),
            "engines": client.browse.engines(),
        }
        assert set(named) == set(CACHE_QUERIES)
        async with client:
            reading = asyncio.ensure_future(named[query].fresh())
            await turns()
            # Fetching what it keeps, it is not at rest; fetching what it does not keep, it is.
            assert client.persistence_settled == (query not in KEPT)
            reading.cancel()

    run(scenario())


# ── Liveness: under any behaviour of the wire, a watcher is told something ──


def describing(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
    """What a knowledge base answers a read of a resource with: a description of the resource asked for. It is asked nothing else."""
    if operation != "browse:resource-requested":
        refuse_unscripted_operation(operation, payload)
    return {"resource": descriptor(str(payload["resourceId"])), "lastSequence": 1}


async def said[T](live: AsyncIterator[CacheState[T]]) -> None:
    """Until the watcher is shown a value or a failure: `Pending` is nothing said."""
    async for state in live:
        if not isinstance(state, Pending):
            return


def test_l1_l2_a_watcher_is_given_a_value_or_a_failure_and_a_read_settles_under_every_schedule() -> None:
    timeout_ms = 50

    @asynccontextmanager
    async def watching(transport: FaultyTransport) -> AsyncGenerator[LivenessScenario]:
        made = create_test_client(transport=transport, timing=ClientTiming(bus_request_ms=timeout_ms))
        async with made.client as client, client.browse.resource(RESOURCE) as one, client.browse.resource(OTHER) as other:
            yield LivenessScenario(outputs=(said(one), said(other)), settlements=(client.browse.resource(ResourceId("res-3")).fresh(),))

    # B14: a fetch for the live view is tried once more.
    assert_liveness_axioms(LivenessSpec(setup=watching, timeout_ms=timeout_ms, retry_budget=1, cases=30, make_response=describing))
