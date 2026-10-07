"""The bus's vocabulary, as generated: every channel and every operation the registry states."""

import re
from typing import Annotated, Literal, get_args

import pytest
from pydantic import Field, JsonValue, ValidationError
from spec import SPEC, objects, read, text

import semiont.types
from semiont import channels, operations
from semiont.channel import Channel, Empty, Operation
from semiont.identifiers import AnnotationId, JobId, ResourceId, UserId
from semiont.model import WireModel
from semiont.types import (
    EnrichedResourceEvent,
    GatheredContext,
    GenerationJobParams,
    GenerationJobRequest,
    HighlightingJobParams,
    JobDeclinedResult,
    JobDetectionResult,
    JobGenerationResult,
    MarkDeleteCommand,
    MarkJobCompleteCommand,
    MarkJobCreateCommand,
    MarkJobQueuedEvent,
    StoredEventResponse,
    TaggingJobParams,
    YieldJobCompleteCommand,
    YieldJobCreateCommand,
    YieldJobQueuedEvent,
)

REGISTRY = read(SPEC / "bus/registry.json")
STATED = objects(REGISTRY["channels"], "channels")
BY_NAME = channels.CHANNELS


def constant(name: str) -> str:
    """`mark:assist-timeout` → `MARK_ASSIST_TIMEOUT`."""
    return re.sub(r"[^A-Za-z0-9]+", "_", name).upper()


def test_every_channel_of_the_registry_is_a_constant_under_its_own_name() -> None:
    names = [text(stated["channel"], "a channel's name") for stated in STATED]
    assert list(channels.CHANNEL_NAMES) == names
    assert list(get_args(channels.ChannelName.__value__)) == names
    assert list(BY_NAME) == names
    for name in names:
        assert BY_NAME[name].name == name
        assert getattr(channels, constant(name)) is BY_NAME[name]


def test_a_channel_s_payload_is_what_its_shape_says() -> None:
    for stated in STATED:
        channel = BY_NAME[text(stated["channel"], "a channel's name")]
        payload = channel.payload
        assert channel.members
        assert all(issubclass(member, WireModel) for member in channel.members)
        match stated["shape"]:
            case "schema":
                # The type the spec's schema of that name generated: a class, or a union of them under its own name.
                assert payload is getattr(semiont.types, text(stated["schema"], "a schema"))
            case "envelope":
                assert payload.__name__ == f"Response[{text(stated['schema'], 'a schema')}]"
            case "storedEvent":
                assert payload is (EnrichedResourceEvent if stated.get("enriched") is True else StoredEventResponse)
            case "void" | "empty":
                assert payload is Empty
            case other:
                raise AssertionError(f"a shape this test does not know: {other!r}")


def test_a_channel_whose_schema_is_one_of_several_carries_each_of_them() -> None:
    several: dict[str, list[str]] = {}
    for stated in STATED:
        if stated["shape"] != "schema":
            continue
        schema = read(SPEC / "components/schemas" / f"{text(stated['schema'], 'a schema')}.json")
        members = schema.get("oneOf", schema.get("anyOf"))
        if members is not None:
            named = [text(member["$ref"], "a member").removesuffix(".json").rpartition("/")[2] for member in objects(members, "members")]
            several[text(stated["channel"], "a channel's name")] = named
    assert several, "no channel carries one of several shapes: this reads nothing"
    for name, named in several.items():
        assert [member.__name__ for member in BY_NAME[name].members] == named
    # Every other channel carries one shape, its payload's own.
    for name, channel in BY_NAME.items():
        if name not in several:
            assert channel.members == (channel.payload,)


def test_every_operation_of_the_registry_names_its_three_channels() -> None:
    stated = objects(REGISTRY["operations"], "operations")
    by_request = operations.OPERATIONS
    assert list(by_request) == [text(entry["request"], "a request") for entry in stated]
    for entry in stated:
        operation = by_request[text(entry["request"], "a request")]
        assert getattr(operations, constant(text(entry["request"], "a request"))) is operation
        assert operation.request is BY_NAME[text(entry["request"], "a request")]
        assert operation.result is BY_NAME[text(entry["result"], "a result")]
        assert operation.failure is BY_NAME[text(entry["failure"], "a failure")]


def test_a_reply_states_one_shape_s_names_and_one_of_several_shapes_is_refused() -> None:
    assert operations.JOB_CREATE.reply_names == ()
    assert operations.GATHER_REQUESTED.reply_names == ("annotationId",)
    answered_by_several = Operation(request=channels.JOB_CREATE, result=channels.JOB_QUEUED, failure=channels.JOB_CREATE_FAILED)
    with pytest.raises(TypeError, match="job:queued answers with one of several shapes"):
        _ = answered_by_several.reply_names


def test_a_channel_decodes_what_it_carries_and_writes_it_by_the_wire_s_names() -> None:
    command = channels.MARK_DELETE.decode({"annotationId": "a-1", "resourceId": "res-1"})
    assert command == MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=ResourceId("res-1"))
    assert channels.MARK_DELETE.encode(command) == {"annotationId": "a-1", "resourceId": "res-1"}
    assert channels.MARK_DELETE.encode(MarkDeleteCommand(annotation_id=AnnotationId("a-1"))) == {"annotationId": "a-1"}
    assert type(BY_NAME["mark:delete"].decode({"annotationId": "a-1"})) is MarkDeleteCommand


def test_a_channel_refuses_what_is_not_its_payload() -> None:
    with pytest.raises(ValidationError):
        channels.MARK_DELETE.decode({"annotationId": "not an id"})
    with pytest.raises(ValidationError):
        channels.MARK_DELETE.decode({"resourceId": "res-1"})
    with pytest.raises(ValidationError):
        channels.MARK_CANCEL_PENDING.decode({"unexpected": True})


QUEUED: dict[str, JsonValue] = {"jobId": "job-1", "resourceId": "res-1", "userId": "did:web:example.org:users:alice"}
CONTEXT: dict[str, JsonValue] = {
    "focus": {
        "kind": "resource",
        "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []},
    },
    "graph": {"nodes": [], "edges": []},
    "metadata": {},
}


def test_a_frame_on_a_channel_of_several_shapes_decodes_to_the_one_it_names() -> None:
    tagging: dict[str, JsonValue] = {"motivation": "tagging", "schemaId": "s1", "categories": ["claim"]}
    marking = channels.JOB_QUEUED.decode({**QUEUED, "jobType": "mark", "params": tagging})
    assert marking == MarkJobQueuedEvent(
        job_id=JobId("job-1"),
        job_type="mark",
        resource_id=ResourceId("res-1"),
        user_id=UserId("did:web:example.org:users:alice"),
        params=TaggingJobParams(motivation="tagging", schema_id="s1", categories=["claim"]),
    )
    making = channels.JOB_QUEUED.decode({**QUEUED, "jobType": "yield", "params": {"title": "A summary", "storageUri": "file://a.md"}})
    assert type(making) is YieldJobQueuedEvent
    assert making.params == GenerationJobRequest(title="A summary", storage_uri="file://a.md")
    # By name too, for code that is given a name and not a constant.
    assert type(BY_NAME["job:queued"].decode({**QUEUED, "jobType": "mark", "params": tagging})) is MarkJobQueuedEvent


def test_a_channel_of_several_shapes_refuses_a_frame_that_names_none_of_them_or_is_not_the_one_it_names() -> None:
    with pytest.raises(ValidationError):
        channels.JOB_QUEUED.decode({**QUEUED, "jobType": "transcribe", "params": {"title": "A summary", "storageUri": "file://a.md"}})
    with pytest.raises(ValidationError):
        channels.JOB_QUEUED.decode({**QUEUED, "params": {"motivation": "highlighting"}})
    # A `mark` job is announced with a `mark` job's parameters.
    with pytest.raises(ValidationError):
        channels.JOB_QUEUED.decode({**QUEUED, "jobType": "mark", "params": {"title": "A summary", "storageUri": "file://a.md"}})
    # And a parameter its motivation does not take is refused.
    with pytest.raises(ValidationError):
        channels.JOB_CREATE.decode({"jobType": "mark", "resourceId": "res-1", "params": {"motivation": "highlighting", "tone": "kind"}})


def test_a_channel_of_several_shapes_writes_each_of_them() -> None:
    marking = MarkJobCreateCommand(
        job_type="mark", resource_id=ResourceId("res-1"), params=HighlightingJobParams(motivation="highlighting")
    )
    assert channels.JOB_CREATE.encode(marking) == {"jobType": "mark", "resourceId": "res-1", "params": {"motivation": "highlighting"}}
    assert channels.JOB_CREATE.decode(channels.JOB_CREATE.encode(marking)) == marking
    params = GenerationJobParams(title="A summary", storage_uri="file://a.md", context=GatheredContext.model_validate(CONTEXT))
    making = YieldJobCreateCommand(job_type="yield", params=params)
    assert channels.JOB_CREATE.encode(making) == {
        "jobType": "yield",
        "params": {"title": "A summary", "storageUri": "file://a.md", "context": CONTEXT},
    }
    assert channels.JOB_CREATE.decode(channels.JOB_CREATE.encode(making)) == making


def test_a_job_s_completion_is_read_as_its_verb_s_with_what_that_verb_reports() -> None:
    said: dict[str, JsonValue] = {"resourceId": "res-1", "jobId": "job-1"}
    generated: dict[str, JsonValue] = {"resourceId": "res-summary", "resourceName": "A summary", "truncated": False}
    marked = channels.JOB_COMPLETE.decode({**said, "jobType": "mark", "result": {"found": 3, "persisted": 2}})
    assert type(marked) is MarkJobCompleteCommand
    assert marked.result == JobDetectionResult(found=3, persisted=2)
    made = channels.JOB_COMPLETE.decode({**said, "jobType": "yield", "result": generated})
    assert type(made) is YieldJobCompleteCommand
    assert made.result == JobGenerationResult(resource_id=ResourceId("res-summary"), resource_name="A summary", truncated=False)
    # Either may have declined, and either may report nothing.
    declined: dict[str, JsonValue] = {"declined": True, "reason": "encrypted"}
    assert type(channels.JOB_COMPLETE.decode({**said, "jobType": "mark", "result": declined}).result) is JobDeclinedResult
    assert type(channels.JOB_COMPLETE.decode({**said, "jobType": "yield", "result": declined}).result) is JobDeclinedResult
    assert channels.JOB_COMPLETE.decode({**said, "jobType": "yield"}).result is None
    # A result that is the other verb's is not that job's completion.
    with pytest.raises(ValidationError):
        channels.JOB_COMPLETE.decode({**said, "jobType": "mark", "result": generated})
    with pytest.raises(ValidationError):
        channels.JOB_COMPLETE.decode({**said, "jobType": "yield", "result": {"found": 3, "persisted": 2}})


class Stamped(WireModel, frozen=True):
    """One of two shapes, which declares a stamp of the gateway's."""

    kind: Literal["stamped"]
    user_id: Annotated[str | None, Field(alias="_userId")] = None


class Bare(WireModel, frozen=True):
    """The other, which declares none."""

    kind: Literal["bare"]


type Either = Annotated[Stamped | Bare, Field(discriminator="kind")]
type Words = Annotated[str | int, Field(description="No shape of the protocol.")]


def test_a_channel_is_made_only_of_shapes_whose_stamps_are_the_same() -> None:
    # What the gateway stamps on a frame is kept or dropped before the frame is read, so it is the channel's to say and not the member's.
    with pytest.raises(TypeError, match="_userId"):
        Channel[Either]("test:either", Either)
    with pytest.raises(TypeError, match="not a shape"):
        Channel[Stamped]("test:words", Words)
