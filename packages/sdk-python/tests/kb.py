"""A knowledge base's answers and events, as small as their shapes allow: what a test of a client's queries scripts."""

from collections.abc import Mapping
from typing import Final, assert_never

from pydantic import JsonValue
from spec import JsonObject

from semiont.identifiers import AnnotationId, ResourceId
from semiont.operations import OPERATIONS
from semiont.refresh import CacheQuery, CacheRefreshTrigger, CacheRefreshWhen
from semiont.testing import DropReply, FaultyTransport, Refuse, refuse_unscripted_operation
from semiont.transport import Frame

RESOURCE, OTHER = ResourceId("res-1"), ResourceId("res-2")
ANNOTATION, ELSEWHERE = AnnotationId("ann-1"), AnnotationId("ann-2")
"""An annotation of `RESOURCE`, and one of `OTHER`."""

LIMITS: Final = ("gather:limits-requested", "job:limits-requested", "match:limits-requested")

ASKS: Final[dict[CacheQuery, tuple[str, ...]]] = {
    "resource": ("browse:resource-requested",),
    "annotations": ("browse:annotations-requested",),
    "annotation": ("browse:annotation-requested",),
    "events": ("browse:events-requested",),
    "referencedBy": ("gather:referenced-by-requested",),
    "resources": ("browse:resources-requested",),
    "matchedResources": ("match:resources-requested",),
    "entityTypes": ("browse:entity-types-requested",),
    "tagSchemas": ("browse:tag-schemas-requested",),
    "agents": ("browse:agents-requested", *LIMITS),
}
"""The operations each live query asks."""


def descriptor(resource: str, name: str = "A resource") -> JsonObject:
    return {"@context": "https://schema.org", "@id": resource, "name": name, "representations": []}


def annotation(annotation_id: str, resource: str, modified: str | None = None) -> JsonObject:
    stated: JsonObject = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": annotation_id,
        "motivation": "highlighting",
        "target": resource,
        "created": "2026-10-06T00:00:00.000Z",
    }
    if modified is not None:
        stated["modified"] = modified
    return stated


_PAGE: Final[JsonObject] = {"resources": [], "total": 0, "offset": 0, "limit": 100}
_ANSWERS: Final[dict[str, JsonValue]] = {
    "browse:resource-requested": {"resource": descriptor(RESOURCE), "annotations": [], "entityReferences": []},
    "browse:annotations-requested": {"annotations": [annotation(ANNOTATION, RESOURCE)], "total": 1},
    "browse:annotation-requested": {"annotation": annotation(ANNOTATION, RESOURCE), "resource": None, "resolvedResource": None},
    "browse:events-requested": {"events": [], "total": 0, "resourceId": RESOURCE},
    "gather:referenced-by-requested": {"referencedBy": []},
    "browse:resources-requested": _PAGE,
    "match:resources-requested": {**_PAGE, "matchKind": "lexical"},
    "browse:entity-types-requested": {"entityTypes": ["Person"]},
    "browse:tag-schemas-requested": {"tagSchemas": []},
    "browse:agents-requested": {"agents": []},
    **{holder: {"limits": []} for holder in LIMITS},
}


def knowing(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
    """What a small knowledge base answers each operation a live query asks, as often as it is asked.

    A resource or an annotation is answered as `RESOURCE`'s. Another
    operation is refused by name, as a transport nobody scripted refuses it.
    """
    if operation not in _ANSWERS:
        refuse_unscripted_operation(operation, payload)
    return _ANSWERS[operation]


def silent() -> FaultyTransport:
    """A transport whose gateway hears each request and says nothing a client hears: the test answers each itself."""
    return FaultyTransport([DropReply()], make_response=lambda operation, payload: None)


def refusing(*operations: str) -> Refuse:
    """A gateway that answers each of `operations` with a failure, and refuses no other."""

    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"code": "rejected", "message": f"the scripted gateway refuses {operation}"} if operation in operations else None

    return refuse


def asked_for(transport: FaultyTransport, operation: str) -> list[Frame]:
    """The requests of one operation, in the order they were made."""
    return [frame for frame in transport.emitted if frame.channel == operation]


def answer(transport: FaultyTransport, request: Frame, response: JsonValue) -> None:
    """Answer a request with `response`, as the service that answers its operation would: naming what the request named."""
    operation = OPERATIONS[request.channel]
    reply: dict[str, JsonValue] = {named: request.payload[named] for named in operation.reply_names}
    transport.deliver(Frame(channel=operation.result.name, payload={**reply, "response": response}, correlation_id=request.correlation_id))


def refuse(transport: FaultyTransport, request: Frame, message: str = "the service refused") -> None:
    """Answer a request with a failure."""
    refused: JsonObject = {"code": "rejected", "message": message}
    transport.deliver(Frame(channel=OPERATIONS[request.channel].failure.name, payload=refused, correlation_id=request.correlation_id))


def recorded(kind: str, resource: str | None, payload: JsonObject | None = None) -> JsonObject:
    """A recorded event, as the stream carries it."""
    event: JsonObject = {
        "id": "evt-1",
        "type": kind,
        "timestamp": "2026-10-06T00:00:00.000Z",
        "userId": "did:web:example.org:users:alice",
        "version": 1,
        "payload": {} if payload is None else payload,
        "metadata": {"sequenceNumber": 1},
    }
    if resource is not None:
        event["resourceId"] = resource
    return event


def event(trigger: CacheRefreshTrigger, when: CacheRefreshWhen | None = None, *, resource: str = RESOURCE, of: str = ANNOTATION) -> Frame:
    """An event that is `trigger`, about `resource` and its annotation `of`. The stream carries one on its resource's scope."""
    scope = ResourceId(resource)
    match trigger:
        case "reopened":
            raise AssertionError("a reopening is no event")
        case "bus:resume-gap":
            return Frame(channel=trigger, payload={"scope": resource, "lastSeenId": "p-1", "reason": "retention-exceeded"})
        case "mark:delete-ok":
            return Frame(channel=trigger, payload={"response": {"annotationId": of}}, correlation_id="cid-delete")
        case "mark:removed":
            return Frame(channel=trigger, payload=recorded(trigger, resource, {"annotationId": of}), scope=scope)
        case "mark:body-updated":
            updated = recorded(trigger, resource, {"annotationId": of})
            if when == "enriched":
                updated["annotation"] = annotation(of, resource, modified="2026-10-06T01:00:00.000Z")
            return Frame(channel=trigger, payload=updated, scope=scope)
        case "mark:added" | "mark:entity-tag-added" | "mark:entity-tag-removed" | "mark:archived" | "mark:unarchived":
            return Frame(channel=trigger, payload=recorded(trigger, resource), scope=scope)
        case "yield:created" | "yield:updated" | "yield:cloned" | "yield:moved":
            # Heard by every client, on no scope.
            return Frame(channel=trigger, payload=recorded(trigger, resource))
        case "frame:entity-type-added" | "frame:tag-schema-added":
            return Frame(channel=trigger, payload=recorded(trigger, None))
        case _:
            assert_never(trigger)
