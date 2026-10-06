"""What keeps a client's queries true: each row of `specs/src/client/refresh.json`, and the rules every row is applied under.

The conformance corpus holds each row against a real gateway. Here each is
held against a scripted one, where a test also says what no gateway can be
made to do on cue: a burst inside a window, an event nobody can read.
"""

import asyncio
from collections import Counter
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack

import pytest
from aio import pass_time, run, soon, turns
from kb import ANNOTATION, ASKS, ELSEWHERE, OTHER, RESOURCE, annotation, asked_for, event, knowing, recorded, refusing, silent
from pydantic import JsonValue

from semiont.cache import CacheState, Failed, Pending, Ready
from semiont.cached import Cached
from semiont.channels import BRIDGED_CHANNELS, CHANNELS, RESOURCE_SCOPED_CHANNELS
from semiont.client import ClientTiming, SemiontClient
from semiont.errors import BusRequestError
from semiont.identifiers import AnnotationId
from semiont.refresh import CACHE_QUERIES, CACHE_REFRESH, CacheQuery, CacheRefresh, CacheRefreshReach, CacheRefreshTrigger
from semiont.testing import FaultyTransport, InMemoryContent, StubGateway
from semiont.transport import Frame
from semiont.types import Annotation

type Client = SemiontClient[FaultyTransport]

WINDOW_MS = 1000


def world(window_ms: int = WINDOW_MS, *, answered: bool = True) -> tuple[Client, FaultyTransport]:
    """A client over a gateway that answers every operation a live query asks, or one the test answers for when it is not `answered`."""
    transport = FaultyTransport(make_response=knowing) if answered else silent()
    timing = ClientTiming(invalidation_window_ms=window_ms)
    client: Client = SemiontClient(transport, InMemoryContent(), StubGateway(), timing=timing)
    return client, transport


async def watched[T](held: AsyncExitStack, query: Cached[T]) -> AsyncIterator[CacheState[T]]:
    """A watcher of `query`, which has its value."""
    live = await held.enter_async_context(query)
    while not isinstance(await soon(anext(live)), Ready):
        pass
    return live


def everything(client: Client) -> Sequence[Cached[object]]:
    """Every live query: of both resources and an annotation of each, and of the knowledge base."""
    browse = client.browse
    return [
        *(query for resource in (RESOURCE, OTHER) for query in (browse.resource(resource), browse.annotations(resource))),
        *(query for resource in (RESOURCE, OTHER) for query in (browse.events(resource), client.gather.referenced_by(resource))),
        browse.annotation(RESOURCE, ANNOTATION),
        browse.annotation(OTHER, ELSEWHERE),
        browse.resources(),
        client.match.resources("a search"),
        browse.entity_types(),
        browse.tag_schemas(),
        browse.agents(),
    ]


async def asked_after(transport: FaultyTransport, cause: Frame | None) -> Counter[str]:
    """How often each operation is asked once `cause` is delivered: or, with none, once the stream has dropped and reopened."""
    before = len(transport.emitted)
    if cause is None:
        transport.set_state("reconnecting")
        await turns()
        transport.set_state("open")
    else:
        transport.deliver(cause)
    await turns(20)
    return Counter(frame.channel for frame in transport.emitted[before:])


OF_A_RESOURCE = ("resource", "annotations", "events", "referencedBy", "annotation")
"""The queries `everything` holds two of: one of each resource, or of an annotation of each."""


def expected(queries: Sequence[CacheQuery], reach: CacheRefreshReach) -> Counter[str]:
    """What asking again for `queries` asks, of everything `everything` holds, when the event is about `RESOURCE`.

    A row that reaches its subject asks for what is of that resource, and of
    its annotation: the one the event names, or each one held of the resource
    when it names none, which here is the same one.
    """
    asked: Counter[str] = Counter()
    for query in queries:
        for operation in ASKS[query]:
            asked[operation] += 2 if query in OF_A_RESOURCE and reach == "held" else 1
    return asked


ROWS = [(trigger, row) for trigger, rows in CACHE_REFRESH.items() for row in rows]


@pytest.mark.parametrize(("trigger", "row"), ROWS, ids=[f"{trigger}{'' if row.when is None else ' ' + row.when}" for trigger, row in ROWS])
def test_each_row_of_the_refresh_table_does_what_it_states_to_what_is_held(trigger: CacheRefreshTrigger, row: CacheRefresh) -> None:
    async def scenario() -> None:
        client, transport = world()
        async with client, AsyncExitStack() as held:
            for query in everything(client):
                await watched(held, query)
            one = await watched(held, client.browse.annotation(RESOURCE, ANNOTATION))
            listed = await watched(held, client.browse.annotations(RESOURCE))

            cause = None if trigger == "reopened" else event(trigger, row.when)
            assert await asked_after(transport, cause) == expected(row.refetches, row.reach)

            written = Annotation.model_validate(annotation(ANNOTATION, RESOURCE, modified="2026-10-06T01:00:00.000Z"))
            if "annotation" in row.writes:
                # The event carried the annotation: it is the value, and nobody was asked.
                assert await soon(anext(one)) == Ready(written)
            if "annotations" in row.writes:
                assert await soon(anext(listed)) == Ready([written])
            if "annotation" in row.removes:
                state = await soon(anext(one))
                assert isinstance(state, Failed)
                assert state.error.code == "bus.not-found"
            assert set(row.writes) <= {"annotation", "annotations"}
            assert set(row.removes) <= {"annotation"}

    run(scenario())


def test_every_trigger_but_the_reopening_is_a_channel_a_client_hears() -> None:
    events = [trigger for trigger in CACHE_REFRESH if trigger != "reopened"]
    assert events
    for trigger in events:
        assert trigger in CHANNELS
        assert trigger in BRIDGED_CHANNELS or trigger in RESOURCE_SCOPED_CHANNELS, trigger
    assert set(ASKS) == set(CACHE_QUERIES)


def test_b19_the_refetches_events_ask_of_one_key_inside_a_window_are_one_refetch() -> None:
    async def scenario() -> None:
        client, transport = world()

        def asked() -> int:
            return len(asked_for(transport, "browse:resource-requested"))

        async with client, AsyncExitStack() as held:
            await watched(held, client.browse.resource(RESOURCE))
            await watched(held, client.browse.resource(OTHER))
            await watched(held, client.browse.resources())
            await watched(held, client.match.resources("text"))
            assert asked() == 2

            def lists_and_searches() -> tuple[int, int]:
                return len(asked_for(transport, "browse:resources-requested")), len(asked_for(transport, "match:resources-requested"))

            assert lists_and_searches() == (1, 1)

            # The first runs at once, and opens the key's window.
            transport.deliver(event("yield:updated"))
            await turns()
            assert asked() == 3
            # Any more inside it are owed, and are one.
            for _ in range(5):
                transport.deliver(event("yield:updated"))
            await turns()
            assert asked() == 3
            # The lists are one key and the searches another, whichever resource an event names: each was asked for
            # again by the first, and owes one more whatever came after.
            assert lists_and_searches() == (2, 2)
            # A window is one key's: another key's first runs at once.
            transport.deliver(event("yield:updated", resource=OTHER))
            await turns()
            assert asked() == 4
            assert lists_and_searches() == (2, 2)

            await pass_time((WINDOW_MS - 100) / 1000, step=0.1)
            assert asked() == 4
            await pass_time(0.2, step=0.1)
            # The window closed: what it owed ran, once, and that opened the next.
            assert asked() == 5
            assert lists_and_searches() == (3, 3)
            assert asked_for(transport, "browse:resource-requested")[-1].payload == {"resourceId": RESOURCE}
            transport.deliver(event("yield:updated"))
            await turns()
            assert asked() == 5
            await pass_time(WINDOW_MS / 1000 + 0.1, step=0.1)
            assert asked() == 6

            # A window that owed nothing closes, and the next event runs at once.
            await pass_time(WINDOW_MS / 1000 + 0.1, step=0.1)
            assert asked() == 6
            transport.deliver(event("yield:updated"))
            await turns()
            assert asked() == 7

            # What a window owes when the client closes is dropped.
            transport.deliver(event("yield:updated"))
            await turns()
        await pass_time(WINDOW_MS / 1000 + 0.1, step=0.1)
        assert asked() == 7

    run(scenario())


def test_b20_an_event_asks_again_only_for_what_the_cache_holds() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        async with client, AsyncExitStack() as held:
            # Nothing is held: no event of any kind asks for anything.
            for trigger in CACHE_REFRESH:
                if trigger != "reopened":
                    transport.deliver(event(trigger))
            transport.set_state("reconnecting")
            await turns()
            transport.set_state("open")
            await turns(20)
            assert transport.emitted == []

            await watched(held, client.browse.annotations(RESOURCE))
            before = len(transport.emitted)
            # Of what `mark:added` names, the annotations are held and the events are not; and no other resource's are.
            transport.deliver(event("mark:added"))
            transport.deliver(event("mark:added", resource=OTHER))
            await turns(20)
            assert [(frame.channel, frame.payload) for frame in transport.emitted[before:]] == [
                ("browse:annotations-requested", {"resourceId": RESOURCE})
            ]

    run(scenario())


def test_b20_a_key_that_is_failed_or_being_fetched_is_held() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        transport.refuse_when(refusing("browse:events-requested"))
        async with client, AsyncExitStack() as held:
            failing = await held.enter_async_context(client.browse.events(RESOURCE))
            assert await soon(anext(failing)) == Pending()
            assert isinstance(await soon(anext(failing)), Failed)
            assert len(asked_for(transport, "browse:events-requested")) == 2
            transport.deliver(event("mark:added"))
            assert await soon(anext(failing)) == Pending()
            await turns(20)
            # Asked again, and once more when that failed.
            assert len(asked_for(transport, "browse:events-requested")) == 4

        # One whose first request nobody has answered.
        waiting, unanswered = world(window_ms=0, answered=False)
        async with waiting, waiting.browse.annotations(RESOURCE):
            await turns()
            assert len(asked_for(unanswered, "browse:annotations-requested")) == 1
            unanswered.deliver(event("mark:added"))
            await turns()
            assert len(asked_for(unanswered, "browse:annotations-requested")) == 2

    run(scenario())


def test_an_event_that_cannot_be_read_asks_again_for_everything_held() -> None:
    async def scenario() -> None:
        client, transport = world()
        async with client, AsyncExitStack() as held:
            for query in everything(client):
                await watched(held, query)
            # Something changed and nothing says what.
            unreadable = Frame(channel="mark:added", payload={"not": "a recorded event"})
            assert await asked_after(transport, unreadable) == expected(CACHE_QUERIES, "held")
            # And a frame on a channel that is no trigger asks for nothing.
            assert await asked_after(transport, Frame(channel="beckon:focus", payload={"annotationId": ANNOTATION})) == Counter()

    run(scenario())


def test_b13_only_a_stream_that_left_open_and_returned_has_reopened() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        transport.set_state("initial")

        def asked() -> int:
            return len(asked_for(transport, "browse:entity-types-requested"))

        async with client, AsyncExitStack() as held:
            # Its first opening is no reopening: nothing was missed. What was watched before it waits for it, and asks once.
            live = await held.enter_async_context(client.browse.entity_types())
            assert await soon(anext(live)) == Pending()
            transport.set_state("connecting")
            await turns()
            assert asked() == 0
            transport.set_state("open")
            assert await soon(anext(live)) == Ready(["Person"])
            await turns()
            assert asked() == 1

            # Down, and a failed attempt to return, and then back: one reopening.
            for state in ("reconnecting", "connecting", "reconnecting", "connecting"):
                transport.set_state(state)
                await turns()
            assert asked() == 1
            transport.set_state("open")
            await turns()
            assert asked() == 2

            # And each drop after it is another.
            transport.set_state("reconnecting")
            await turns()
            transport.set_state("open")
            await turns()
            assert asked() == 3

    run(scenario())


def test_b13b_an_event_that_carries_an_annotation_writes_it_where_it_was_or_at_the_end_and_asks_nothing() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        async with client, AsyncExitStack() as held:
            listed = await watched(held, client.browse.annotations(RESOURCE))
            before = len(transport.emitted)
            # One the list does not hold is added at its end, and is then an annotation the client holds.
            added = recorded("mark:body-updated", RESOURCE, {"annotationId": "ann-new"})
            added["annotation"] = annotation("ann-new", RESOURCE, modified="2026-10-06T02:00:00.000Z")
            transport.deliver(Frame(channel="mark:body-updated", payload=added))
            state = await soon(anext(listed))
            assert isinstance(state, Ready)
            assert [(each.id, each.modified) for each in state.value] == [(ANNOTATION, None), ("ann-new", "2026-10-06T02:00:00.000Z")]
            # One it holds is replaced where it was.
            transport.deliver(event("mark:body-updated", "enriched"))
            state = await soon(anext(listed))
            assert isinstance(state, Ready)
            assert [(each.id, each.modified) for each in state.value] == [
                (ANNOTATION, "2026-10-06T01:00:00.000Z"),
                ("ann-new", "2026-10-06T02:00:00.000Z"),
            ]
            await turns(20)
            assert len(transport.emitted) == before

            # The annotation it carried is the value of that annotation's own query, though nobody had asked for it.
            one = await held.enter_async_context(client.browse.annotation(RESOURCE, ANNOTATION))
            state_of_one = await soon(anext(one))
            assert isinstance(state_of_one, Ready)
            assert state_of_one.value.modified == "2026-10-06T01:00:00.000Z"
            await turns(20)
            assert len(transport.emitted) == before

            # And the annotation the first event carried is one of its resource's, though no query of it was ever named:
            # what is asked again of the resource's annotations is asked of it too, by a request that names the resource.
            transport.deliver(event("bus:resume-gap"))
            await turns(20)
            again = [frame.payload for frame in asked_for(transport, "browse:annotation-requested")]
            assert {"resourceId": RESOURCE, "annotationId": "ann-new"} in again
            before = len(transport.emitted)

            # An event about a resource whose list is not held writes no list.
            elsewhere = recorded("mark:body-updated", OTHER, {"annotationId": ELSEWHERE})
            elsewhere["annotation"] = annotation(ELSEWHERE, OTHER)
            transport.deliver(Frame(channel="mark:body-updated", payload=elsewhere))
            await turns(20)
            assert len(transport.emitted) == before
            unheld = await held.enter_async_context(client.browse.annotations(OTHER))
            assert await soon(anext(unheld)) == Pending()

    run(scenario())


def test_b13a_an_annotation_that_is_gone_ends_as_not_found_and_its_next_watcher_asks_naming_its_resource() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        async with client, AsyncExitStack() as held:
            one = await watched(held, client.browse.annotation(RESOURCE, ANNOTATION))
            asked = len(asked_for(transport, "browse:annotation-requested"))
            # One nobody holds is nobody's to end.
            transport.deliver(event("mark:delete-ok", of=ELSEWHERE))
            transport.deliver(event("mark:delete-ok"))
            state = await soon(anext(one))
            assert isinstance(state, Failed)
            assert (state.error.code, str(state.error)) == ("bus.not-found", f"Annotation {ANNOTATION} was removed")
            await turns(20)
            assert len(asked_for(transport, "browse:annotation-requested")) == asked

            # Which resource it was of is kept, so the request an arriving watcher makes can name it.
            await held.enter_async_context(client.browse.annotation(RESOURCE, ANNOTATION))
            assert await soon(anext(one)) == Pending()
            await turns()
            assert asked_for(transport, "browse:annotation-requested")[-1].payload == {"resourceId": RESOURCE, "annotationId": ANNOTATION}

    run(scenario())


def test_a_client_listens_while_it_is_held_and_not_before_or_after() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        # Before: a read works, a watcher is refused, and no event is heard.
        assert (await soon(client.browse.resource(RESOURCE).fresh())).name == "A resource"
        with pytest.raises(RuntimeError, match="inside its client's `async with`"):
            async with client.browse.resource(RESOURCE):
                pass
        assert transport.scopes == []
        transport.deliver(event("yield:updated"))
        await turns(20)
        assert len(asked_for(transport, "browse:resource-requested")) == 1

        async with client:
            transport.deliver(event("yield:updated"))
            await turns(20)
            assert len(asked_for(transport, "browse:resource-requested")) == 2

        # After: no event is heard, a watcher is given nothing, and a read is refused as closed.
        transport.deliver(event("yield:updated"))
        await turns(20)
        assert len(asked_for(transport, "browse:resource-requested")) == 2
        async with client.browse.resource(RESOURCE) as live:
            assert await soon(anext(live, None)) is None
        with pytest.raises(BusRequestError) as refused:
            await client.browse.resource(RESOURCE).fresh()
        assert refused.value.code == "bus.closed"
        assert asyncio.all_tasks() == {asyncio.current_task()}
        # And it is held once: not again, closed or not.
        with pytest.raises(RuntimeError, match="held once"):
            await client.__aenter__()

        again, _ = world()
        async with again:
            with pytest.raises(RuntimeError, match="held once"):
                await again.__aenter__()

        # A client closed without ever being held has nothing to watch, which is no fault.
        never, _ = world()
        await never.close()
        async with never.browse.resource(RESOURCE) as live:
            assert await soon(anext(live, None)) is None

    run(scenario())


def test_an_event_that_names_an_annotation_asks_for_that_one_and_one_that_names_none_for_each_held_of_its_resource() -> None:
    async def scenario() -> None:
        client, transport = world(window_ms=0)
        third = AnnotationId("ann-3")

        def annotations_asked_for(since: int) -> list[JsonValue]:
            return sorted((frame.payload["annotationId"] for frame in asked_for(transport, "browse:annotation-requested")[since:]), key=str)

        async with client, AsyncExitStack() as held:
            # Two annotations of one resource, and one of another.
            for resource, annotation_id in ((RESOURCE, ANNOTATION), (RESOURCE, third), (OTHER, ELSEWHERE)):
                await watched(held, client.browse.annotation(resource, annotation_id))
            since = len(asked_for(transport, "browse:annotation-requested"))

            # Its body was updated, and the event does not carry it: that annotation is asked for, and no other.
            transport.deliver(event("mark:body-updated", "unenriched"))
            await turns(20)
            assert annotations_asked_for(since) == [ANNOTATION]

            # The stream missed what was recorded of the resource: each annotation held of it is asked for, and no other resource's.
            since = len(asked_for(transport, "browse:annotation-requested"))
            transport.deliver(event("bus:resume-gap"))
            await turns(20)
            assert annotations_asked_for(since) == [ANNOTATION, third]

    run(scenario())


def test_closing_a_client_ends_every_querys_watcher_and_fails_every_read_still_waiting_as_closed() -> None:
    async def scenario() -> None:
        # The knowledge base has answered nothing when the client closes: every watcher is pending, and every read waiting.
        client, transport = world(answered=False)
        async with AsyncExitStack() as held:
            async with client:
                watching = [await held.enter_async_context(query) for query in everything(client)]
                for live in watching:
                    assert await soon(anext(live)) == Pending()
                reads = [asyncio.ensure_future(query.fresh()) for query in everything(client)]
                await turns()
            for live in watching:
                assert await soon(anext(live, None)) is None
            for read in reads:
                with pytest.raises(BusRequestError) as closed:
                    await soon(read)
                assert closed.value.code == "bus.closed"
            assert transport.scopes != []
        # Each watcher's hold on its resource's scope is let go when the watcher leaves, whatever became of the client.
        assert transport.scopes == []

        # Closed, it gives a watcher of any query nothing, refuses a read of any as closed, and asks the knowledge base nothing.
        asked = len(transport.emitted)
        for query in everything(client):
            async with query as live:
                assert await soon(anext(live, None)) is None
            with pytest.raises(BusRequestError) as closed:
                await soon(query.fresh())
            assert closed.value.code == "bus.closed"
        await turns(20)
        assert len(transport.emitted) == asked

    run(scenario())
