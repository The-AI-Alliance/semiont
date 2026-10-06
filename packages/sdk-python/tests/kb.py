"""A knowledge base's answers and events, as small as their shapes allow: what a test of a client's queries scripts."""

from typing import Final, assert_never

from pydantic import JsonValue
from spec import JsonObject

from semiont.identifiers import AnnotationId, ResourceId
from semiont.refresh import CacheQuery, CacheRefreshTrigger, CacheRefreshWhen
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


def answers(times: int = 50) -> dict[str, list[JsonValue]]:
    """An answer to every operation a live query asks, `times` over. A resource or an annotation is answered as `RESOURCE`'s."""
    page: JsonObject = {"resources": [], "total": 0, "offset": 0, "limit": 100}
    each: dict[str, JsonValue] = {
        "browse:resource-requested": {"resource": descriptor(RESOURCE), "annotations": [], "entityReferences": []},
        "browse:annotations-requested": {"annotations": [annotation(ANNOTATION, RESOURCE)], "total": 1},
        "browse:annotation-requested": {"annotation": annotation(ANNOTATION, RESOURCE), "resource": None, "resolvedResource": None},
        "browse:events-requested": {"events": [], "total": 0, "resourceId": RESOURCE},
        "gather:referenced-by-requested": {"referencedBy": []},
        "browse:resources-requested": page,
        "match:resources-requested": {**page, "matchKind": "lexical"},
        "browse:entity-types-requested": {"entityTypes": ["Person"]},
        "browse:tag-schemas-requested": {"tagSchemas": []},
        "browse:agents-requested": {"agents": []},
        **{holder: {"limits": []} for holder in LIMITS},
    }
    return {operation: [answer] * times for operation, answer in each.items()}


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
