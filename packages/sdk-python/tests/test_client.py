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

from semiont.bus import Bus
from semiont.channels import JOB_QUEUED
from semiont.client import ClientTiming, SemiontClient
from semiont.errors import BusRequestError, SemiontError, TransportError
from semiont.event_bus import EventBus
from semiont.events import Events
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.namespaces.browse import Collaborator
from semiont.running import Running
from semiont.testing import FaultyTransport, InMemoryContent, StubGateway, create_test_client
from semiont.transport import (
    ConnectionState,
    Content,
    Frame,
    FrameSink,
    PendingReply,
    ResourceHold,
    Transport,
)
from semiont.types import GatheredContext, JobStatusResponse, MatchSearchResult
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
        assert client.wire.transport is transport
        assert client.timing == ClientTiming()
        # Every frame the transport delivers is on the client's own bus.
        queued = client.job.queued()
        heard = client.bus.frames(JOB_QUEUED)
        transport.deliver(
            Frame(
                channel="job:queued",
                payload={"jobId": "job-1", "jobType": "generation", "resourceId": "res-1", "userId": "did:web:example.org:users:alice"},
            )
        )
        assert (await soon(anext(queued))).payload.job_id == "job-1"
        assert (await soon(anext(heard))).payload.job_type == "generation"

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
        described: JsonObject = {"resource": descriptor, "annotations": [], "entityReferences": []}
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


def test_the_collaborators_are_the_directory_with_each_models_limits_as_its_key_holders_report_them() -> None:
    async def scenario() -> None:
        client, transport = world()
        gemma: JsonObject = {"@type": "Software", "name": "ollama gemma2", "provider": "ollama", "model": "gemma2:27b"}
        same_model_elsewhere: JsonObject = {
            "provider": "elsewhere",
            "model": "claude",
            "limits": {"contextTokens": 7, "maxOutputTokens": 7},
        }
        said_again: JsonObject = {"provider": "ollama", "model": "gemma2:27b", "limits": {"contextTokens": 9, "maxOutputTokens": 9}}
        claude: JsonObject = {"@type": "Software", "name": "anthropic claude", "provider": "anthropic", "model": "claude"}
        alice: JsonObject = {"@type": "Person", "name": "Alice"}
        transport.queue_reply("browse:agents-requested", [{"agents": [{"agent": gemma}, {"agent": claude}, {"agent": alice}]}])
        # One key holder answers, with a model of the directory and one that is not in it. The others are down.
        # A model is its provider's: one of the same name under another is another model. And what is reported first stands.
        reported: JsonObject = {
            "limits": [
                same_model_elsewhere,
                {"provider": "ollama", "model": "gemma2:27b", "limits": {"contextTokens": 8192, "maxOutputTokens": 2048}},
                said_again,
                {"provider": "ollama", "model": "unlisted", "limits": {"contextTokens": 1, "maxOutputTokens": 1}},
            ]
        }
        transport.queue_reply("job:limits-requested", [reported])

        collaborators = await soon(client.browse.agents().fresh())
        assert [type(collaborator) for collaborator in collaborators] == [Collaborator] * 3
        assert [collaborator.entry.agent.name for collaborator in collaborators] == ["ollama gemma2", "anthropic claude", "Alice"]
        limits = collaborators[0].limits
        assert limits is not None
        assert (limits.context_tokens, limits.max_output_tokens) == (8192, 2048)
        # A holder that is down reports none: its models show no limits, and the directory is not held up by it.
        assert (collaborators[1].limits, collaborators[2].limits) == (None, None)
        # The directory is asked for first, and each key holder after it.
        assert [frame.channel for frame in transport.emitted] == [
            "browse:agents-requested",
            "gather:limits-requested",
            "job:limits-requested",
            "match:limits-requested",
        ]

        # A directory that cannot be had is the query's failure, whatever the key holders say.
        transport.refuse_when(refusing("browse:agents-requested"))
        with pytest.raises(BusRequestError):
            await soon(client.browse.agents().fresh())
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
        "type": "generation",
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

        transport.queue_reply("job:cancel-requested", [{"cancelled": 3}, {"cancelled": 1}])
        assert await soon(client.job.cancel_by_type("annotation")) == 3
        assert await soon(client.job.cancel(JobId("job-1"))) == 1
        await client.close()

    run(scenario())


# ── Text ────────────────────────────────────────────────────────────────


def text_of(data: bytes, content_type: str) -> str:
    async def scenario() -> str:
        made = create_test_client()
        made.content.seed(RESOURCE, Content(data=data, content_type=content_type))
        client = made.client
        try:
            representation = await client.browse.resource_representation(RESOURCE)
            assert (representation.data, representation.content_type) == (data, content_type)
            return await client.browse.resource_content(RESOURCE)
        finally:
            await client.close()

    return run(scenario())


@pytest.mark.parametrize(
    ("data", "content_type", "text"),
    [
        ("naïve café".encode(), "text/plain", "naïve café"),
        ("naïve café".encode(), "text/markdown; charset=UTF-8", "naïve café"),
        ("naïve café".encode("utf-16"), "text/plain; charset=utf-16", "naïve café"),
        # A leading byte-order mark is not part of the text.
        (b"\xef\xbb\xbfhello", "text/plain; charset=utf-8", "hello"),
        # A sequence the encoding does not have becomes U+FFFD.
        (b"caf\xe9", "text/plain; charset=utf-8", "caf\ufffd"),
        # What a browser reads Latin-1 as: windows-1252, of which it is a part.
        (b"caf\xe9 \x93quoted\x94", "text/plain; charset=iso-8859-1", "café “quoted”"),
        (b"caf\xe9", 'text/html; charset="latin1"; boundary=x', "café"),
        ("привет".encode("koi8-r"), "text/plain;charset=KOI8-R", "привет"),
    ],
    ids=[
        "no charset is UTF-8",
        "UTF-8",
        "UTF-16",
        "a byte-order mark",
        "a byte UTF-8 has not",
        "Latin-1",
        "quoted, with more after it",
        "KOI8-R",
    ],
)
def test_a_resources_text_is_read_in_the_charset_its_media_type_states(data: bytes, content_type: str, text: str) -> None:
    assert text_of(data, content_type) == text


def test_a_charset_there_is_no_decoder_for_is_refused_by_name() -> None:
    with pytest.raises(
        TransportError, match="The resource's text is x-unheard-of, which this build decodes no text from: read its bytes instead"
    ) as refused:
        text_of(b"hello", "text/plain; charset=x-unheard-of")
    assert refused.value.code == "error"
