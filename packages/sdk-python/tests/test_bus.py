"""The bus typed by channel: what is written for a payload, what a frame is read as, and what a request gives."""

import logging
from collections.abc import Mapping

import pytest
from aio import run, soon
from kb import refusing
from pydantic import JsonValue, ValidationError

from semiont.bus import Bus, decoded, reply_channels_for
from semiont.channel import Empty
from semiont.channels import BECKON_FOCUS, BECKON_HOVER, JOB_CREATE, JOB_QUEUED, MARK_ADDED, MARK_CANCEL_PENDING, MARK_DELETE
from semiont.errors import BusRequestError, TransportError
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.model import stated, written
from semiont.operations import BROWSE_KB_REQUESTED, FRAME_ADD_ENTITY_TYPE, JOB_STATUS_REQUESTED, MARK_CREATE_REQUEST
from semiont.testing import FaultyTransport
from semiont.transport import Frame
from semiont.types import (
    BeckonFocusEvent,
    BeckonHoverEvent,
    BrowseKbRequest,
    CreateAnnotationRequest,
    FrameAddEntityTypeCommand,
    GatheredContext,
    GenerationJobParams,
    JobParams,
    JobStatusRequest,
    MarkCreateRequest,
    MarkDeleteCommand,
    MarkJobCreateCommand,
    MarkJobQueuedEvent,
    MatchSearchRequest,
    TaggingJobParams,
)

RESOURCE, ANNOTATION = ResourceId("res-1"), AnnotationId("ann-1")
CONTEXT: Mapping[str, JsonValue] = {
    "focus": {
        "kind": "resource",
        "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "description": None, "representations": []},
    },
    "graph": {"nodes": [], "edges": []},
    "metadata": {},
}


def test_an_option_given_as_nothing_is_not_sent_and_what_a_shape_holds_deeper_is_sent_as_it_came() -> None:
    # At its top, a field that may be left out and holds nothing is left out.
    assert written(MarkDeleteCommand(annotation_id=ANNOTATION, resource_id=None)) == {"annotationId": "ann-1"}
    assert written(BeckonFocusEvent(resource_id=RESOURCE)) == {"resourceId": "res-1"}
    # One that must be there says so when it holds nothing.
    assert written(BeckonHoverEvent(annotation_id=None)) == {"annotationId": None}
    # Deeper, what was read is written back as it was read: a null that came is a null that goes.
    request = MatchSearchRequest(resource_id=RESOURCE, reference_id=ANNOTATION, context=GatheredContext.model_validate(CONTEXT), limit=None)
    assert written(request) == {"resourceId": "res-1", "referenceId": "ann-1", "context": CONTEXT}


def test_a_shape_its_caller_made_says_only_what_it_holds_and_holds_what_it_held() -> None:
    context = GatheredContext.model_validate(CONTEXT)
    given = GenerationJobParams(title="A summary", storage_uri="file://a-summary.md", context=context, prompt=None, max_tokens=200)
    said = stated(given)
    assert type(said) is GenerationJobParams
    assert said.model_fields_set == {"title", "storage_uri", "context", "max_tokens"}
    assert (said.title, said.prompt, said.max_tokens) == ("A summary", None, 200)
    # What it holds is not read again, and is written as it came.
    assert said.context is context
    assert said.model_dump(mode="json", exclude_unset=True) == {
        "title": "A summary",
        "storageUri": "file://a-summary.md",
        "context": CONTEXT,
        "maxTokens": 200,
    }
    # One that must be there says so when it holds nothing; one of several shapes stays the one it is.
    assert stated(BeckonHoverEvent(annotation_id=None)).model_fields_set == {"annotation_id"}
    tagging = TaggingJobParams(motivation="tagging", schema_id="s1", categories=["claim"], language=None)
    assert stated(tagging) == TaggingJobParams(motivation="tagging", schema_id="s1", categories=["claim"])
    assert stated(tagging).model_fields_set == {"motivation", "schema_id", "categories"}
    # What a shape that admits more was given beyond what it declares, it still holds.
    held = stated(JobParams.model_validate({"resourceId": "res-1", "motivation": "tagging", "more": None}))
    assert written(held) == {"resourceId": "res-1", "motivation": "tagging", "more": None}


def test_an_emit_by_type_sends_its_channels_name_and_its_payload_as_the_wire_carries_it() -> None:
    async def scenario() -> None:
        transport = FaultyTransport(channels=())
        bus = Bus(transport)
        assert bus.transport is transport
        await bus.emit(BECKON_FOCUS, BeckonFocusEvent(annotation_id=ANNOTATION), scope=RESOURCE, correlation_id="cid-1")
        assert transport.emitted == [
            Frame(channel="beckon:focus", payload={"annotationId": "ann-1"}, correlation_id="cid-1", scope=RESOURCE)
        ]

    run(scenario())


def test_a_payload_is_read_without_the_stamps_its_channel_does_not_declare() -> None:
    # `_userId` is declared by a command's type, and is the bus's on an event's.
    stamped: dict[str, JsonValue] = {
        "annotationId": "ann-1",
        "_userId": "did:web:example.org:users:alice",
        "_trace": {"traceparent": "00-…"},
    }
    command = decoded(MARK_DELETE, stamped)
    assert (command.annotation_id, command.user_id) == ("ann-1", "did:web:example.org:users:alice")
    assert decoded(BECKON_FOCUS, stamped) == BeckonFocusEvent(annotation_id=ANNOTATION)
    # A payload that admits nothing it does not declare is still read, once the bus's stamps are off it.
    assert decoded(MARK_CANCEL_PENDING, {"_userId": "did:web:example.org:users:alice"}) == Empty()
    with pytest.raises(ValidationError):
        decoded(MARK_CANCEL_PENDING, {"more": 1})
    with pytest.raises(ValidationError):
        decoded(BECKON_HOVER, {"annotationId": 7})


def test_a_payload_that_is_one_of_several_shapes_is_read_without_the_stamps_none_of_them_declares() -> None:
    tagging: dict[str, JsonValue] = {"motivation": "tagging", "schemaId": "s1", "categories": ["claim"]}
    stamps: dict[str, JsonValue] = {"_userId": "did:web:example.org:users:alice", "_roles": ["worker"], "_trace": {"traceparent": "00-…"}}
    # A command declares who sent it and their roles, and admits nothing else: the stamp it does not declare is the bus's.
    create = decoded(JOB_CREATE, {"jobType": "mark", "resourceId": "res-1", "params": tagging, **stamps})
    assert type(create) is MarkJobCreateCommand
    assert (create.user_id, create.roles) == ("did:web:example.org:users:alice", ["worker"])
    # An announcement declares none of them.
    queued = decoded(
        JOB_QUEUED,
        {
            "jobId": "job-1",
            "jobType": "mark",
            "resourceId": "res-1",
            "userId": "did:web:example.org:users:bob",
            "params": tagging,
            **stamps,
        },
    )
    assert type(queued) is MarkJobQueuedEvent
    assert queued.user_id == "did:web:example.org:users:bob"
    assert written(queued) == {
        "jobId": "job-1",
        "jobType": "mark",
        "resourceId": "res-1",
        "userId": "did:web:example.org:users:bob",
        "params": tagging,
    }


def test_frames_by_type_carry_their_payload_decoded_and_who_emitted_them(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        transport = FaultyTransport(channels=("beckon:focus",))
        frames = Bus(transport).frames(BECKON_FOCUS)
        transport.deliver(
            Frame(
                channel="beckon:focus",
                payload={"annotationId": "ann-1", "_userId": "did:web:example.org:users:alice"},
                correlation_id="cid-1",
                scope=RESOURCE,
            )
        )
        transport.deliver(Frame(channel="beckon:focus", payload={"annotationId": {"not": "an id"}}))
        transport.deliver(Frame(channel="beckon:focus", payload={"resourceId": "res-1", "_userId": "not a DID"}))

        async with frames:
            first = await soon(anext(frames))
            assert first.payload == BeckonFocusEvent(annotation_id=ANNOTATION)
            assert (first.correlation_id, first.scope, first.user_id) == ("cid-1", RESOURCE, "did:web:example.org:users:alice")
            # What is not the channel's is not given, and the one after it is.
            second = await soon(anext(frames))
            assert (second.payload.resource_id, second.user_id) == (RESOURCE, None)
        # A reader that has left is given no more.
        assert [frame async for frame in frames] == []

        # A channel the transport can never deliver is refused at the call.
        with pytest.raises(BusRequestError) as refused:
            Bus(transport).frames(MARK_ADDED)
        assert refused.value.code == "bus.unsubscribed"

    with caplog.at_level(logging.WARNING, logger="semiont.bus"):
        run(scenario())
    assert len(caplog.records) == 1


def test_a_request_by_type_gives_its_operations_result_as_that_results_type() -> None:
    async def scenario() -> None:
        transport = FaultyTransport(channels=reply_channels_for(MARK_CREATE_REQUEST, BROWSE_KB_REQUESTED, FRAME_ADD_ENTITY_TYPE))
        bus = Bus(transport)

        transport.queue_reply("mark:create-request", [{"annotationId": "ann-9"}])
        request = CreateAnnotationRequest.model_validate({"motivation": "highlighting", "target": {"source": "res-1"}})
        created = await soon(bus.request(MARK_CREATE_REQUEST, MarkCreateRequest(resource_id=RESOURCE, request=request)))
        assert created.response.annotation_id == "ann-9"
        sent = transport.emitted[0]
        assert (sent.channel, dict(sent.payload)) == (
            "mark:create-request",
            {"resourceId": "res-1", "request": {"motivation": "highlighting", "target": {"source": "res-1"}}},
        )

        # A reply that carries no response is its channel's empty payload.
        transport.queue_reply("frame:add-entity-type", [None])
        await soon(bus.request(FRAME_ADD_ENTITY_TYPE, FrameAddEntityTypeCommand(tag="Person")))

        # A result that is not the operation's is said, and is not handed on as if it were.
        transport.queue_reply("browse:kb-requested", [{"name": 7}])
        with pytest.raises(TransportError, match="a payload on browse:kb-result is not that channel's") as undecodable:
            await soon(bus.request(BROWSE_KB_REQUESTED, BrowseKbRequest()))
        assert undecodable.value.code == "error"

        # A failure is the request's error, under the bus's code for it.
        transport.refuse_when(refusing("browse:kb-requested"))
        with pytest.raises(BusRequestError) as rejected:
            await soon(bus.request(BROWSE_KB_REQUESTED, BrowseKbRequest()))
        assert rejected.value.code == "bus.rejected"

    run(scenario())


def test_a_request_whose_replies_the_transport_does_not_carry_is_refused_before_anything_is_sent() -> None:
    async def scenario() -> None:
        transport = FaultyTransport(channels=("job:status-result",))
        with pytest.raises(BusRequestError) as refused:
            await soon(Bus(transport).request(JOB_STATUS_REQUESTED, JobStatusRequest(job_id=JobId("job-1"))))
        assert refused.value.code == "bus.unsubscribed"
        assert transport.emitted == []

    run(scenario())
