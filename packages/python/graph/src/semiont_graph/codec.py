"""The graph's two codecs: how an annotation, and a resource, become stored properties and back.

Every store keeps its own dialect: Cypher sets a map on a node, Gremlin
chains properties and keeps a list as a JSON string, the in-memory store
keeps a dictionary. What none of them owns is the shape: which properties a
row has and what each is called, which are required, how a selector is
serialized, and how a body is read back from tag edges and a link. That is
decided here, once, and `specs/src/graph/codec-cases.json` holds every
implementation of these codecs to one answer.

The graph is a purpose-built projection and not a copy of the record. It
holds of an annotation and of a resource what its queries need and nothing
else: an annotation's `wasAttributedTo` rides on nearly every annotation in
the record, and nothing of it is stored.

The codecs manufacture nothing. Absence is stored as absence and read back as
absence, and a row that lacks a required property is refused by that
property's name: it is never given a value the row does not hold.
"""

import contextlib
import json
from collections.abc import Iterable, Mapping
from typing import Final, NotRequired, TypedDict

from pydantic import JsonValue
from semiont.annotations import body_source, entity_types, exact_text, target_selector, target_source
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.resources import primary_representation
from semiont.types import (
    Agent,
    AgentPerson,
    Annotation,
    AnnotationBody,
    AnnotationSelector,
    Motivation,
    ResourceDescriptor,
    SpecificResource,
)

__all__ = [
    "LINKING",
    "ResourceProperties",
    "decode_annotation",
    "decode_resource",
    "encode_annotation",
    "encode_resource",
    "intended_graph_annotation",
    "resolved_body",
    "stored_annotation_type",
    "updated_annotation",
]

LINKING: Final[Motivation] = "linking"
"""The motivation of a reference: the one annotation whose link the graph draws."""


def _json(value: JsonValue) -> str:
    """A value as the stored text of a JSON property: nothing escaped that JSON does not ask to be, and no spacing."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# ── An annotation ──────────────────────────────────────────────────────


def stored_annotation_type(motivation: Motivation) -> str:
    """The stored `type` property. It restates the motivation, so it is derived from it here and nowhere else."""
    return "TextualBody" if motivation == "highlighting" else "SpecificResource"


def _stored_agent(agent: Agent) -> JsonValue:
    """An agent as the graph holds it: who, and not what a person is called.

    A person's name is the directory's. The record's annotation carries none
    for the one who asked, and the Archivist joins it onto every read from
    the people projection, where a person can change it. A graph that stored
    the name would hold a copy that goes stale, and a check of the graph
    against a read would call every annotation by a named person wrong.
    Software is not named on a read: its agent is stored as the record gives
    it.
    """
    stored = written(agent)
    if isinstance(agent, AgentPerson):
        stored.pop("name", None)
    return stored


def _as_written(selector: AnnotationSelector) -> JsonValue:
    """A selector as the wire carries it: one, or a list as it was given."""
    if isinstance(selector, list):
        items: list[JsonValue] = [written(item) for item in selector]
        return items
    return written(selector)


def encode_annotation(annotation: Annotation) -> dict[str, str]:
    """The annotation's stored properties. Its entity tags are not among them: those are edges, which a store writes.

    Raises `ValueError` for an annotation with no creator: the graph holds
    who an annotation is by, and makes no one up.
    """
    if annotation.creator is None:
        raise ValueError(f"Annotation {annotation.id} missing required field: creator")
    properties: dict[str, str] = {
        "id": annotation.id,
        "resourceId": target_source(annotation.target),
        "type": stored_annotation_type(annotation.motivation),
        "motivation": annotation.motivation,
        "creator": _json(_stored_agent(annotation.creator)),
        "created": annotation.created,
    }

    selector = target_selector(annotation.target)
    if selector is not None:
        properties["selector"] = _json(_as_written(selector))
        exact = exact_text(selector)
        if exact:
            # The quoted text, pulled out beside its selector.
            properties["exact"] = exact
    linked = body_source(annotation.body)
    if linked is not None:
        properties["source"] = linked
    if annotation.modified:
        properties["modified"] = annotation.modified
    generator = annotation.generator
    if generator is not None:
        if isinstance(generator, list):
            agents: list[JsonValue] = [_stored_agent(agent) for agent in generator]
            properties["generator"] = _json(agents)
        else:
            properties["generator"] = _json(_stored_agent(generator))
    return properties


def _selector(stored: str | None) -> JsonValue:
    """A stored selector, read. Nothing for a row that holds none, and for one that holds the empty object.

    The encoder writes no selector for an annotation of a whole resource. A
    row can hold `{}` there all the same, which is no selector the protocol
    names: read as absent, such a row is harmless.
    """
    if not stored:
        return None
    selector: JsonValue = json.loads(stored)
    return selector or None


def decode_annotation(properties: Mapping[str, str], tags: Iterable[str]) -> Annotation:
    """The annotation a row and its tag edges are: the row's `properties`, and the names its tag edges lead to.

    Tags are edges, and a store answers edges in no promised order. The
    codec states one, by code point, so that two readings of the same tags
    are the same annotation and a check of the graph never mistakes order for
    content. A body is read back as the tags, in that order, and then the
    link.

    Raises `ValueError` naming the property a row lacks, and pydantic's
    `ValidationError` for a row whose properties are no annotation of the
    protocol's.
    """
    identity = properties.get("id")
    if not identity:
        raise ValueError("Annotation missing required field: id")

    def required(name: str) -> str:
        value = properties.get(name)
        if not value:
            raise ValueError(f"Annotation {identity} missing required field: {name}")
        return value

    target: dict[str, JsonValue] = {"source": required("resourceId")}
    creator: JsonValue = json.loads(required("creator"))
    annotation: dict[str, JsonValue] = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": identity,
        "motivation": required("motivation"),
        "target": target,
        "creator": creator,
        "created": required("created"),
    }
    selector = _selector(properties.get("selector"))
    if selector is not None:
        target["selector"] = selector

    body: list[JsonValue] = [{"type": "TextualBody", "value": tag, "purpose": "tagging"} for tag in sorted(tags) if tag]
    linked = properties.get("source")
    if linked:
        body.append({"type": "SpecificResource", "source": linked, "purpose": "linking"})
    if body:
        annotation["body"] = body

    modified = properties.get("modified")
    if modified:
        annotation["modified"] = modified
    generator = properties.get("generator")
    if generator:
        # What made an annotation is advisory: a row whose generator is not JSON is still that annotation.
        with contextlib.suppress(json.JSONDecodeError):
            annotation["generator"] = json.loads(generator)
    return Annotation.model_validate(annotation)


def intended_graph_annotation(annotation: Annotation) -> Annotation:
    """What the graph is to hold of `annotation`: the codec's own statement of it, by way of both its halves.

    Whether the graph is right cannot be answered by comparing it with the
    record's annotation, which holds more than the graph stores. It is
    answered by comparing it with this. Widen or narrow what is stored and
    this follows: there is no second list to keep.
    """
    return decode_annotation(encode_annotation(annotation), entity_types(annotation))


def updated_annotation(current: Annotation, updates: Mapping[str, JsonValue]) -> Annotation:
    """The annotation an update leaves, as the graph is to hold it.

    `updates` names the fields that changed, by the names the wire gives
    them, each with what it now is. What the update leaves is the current
    annotation with those fields replaced, and a store writes that, whole:
    its row, its tag edges and its link. A body updated to the empty list is
    no body. The id stays the one the annotation was made under.

    An annotation belongs to one resource for good: the edge to it is written
    when the annotation is made and nothing writes it again. An update that
    names another resource is refused, with `ValueError`.
    """
    replaced: dict[str, JsonValue] = {**written(current), **updates, "id": current.id}
    if replaced.get("body") == []:
        del replaced["body"]
    updated = intended_graph_annotation(Annotation.model_validate(replaced))
    was_on, now_on = target_source(current.target), target_source(updated.target)
    if was_on != now_on:
        raise ValueError(f"Annotation {current.id} belongs to {was_on}; an update cannot move it to {now_on}")
    return updated


def resolved_body(current: Annotation, source: ResourceId) -> list[AnnotationBody]:
    """The body of a reference resolved to `source`: its link replaced by one to `source`, and its entity tags kept."""
    body = current.body
    items = [] if body is None else body if isinstance(body, list) else [body]
    kept: list[AnnotationBody] = [item for item in items if not isinstance(item, SpecificResource)]
    return [*kept, SpecificResource(type="SpecificResource", source=source, purpose="linking")]


# ── A resource ─────────────────────────────────────────────────────────


class ResourceProperties(TypedDict):
    """A resource's stored properties, by the names the graph gives them."""

    id: str
    name: str
    entityTypes: list[str]
    format: str
    """The media type of the resource's primary representation."""
    archived: bool
    created: str
    """When the record says the resource was created."""
    creator: str
    """Who the resource is by (`wasAttributedTo`), as JSON."""
    contentChecksum: str
    storageUri: NotRequired[str]


def _attribution(attributed: Agent | list[Agent]) -> JsonValue:
    """Who a resource is by, as the wire carries it: one agent, or a list as it was given."""
    if isinstance(attributed, list):
        agents: list[JsonValue] = [written(agent) for agent in attributed]
        return agents
    return written(attributed)


def encode_resource(resource: ResourceDescriptor) -> ResourceProperties:
    """The resource's stored properties.

    Raises `ValueError` for a resource with no name, date, attribution,
    representation, media type or checksum, by the field's name: such a
    resource is refused on the way in, and not stored and found unreadable
    on the way out.
    """
    identity = resource.id

    def refused(field: str) -> ValueError:
        return ValueError(f"Resource {identity} missing required field: {field}")

    representation = primary_representation(resource)
    if representation is None:
        raise refused("representations")
    if not resource.name:
        raise refused("name")
    if not representation.media_type:
        raise refused("representations.mediaType")
    if not resource.date_created:
        raise refused("dateCreated")
    if resource.was_attributed_to is None:
        raise refused("wasAttributedTo")
    if not representation.checksum:
        raise refused("representations.checksum")

    properties: ResourceProperties = {
        "id": identity,
        "name": resource.name,
        "entityTypes": list(resource.entity_types or ()),
        "format": representation.media_type,
        "archived": resource.archived is True,
        "created": resource.date_created,
        "creator": _json(_attribution(resource.was_attributed_to)),
        "contentChecksum": representation.checksum,
    }
    if representation.storage_uri:
        # The URI lives on the representation, its one home.
        properties["storageUri"] = representation.storage_uri
    return properties


def decode_resource(properties: Mapping[str, object]) -> ResourceDescriptor:
    """The resource a row is. `properties` is what a store hands back, by the codec's names, and is trusted in nothing.

    Raises `ValueError` naming the property a row lacks, and pydantic's
    `ValidationError` for a row whose properties are no resource of the
    protocol's.
    """
    identity = properties.get("id")
    if not isinstance(identity, str) or not identity:
        raise ValueError("Resource missing required field: id")

    def required(name: str) -> object:
        value = properties.get(name)
        if value is None or value == "":
            raise ValueError(f"Resource {identity} missing required field: {name}")
        return value

    def text(name: str) -> str:
        value = required(name)
        if not isinstance(value, str):
            raise ValueError(f"Resource {identity} holds {name} as something that is not text")
        return value

    representation: dict[str, object] = {"mediaType": text("format"), "checksum": text("contentChecksum"), "rel": "original"}
    storage_uri = properties.get("storageUri")
    if storage_uri:
        representation["storageUri"] = storage_uri
    attributed: JsonValue = json.loads(text("creator"))
    return ResourceDescriptor.model_validate(
        {
            "@context": "https://schema.org/",
            "@id": identity,
            "name": text("name"),
            "entityTypes": required("entityTypes"),
            "representations": [representation],
            "archived": required("archived"),
            "dateCreated": text("created"),
            "wasAttributedTo": attributed,
        }
    )
