"""A client's methods take what the surface table says they take, and give what it says they give."""

from typing import assert_never

from semiont.channels import BECKON_FOCUS
from semiont.client import SemiontClient
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.follow import JobCompleted, JobEvent, JobProgressed
from semiont.operations import MARK_DELETE
from semiont.types import (
    Annotation,
    BeckonHoverEvent,
    GenerationJobParams,
    HighlightingJobParams,
    MarkDeleteCommand,
    MarkSubmitEvent,
    ResourceDescriptor,
    TaggingJobParams,
)

type Client = SemiontClient[HttpTransport]


async def ids_the_wrong_way_round(client: Client, resource: ResourceId, annotation: AnnotationId) -> None:
    await client.mark.delete(annotation, resource)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def a_motivation_the_vocabulary_lacks(client: Client, resource: ResourceId) -> None:
    client.mark.delegate(resource, HighlightingJobParams(motivation="highlightning"))  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def a_parameter_its_motivation_does_not_take(client: Client, resource: ResourceId) -> None:
    client.mark.delegate(resource, HighlightingJobParams(motivation="highlighting", tone="scholarly"))  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]


def a_tagging_job_with_no_schema(client: Client, resource: ResourceId) -> None:
    client.mark.delegate(resource, TaggingJobParams(motivation="tagging", categories=["claim"]))  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]


def a_job_of_another_verb(client: Client, resource: ResourceId, params: GenerationJobParams) -> None:
    client.mark.delegate(resource, params)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def a_generation_of_a_mark_job_s_parameters(client: Client, params: HighlightingJobParams) -> None:
    client.yield_.delegate(params)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


async def a_completion_read_as_an_event(client: Client, resource: ResourceId, params: HighlightingJobParams) -> JobEvent:
    return await client.mark.delegate(resource, params)  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


async def a_type_of_job_the_vocabulary_lacks(client: Client) -> None:
    await client.job.cancel_by_type("annotation")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


async def an_order_no_directory_is_listed_in(client: Client) -> None:
    await client.browse.files("docs", sort="size")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


async def a_query_awaited(client: Client, resource: ResourceId) -> None:
    await client.browse.resource(resource)  # type: ignore[misc]  # pyright: ignore[reportGeneralTypeIssues]


async def an_answer_taken_for_another(client: Client, resource: ResourceId) -> Annotation:
    return await client.browse.resource(resource).fresh()  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


async def another_channel_s_payload(client: Client) -> None:
    await client.wire.emit(BECKON_FOCUS, BeckonHoverEvent(annotation_id=None))  # type: ignore[misc]  # pyright: ignore[reportArgumentType]


async def a_reply_taken_for_another(client: Client, annotation: AnnotationId) -> MarkSubmitEvent:
    return await client.wire.request(MARK_DELETE, MarkDeleteCommand(annotation_id=annotation))  # type: ignore[arg-type]  # pyright: ignore[reportReturnType]


async def a_frame_read_as_another_channel_s(client: Client) -> ResourceDescriptor:
    async for delivered in client.bus.frames(BECKON_FOCUS):
        return delivered.payload  # type: ignore[return-value]  # pyright: ignore[reportReturnType]
    raise LookupError


def a_job_s_event_left_unhandled(event: JobEvent) -> str:
    match event:
        case JobCompleted():
            return "complete"
        case JobProgressed():
            return "progress"
        case _:
            assert_never(event)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
