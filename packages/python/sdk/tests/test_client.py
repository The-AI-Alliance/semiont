"""A client: what it is built of, what its namespaces add to what they send, and how it ends.

What each method sends is `test_surface.py`'s. Here is what a case of the
table cannot state: what is made of an answer, and what a method does when
something else fails.
"""

import asyncio
import gc
import logging
from collections.abc import Collection, Mapping
from typing import final, override

import pytest
from aio import run, soon, turns
from kb import refusing, silent
from pydantic import JsonValue
from spec import JsonObject

from semiont.bus import Bus, Delivered
from semiont.channels import JOB_QUEUED
from semiont.client import ClientTiming, SemiontClient
from semiont.errors import BusRequestError, SemiontError, TransportError
from semiont.event_bus import EventBus
from semiont.events import Events
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.namespaces.browse import EngineWithLimits
from semiont.running import Running
from semiont.testing import FaultyTransport, GetAnchoredText, InMemoryContent, StubGateway, create_test_client
from semiont.transport import (
    ConnectionState,
    Content,
    Frame,
    FrameSink,
    PendingReply,
    ResourceHold,
    Transport,
)
from semiont.types import AnchoredTextAbsent, GatheredContext, JobStatusResponse, MatchSearchResult
from semiont.watched import Watched

RESOURCE = ResourceId("res-1")
CONTEXT: JsonObject = {
    "focus": {
        "kind": "resource",
        "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []},
    },
    "graph": {"nodes": [], "edges": []},
    "metadata": {},
}

type Client = SemiontClient[FaultyTransport]


@final
class Down(Transport):
    """A transport whose wire is down: whatever is emitted through it is refused, and said to have been."""

    def __init__(self) -> None:
        self._beneath = FaultyTransport()
        self.refused: list[str] = []
        """The channel of each emit it refused."""

    @property
    @override
    def base_url(self) -> str:
        return self._beneath.base_url

    @override
    async def emit(
        self, channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        self.refused.append(channel)
        raise TransportError.without_response("the wire is down")

    @override
    def frames(self, channel: str) -> Events[Frame]:
        return self._beneath.frames(channel)

    @override
    def is_subscribed(self, channel: str) -> bool:
        return self._beneath.is_subscribed(channel)

    @override
    def subscribe_to_resource(self, resource_id: ResourceId) -> ResourceHold:
        return self._beneath.subscribe_to_resource(resource_id)

    @property
    @override
    def state(self) -> Watched[ConnectionState]:
        return self._beneath.state

    @override
    def failures(self) -> Events[SemiontError]:
        return self._beneath.failures()

    @override
    def track_reply(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        return self._beneath.track_reply(correlation_id, reply_channels)

    @override
    def bridge_into(self, bus: FrameSink) -> None:
        self._beneath.bridge_into(bus)

    @override
    async def close(self) -> None:
        await self._beneath.close()


def world(transport: FaultyTransport | None = None) -> tuple[Client, FaultyTransport]:
    """A client over a gateway that answers each operation what the test queues for it, and refuses what it queued nothing for."""
    made = create_test_client(transport=transport)
    return made.client, made.transport


def test_a_client_is_its_namespaces_over_one_transport_and_a_bus_of_its_own() -> None:
    async def scenario() -> None:
        client, transport = world()
        assert client.transport is transport
        assert isinstance(client.bus, EventBus)
        assert isinstance(client.wire, Bus)
        assert client.timing == ClientTiming()
        # Every frame the transport delivers is on the client's own bus.
        queued = client.job.queued()
        heard = client.bus.frames(JOB_QUEUED)
        transport.deliver(
            Frame(
                channel="job:queued",
                payload={
                    "jobId": "job-1",
                    "jobType": "yield",
                    "resourceId": "res-1",
                    "userId": "did:web:example.org:users:alice",
                    "params": {"title": "A summary", "storageUri": "file://a-summary.md"},
                },
            )
        )
        announced, read = await soon(anext(queued)), await soon(anext(heard))
        assert isinstance(announced, Delivered)
        assert isinstance(read, Delivered)
        assert (announced.payload.job_id, read.payload.job_type) == ("job-1", "yield")

        async with client:
            pass
        # Closed, its own bus has ended, and it is not held again.
        assert client.bus.destroyed
        assert await anext(queued, None) is None
        with pytest.raises(RuntimeError, match="held once"):
            await client.__aenter__()
        await client.close()
        # It did not close the transport: whoever opened that closes it.
        assert transport.state.value == "open"

    run(scenario())


def test_a_signal_never_reaches_the_wire_and_a_report_does_without_being_awaited(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        client, transport = world()
        clicked = client.bus.frames_on("browse:click")
        client.browse.click(AnnotationId("ann-1"))
        assert dict((await soon(anext(clicked))).payload) == {"annotationId": "ann-1"}
        assert transport.emitted == []

        client.browse.resource_viewed(RESOURCE)
        assert transport.emitted == []
        await turns()
        assert [(frame.channel, dict(frame.payload), frame.correlation_id) for frame in transport.emitted] == [
            ("browse:resource-viewed", {"resourceId": "res-1"}, None)
        ]
        await client.close()

        # A report the transport could not send is the transport's to tell of: nothing is raised to nobody.
        down = Down()
        unheard: SemiontClient[Down] = SemiontClient(down, InMemoryContent(), StubGateway())
        unheard.browse.resource_viewed(RESOURCE)
        await turns()
        assert down.refused == ["browse:resource-viewed"]
        await unheard.close()

    with caplog.at_level(logging.ERROR, logger="asyncio"):
        run(scenario())
        # A task that ended with a failure nobody took is said so when it is let go.
        gc.collect()
    assert [record.getMessage() for record in caplog.records] == []


# ── What is made of an answer ───────────────────────────────────────────


def test_a_query_asks_when_its_fresh_is_called_and_gives_the_part_of_the_answer_it_is_of() -> None:
    async def scenario() -> None:
        client, transport = world()
        descriptor: JsonObject = {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []}
        described: JsonObject = {"resource": descriptor, "lastSequence": 1}
        transport.queue_reply("browse:resource-requested", [described] * 2)
        transport.queue_reply("browse:entity-types-requested", [{"entityTypes": ["Person", "Place"]}])
        transport.queue_reply("gather:referenced-by-requested", [{"referencedBy": []}])

        query = client.browse.resource(RESOURCE)
        # Building it touches nothing.
        await turns()
        assert transport.emitted == []
        assert (await soon(query.fresh())).name == "A resource"
        # Each fresh read asks again.
        assert (await soon(query.fresh())).id == "res-1"
        assert [frame.channel for frame in transport.emitted] == ["browse:resource-requested"] * 2
        assert await soon(client.browse.entity_types().fresh()) == ["Person", "Place"]
        assert await soon(client.gather.referenced_by(RESOURCE).fresh()) == []
        # A failure is raised.
        transport.refuse_when(refusing("browse:tag-schemas-requested"))
        with pytest.raises(BusRequestError):
            await soon(client.browse.tag_schemas().fresh())
        await client.close()

    run(scenario())


def test_the_engines_are_the_knowledge_bases_with_each_engines_limits_as_its_key_holders_report_them() -> None:
    async def scenario() -> None:
        client, transport = world()
        gemma: JsonObject = {"provider": "ollama", "model": "gemma2:27b"}
        claude: JsonObject = {"provider": "anthropic", "model": "claude"}
        llama: JsonObject = {"provider": "ollama", "model": "llama3"}
        same_model_elsewhere: JsonObject = {
            "engine": {"provider": "openai", "model": "claude"},
            "limits": {"contextTokens": 7, "maxOutputTokens": 7},
        }
        said_again: JsonObject = {"engine": gemma, "limits": {"contextTokens": 9, "maxOutputTokens": 9}}
        transport.queue_reply("browse:engines-requested", [{"engines": [{"engine": gemma}, {"engine": claude}, {"engine": llama}]}])
        # One key holder answers, with an engine of the knowledge base's and one that is not. The others are down.
        # An engine is a provider and a model: a model of the same name under another provider is another engine.
        # And what is reported first stands.
        reported: JsonObject = {
            "limits": [
                same_model_elsewhere,
                {"engine": gemma, "limits": {"contextTokens": 8192, "maxOutputTokens": 2048}},
                said_again,
                {"engine": {"provider": "ollama", "model": "unlisted"}, "limits": {"contextTokens": 1, "maxOutputTokens": 1}},
            ]
        }
        transport.queue_reply("job:limits-requested", [reported])

        engines = await soon(client.browse.engines().fresh())
        assert [type(engine) for engine in engines] == [EngineWithLimits] * 3
        assert [(each.entry.engine.provider, each.entry.engine.model) for each in engines] == [
            ("ollama", "gemma2:27b"),
            ("anthropic", "claude"),
            ("ollama", "llama3"),
        ]
        limits = engines[0].limits
        assert limits is not None
        assert (limits.context_tokens, limits.max_output_tokens) == (8192, 2048)
        # A holder that is down reports none: its engines show no limits, and the engines are not held up by it.
        assert (engines[1].limits, engines[2].limits) == (None, None)
        # The engines are asked for first, and each key holder after them.
        assert [frame.channel for frame in transport.emitted] == [
            "browse:engines-requested",
            "gather:limits-requested",
            "job:limits-requested",
            "match:limits-requested",
        ]

        # Engines that cannot be had are the query's failure, whatever the key holders say.
        transport.refuse_when(refusing("browse:engines-requested"))
        with pytest.raises(BusRequestError):
            await soon(client.browse.engines().fresh())
        await client.close()

    run(scenario())


def test_a_searchs_failure_says_what_went_wrong_in_the_words_it_was_given() -> None:
    async def scenario() -> None:
        # The test answers this one itself.
        client, transport = world(silent())
        searching = client.match.search(RESOURCE, AnnotationId("ann-1"), GatheredContext.model_validate(CONTEXT))
        # Nothing is sent until the operation is awaited or read.
        await turns()
        assert transport.emitted == []

        task = asyncio.ensure_future(awaited(searching))
        await turns()
        asked = transport.emitted[0]
        # A search's failure says what went wrong under `error`, where every other operation's says it under `message`.
        transport.deliver(
            Frame(
                channel="match:search-failed",
                payload={"referenceId": "ann-1", "error": "the index is rebuilding"},
                correlation_id=asked.correlation_id,
            )
        )
        with pytest.raises(BusRequestError, match="the index is rebuilding") as failed:
            await soon(task)
        assert failed.value.failure is not None
        assert failed.value.failure["referenceId"] == "ann-1"
        await client.close()

    run(scenario())


async def awaited(searching: Running[MatchSearchResult]) -> MatchSearchResult:
    return await searching


def test_a_request_waits_as_long_as_its_client_was_told_and_a_closed_client_ends_what_it_was_doing() -> None:
    async def scenario() -> None:
        transport = silent()
        client: Client = SemiontClient(transport, InMemoryContent(), StubGateway(), timing=ClientTiming(bus_request_ms=40))
        # Nobody answers: the request is over when the client's own wait is.
        with pytest.raises(BusRequestError) as late:
            await soon(client.browse.kb(), within=2.0)
        assert late.value.code == "bus.timeout"

        patient: Client = SemiontClient(transport, InMemoryContent(), StubGateway())
        searching = asyncio.ensure_future(
            awaited(patient.match.search(RESOURCE, AnnotationId("ann-1"), GatheredContext.model_validate(CONTEXT)))
        )
        patient.browse.resource_viewed(RESOURCE)
        await turns()
        # Closing ends what it had started, and whoever awaited it is told the client closed.
        await patient.close()
        with pytest.raises(BusRequestError) as closed:
            await soon(searching, within=2.0)
        assert (closed.value.code, closed.value.message) == ("bus.closed", "The client closed before the operation ended")
        await client.close()

    run(scenario())


def status(of: str) -> JsonObject:
    return {
        "jobId": "job-1",
        "type": "yield",
        "status": of,
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-01T00:00:00.000Z",
    }


def test_a_jobs_status_is_asked_for_until_it_has_ended_and_each_answer_is_given_to_whoever_watches() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("pending"), status("running"), status("complete")])
        watched: list[JobStatusResponse] = []
        ended = await soon(client.job.poll_until_complete(JobId("job-1"), every_ms=5, within_ms=5_000, on_status=watched.append))
        assert ended.status == "complete"
        assert [answer.status for answer in watched] == ["pending", "running", "complete"]

        # One that has not ended in time fails as a timeout, having been asked at least once.
        transport.queue_reply("job:status-requested", [status("running")] * 50)
        with pytest.raises(BusRequestError, match="Job polling timeout after 30ms") as late:
            await soon(client.job.poll_until_complete(JobId("job-1"), every_ms=10, within_ms=30))
        assert late.value.code == "bus.timeout"

        transport.queue_reply("job:cancel-requested", [{"cancelled": True}])
        assert await soon(client.job.cancel(JobId("job-1"))) is True
        await client.close()

    run(scenario())


# ── Text ────────────────────────────────────────────────────────────────
#
# What text a resource's bytes are is test_decode_cases.py's, by the two tables every reader of one runs.


def test_a_resources_representation_is_its_bytes_as_stored_whatever_text_they_are() -> None:
    # UTF-16LE behind its mark, stored as UTF-8: the representation is the bytes and what they were stored as,
    # and the content is the text the bytes are.
    data, content_type = b"\xff\xfeh\x00i\x00", "text/plain; charset=utf-8"

    async def scenario() -> None:
        made = create_test_client()
        made.content.seed(RESOURCE, Content(data=data, content_type=content_type))
        client = made.client
        try:
            representation = await client.browse.resource_representation(RESOURCE)
            assert (representation.data, representation.content_type) == (data, content_type)
            assert await client.browse.resource_content(RESOURCE) == "hi"
        finally:
            await client.close()

    run(scenario())


def test_a_resources_anchored_text_is_what_the_content_transport_answers_and_is_not_asked_for_on_the_bus() -> None:
    # An absence is an answer, and is given as one.
    not_yet = AnchoredTextAbsent(kind="not-yet")

    async def scenario() -> None:
        made = create_test_client()
        made.content.seed_anchored_text(RESOURCE, not_yet)
        client = made.client
        try:
            assert await client.browse.resource_anchored_text(RESOURCE) is not_yet
            assert made.content.calls == [GetAnchoredText(RESOURCE)]
            assert made.transport.emitted == []
        finally:
            await client.close()

    run(scenario())
