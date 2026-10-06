"""A live query's state is one of three, its value is the query's own, and it is held, not awaited."""

from typing import assert_never

from semiont.cache import CacheState, Failed, Pending, Ready
from semiont.client import SemiontClient
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import Annotation, ResourceDescriptor

type Client = SemiontClient[HttpTransport]


def a_failure_left_unhandled(state: CacheState[list[Annotation]]) -> int:
    match state:
        case Pending():
            return 0
        case Ready(value=annotations):
            return len(annotations)
        case _:
            assert_never(state)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def a_failure_read_for_its_value(failed: Failed) -> object:
    return failed.value  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]


async def a_value_taken_for_another_query_s(client: Client, resource: ResourceId) -> ResourceDescriptor:
    async with client.browse.annotations(resource) as live:
        async for state in live:
            if isinstance(state, Ready):
                return state.value  # type: ignore[return-value]  # pyright: ignore[reportReturnType]
    raise LookupError


async def a_query_of_an_annotation_by_its_resource_alone(client: Client, resource: ResourceId) -> None:
    async with client.browse.annotation(resource, resource):  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
        pass


async def an_annotation_s_id_where_a_resource_s_belongs(client: Client, annotation: AnnotationId) -> None:
    client.gather.referenced_by(annotation).invalidate()  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
