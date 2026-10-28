"""The fold: what each recorded event does to the graph.

`docs/protocol/WEAVER.md` § The fold states each rule, and
`specs/src/weaver/fold-cases.json` holds every implementation to them.

The graph says what the record says. A resource is dated when its event was
recorded and is by whom the event records; an annotation is by the creator
its event records; a changed annotation is dated as changed when the change
was recorded. Nothing here reads a clock, and nothing here derives who a
thing is by from who sent its event: for work a person asked a worker for,
the sender is the worker.

Every event is applied so that applying it again changes nothing. A frame can
be delivered twice, and a history is replayed from its beginning whenever a
resource is rebuilt.
"""

from typing import Final, final

from pydantic import JsonValue
from semiont.channels import (
    MARK_ADDED,
    MARK_BODY_UPDATED,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
    MARK_REMOVED,
    YIELD_CREATED,
)
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import (
    AnnotationBody,
    BodyOperationAdd,
    BodyOperationRemove,
    Representation,
    ResourceDescriptor,
    SpecificResource,
    StoredEventResponse,
    TextualBody,
)
from semiont_graph.interface import GraphDatabase, ResourceChange

from semiont_weaver.log import LOG

__all__ = ["Refused", "apply", "said_of"]


@final
class Refused(Exception):
    """An event the graph cannot take as it is recorded. Its words say which event, and what it lacks."""


def said_of(event: StoredEventResponse) -> str:
    """An event, as a refusal and the log name it: its type, its id, and where it is in which resource's record."""
    return f"{event.type} {event.id} (resource {event.resource_id}, sequence {event.metadata.sequence_number})"


def _resource_of(event: StoredEventResponse) -> ResourceId:
    if event.resource_id is None:
        raise Refused(f"{said_of(event)} names no resource")
    return event.resource_id


def _created(event: StoredEventResponse) -> ResourceDescriptor:
    """The resource a `yield:created` records, as the graph is given it."""
    payload = YIELD_CREATED.event(event)
    if payload.was_attributed_to is None:
        # Who it is by is the record's to say, derived when the event was recorded. The graph makes none up.
        raise Refused(f"{said_of(event)} records no wasAttributedTo")
    return ResourceDescriptor(
        context="https://schema.org/",
        id=_resource_of(event),
        name=payload.name,
        entity_types=payload.entity_types or [],
        # The URI lives on the representation, its one home.
        representations=[
            Representation(media_type=payload.format, checksum=payload.content_checksum, rel="original", storage_uri=payload.storage_uri)
        ],
        archived=False,
        date_created=event.timestamp,
        was_attributed_to=payload.was_attributed_to,
    )


def _same_item(one: AnnotationBody, other: AnnotationBody) -> bool:
    """Whether two body items are the same item: of one type, with the same `source` or the same `value`."""
    if isinstance(one, SpecificResource):
        return isinstance(other, SpecificResource) and one.source == other.source
    return isinstance(other, TextualBody) and one.value == other.value


def _at(body: list[AnnotationBody], item: AnnotationBody) -> int | None:
    """Where in a body an item is. Nothing where it is not there."""
    return next((index for index, held in enumerate(body) if _same_item(held, item)), None)


_PASSED_BY: Final = "Annotation not in the graph: its body update is passed by"


async def _update_body(graph: GraphDatabase, event: StoredEventResponse) -> None:
    payload = MARK_BODY_UPDATED.event(event)
    current = await graph.get_annotation(payload.annotation_id)
    if current is None:
        LOG.warning(_PASSED_BY, extra={"annotationId": payload.annotation_id, "event": said_of(event)})
        return
    held = current.body
    body: list[AnnotationBody] = [] if held is None else [*held] if isinstance(held, list) else [held]
    for operation in payload.operations:
        if isinstance(operation, BodyOperationAdd):
            if _at(body, operation.item) is None:
                body.append(operation.item)
        elif isinstance(operation, BodyOperationRemove):
            at = _at(body, operation.item)
            if at is not None:
                del body[at]
        else:
            at = _at(body, operation.old_item)
            if at is not None:
                body[at] = operation.new_item
    items: list[JsonValue] = [written(item) for item in body]
    # `modified` is the moment the record says the body changed, which is what the record's view stamps on the annotation.
    await graph.update_annotation(payload.annotation_id, {"body": items, "modified": event.timestamp})


async def apply(graph: GraphDatabase, event: StoredEventResponse) -> None:
    """Apply one recorded event to the graph.

    Raises `Refused` for an event the graph cannot take as it is recorded,
    and whatever the store raises. An event of a type the Weaver does not
    follow changes nothing: a resource's history holds events that are the
    views' alone.
    """
    match event.type:
        case "yield:created":
            await graph.create_resource(_created(event))
        case "mark:archived":
            await graph.update_resource(_resource_of(event), ResourceChange(archived=True))
        case "mark:unarchived":
            await graph.update_resource(_resource_of(event), ResourceChange(archived=False))
        case "mark:added":
            annotation = MARK_ADDED.event(event).annotation
            # Made once: an annotation added again would lose every change made to its body since.
            if await graph.get_annotation(annotation.id) is not None:
                return
            if annotation.creator is None:
                # The record's creator is the party that asked. The graph makes none up.
                raise Refused(f"{said_of(event)} records annotation {annotation.id} with no creator")
            await graph.create_annotation(annotation)
        case "mark:removed":
            await graph.delete_annotation(MARK_REMOVED.event(event).annotation_id)
        case "mark:body-updated":
            await _update_body(graph, event)
        case "mark:entity-tag-added":
            resource_id, tag = _resource_of(event), MARK_ENTITY_TAG_ADDED.event(event).entity_type
            resource = await graph.get_resource(resource_id)
            # A resource's entity types are a set: one added twice is there once.
            if resource is not None and tag not in (resource.entity_types or ()):
                await graph.update_resource(resource_id, ResourceChange(entity_types=[*(resource.entity_types or ()), tag]))
        case "mark:entity-tag-removed":
            resource_id, tag = _resource_of(event), MARK_ENTITY_TAG_REMOVED.event(event).entity_type
            resource = await graph.get_resource(resource_id)
            if resource is not None:
                kept = [held for held in resource.entity_types or () if held != tag]
                await graph.update_resource(resource_id, ResourceChange(entity_types=kept))
        case _:
            pass
