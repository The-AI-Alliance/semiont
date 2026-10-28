"""A knowledge base's answers and events, as small as their shapes allow: what a test of a client's queries scripts."""

import asyncio
from collections.abc import Mapping, Sequence
from typing import Final, assert_never, final, override

from pydantic import JsonValue
from spec import JsonObject

from semiont.identifiers import AnnotationId, ResourceId
from semiont.operations import OPERATIONS
from semiont.refresh import CacheQuery, CacheRefreshTrigger, CacheRefreshWhen
from semiont.testing import ContentCall, DropReply, FaultyTransport, GetAnnotations, InMemoryContent, Refuse, refuse_unscripted_operation
from semiont.transport import Content, ContentStream, ContentTransport, Frame, PutBinaryRequest, Upload
from semiont.types import AnchoredTextAnswer, GetAnnotationsResponse, GetResourceResponse

RESOURCE, OTHER = ResourceId("res-1"), ResourceId("res-2")
ANNOTATION, ELSEWHERE = AnnotationId("ann-1"), AnnotationId("ann-2")
"""An annotation of `RESOURCE`, and one of `OTHER`."""

LIMITS: Final = ("gather:limits-requested", "job:limits-requested", "match:limits-requested")

ASKS: Final[dict[CacheQuery, tuple[str, ...]]] = {
    "resource": ("browse:resource-requested",),
    "annotations": ("getAnnotations",),
    "annotation": ("browse:annotation-requested",),
    "events": ("browse:events-requested",),
    "referencedBy": ("gather:referenced-by-requested",),
    "resources": ("browse:resources-requested",),
    "matchedResources": ("match:resources-requested",),
    "entityTypes": ("browse:entity-types-requested",),
    "tagSchemas": ("browse:tag-schemas-requested",),
    "agents": ("browse:agents-requested", *LIMITS),
}
"""The operations each live query asks, or the read of the content transport it makes, as `surface.json` names that read."""


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
    "browse:resource-requested": {"resource": descriptor(RESOURCE), "lastSequence": 1},
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


def knowing_content() -> InMemoryContent:
    """A content transport that answers the annotations of `RESOURCE` and of `OTHER`, each as `RESOURCE`'s, as often as it is asked."""
    content = InMemoryContent()
    listed = GetAnnotationsResponse.model_validate({"annotations": [annotation(ANNOTATION, RESOURCE)], "total": 1})
    for resource in (RESOURCE, OTHER):
        content.seed_annotations(resource, listed)
    return content


@final
class SilentContent(ContentTransport):
    """A content transport that hears each read of a resource's annotations and answers none: the read waits until it is cancelled.

    A live query makes no other call of the content transport, and one is refused.
    """

    def __init__(self) -> None:
        self._calls: Final[list[ContentCall]] = []

    @property
    def calls(self) -> Sequence[ContentCall]:
        """Every read of a resource's annotations, in order."""
        return self._calls

    @override
    def put_binary(self, request: PutBinaryRequest) -> Upload:
        raise AssertionError("a live query uploads nothing")

    @override
    async def get_binary(self, resource_id: ResourceId) -> Content:
        raise AssertionError("a live query reads no bytes")

    @override
    async def get_binary_stream(self, resource_id: ResourceId) -> ContentStream:
        raise AssertionError("a live query reads no bytes")

    @override
    async def get_resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        raise AssertionError("a live query reads no description as linked data")

    @override
    async def get_annotations(self, resource_id: ResourceId) -> GetAnnotationsResponse:
        self._calls.append(GetAnnotations(resource_id))
        unanswered: asyncio.Future[GetAnnotationsResponse] = asyncio.get_running_loop().create_future()
        return await unanswered

    @override
    async def get_anchored_text(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        raise AssertionError("a live query reads no anchored text")


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
