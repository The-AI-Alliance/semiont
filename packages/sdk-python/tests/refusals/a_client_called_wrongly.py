"""A client's methods take what the surface table says they take, and give what it says they give."""

from typing import assert_never

from semiont.channels import BECKON_FOCUS, MARK_ADDED
from semiont.client import SemiontClient
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.follow import Delegation, JobCompleted, JobEvent, JobProgressed
from semiont.operations import MARK_DELETE
from semiont.types import (
    Annotation,
    BeckonHoverEvent,
    GenerationJobParams,
    HighlightingJobParams,
    JobDeclinedResult,
    JobGenerationResult,
    MarkDeleteCommand,
    MarkJobCompleteCommand,
    MarkSubmitEvent,
    ResourceDescriptor,
    TaggingJobParams,
    YieldJobCompleteCommand,
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


async def a_completion_read_as_an_event(
    client: Client, resource: ResourceId, params: HighlightingJobParams
) -> JobEvent[MarkJobCompleteCommand]:
    return await client.mark.delegate(resource, params)  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def a_mark_job_taken_for_a_yield_job(
    client: Client, resource: ResourceId, params: HighlightingJobParams
) -> Delegation[YieldJobCompleteCommand]:
    return client.mark.delegate(resource, params)  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


async def a_mark_job_s_completion_taken_for_a_yield_job_s(
    client: Client, resource: ResourceId, params: HighlightingJobParams
) -> YieldJobCompleteCommand:
    return await client.mark.delegate(resource, params)  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def the_resource_made(reported: JobGenerationResult) -> ResourceId:
    return reported.resource_id


async def a_mark_job_read_for_the_resource_it_made(client: Client, resource: ResourceId, params: HighlightingJobParams) -> None:
    reported = (await client.mark.delegate(resource, params)).result
    # What a `mark` job reports that is no decline is its counts: what a generation reports is not among what it may be.
    if reported is not None and not isinstance(reported, JobDeclinedResult):
        the_resource_made(reported)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


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


def a_resource_s_channel_read_for_no_resource(client: Client) -> None:
    client.wire.frames(MARK_ADDED)  # type: ignore[call-overload]  # pyright: ignore[reportArgumentType]


async def a_frame_read_as_another_channel_s(client: Client) -> ResourceDescriptor:
    async for delivered in client.bus.frames(BECKON_FOCUS):
        return delivered.payload  # type: ignore[return-value]  # pyright: ignore[reportReturnType]
    raise LookupError


def a_job_s_event_left_unhandled(event: JobEvent[MarkJobCompleteCommand]) -> str:
    match event:
        case JobCompleted():
            return "complete"
        case JobProgressed():
            return "progress"
        case _:
            assert_never(event)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
