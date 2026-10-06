"""A client's methods take what the surface table says they take, and give what it says they give."""

from typing import assert_never

from semiont.channels import BECKON_FOCUS
from semiont.client import SemiontClient
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.follow import JobCompleted, JobEvent, JobProgressed
from semiont.namespaces.mark import MarkAssistOptions
from semiont.operations import MARK_DELETE
from semiont.types import Annotation, BeckonHoverEvent, MarkDeleteCommand, MarkSubmitEvent, ResourceDescriptor

type Client = SemiontClient[HttpTransport]


async def ids_the_wrong_way_round(client: Client, resource: ResourceId, annotation: AnnotationId) -> None:
    await client.mark.delete(annotation, resource)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def a_motivation_the_vocabulary_lacks(client: Client, resource: ResourceId) -> None:
    client.mark.assist(resource, "highlightning", MarkAssistOptions())  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


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
