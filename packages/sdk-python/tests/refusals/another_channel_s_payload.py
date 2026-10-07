"""A channel carries its own payload and no other's."""

from semiont import channels, operations
from semiont.channel import Channel, Operation
from semiont.identifiers import AnnotationId
from semiont.model import WireModel
from semiont.types import MarkDeleteCommand, MarkJobCreateCommand, MarkSubmitEvent


def emit[P: WireModel](channel: Channel[P], payload: P) -> None:
    raise NotImplementedError


def request[Request: WireModel, Result: WireModel, Failure: WireModel](
    operation: Operation[Request, Result, Failure], payload: Request
) -> Result:
    raise NotImplementedError


def emitted() -> None:
    emit(channels.MARK_SUBMIT, MarkDeleteCommand(annotation_id=AnnotationId("a-1")))  # type: ignore[misc]  # pyright: ignore[reportArgumentType]


def requested(payload: MarkSubmitEvent) -> None:
    request(operations.MARK_DELETE, payload)  # type: ignore[misc]  # pyright: ignore[reportArgumentType]


def emitted_on_a_channel_of_several_shapes_and_none_of_them(payload: MarkDeleteCommand) -> None:
    emit(channels.JOB_CREATE, payload)  # type: ignore[misc]  # pyright: ignore[reportArgumentType]


def a_channel_of_several_shapes_taken_for_a_channel_of_one() -> Channel[MarkJobCreateCommand]:
    return channels.JOB_CREATE  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def a_reply_taken_for_another() -> MarkSubmitEvent:
    return request(operations.MARK_DELETE, MarkDeleteCommand(annotation_id=AnnotationId("a-1")))  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def one_channel_taken_for_another() -> Channel[MarkDeleteCommand]:
    return channels.MARK_SUBMIT  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def a_channel_whose_two_statements_of_its_payload_disagree() -> Channel[MarkDeleteCommand]:
    return Channel[MarkDeleteCommand]("mark:delete", MarkSubmitEvent)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
