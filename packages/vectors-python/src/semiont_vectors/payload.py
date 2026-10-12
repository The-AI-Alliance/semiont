"""What a point of the index is: the key it is kept under, its payload, and how a stamp and a search result are read from a payload.

A point one implementation wrote is read by another, so this is stated once
and every store goes through it: `specs/src/vectors/payload-cases.json` holds
it, and the tests run that table.

A payload has the members named here and no other. It does not say which
model made the vector or how the text was cut. `machineRead` is `true` on a
point whose text was read from pixels and is not there otherwise: it is never
`false`.
"""

import hashlib
from collections.abc import Mapping, Sequence
from typing import Final

from pydantic import JsonValue
from semiont.identifiers import AnnotationId, ResourceId

from semiont_vectors.store import AnnotationPayload, EmbeddingChunk, ResourceStamp, VectorSearchResult

__all__ = [
    "STAMP_MEMBERS",
    "Payload",
    "annotation_key",
    "annotation_of",
    "annotation_payload",
    "chunk_key",
    "chunk_payload",
    "qdrant_id",
    "resource_of",
    "result_of",
    "stamp_of",
]

type Payload = dict[str, JsonValue]
"""What a point says of itself, as it is stored."""

STAMP_MEMBERS: Final = ("resourceId", "contentChecksum", "entityTypes", "machineRead")
"""The members of a payload a stamp is read from, and the one that says whose stamp it is."""


def chunk_key(resource_id: ResourceId, chunk_index: int) -> str:
    """The key of a chunk's point: the resource's id, a hyphen, and the chunk's index in decimal digits."""
    return f"{resource_id}-{chunk_index}"


def annotation_key(annotation_id: AnnotationId) -> str:
    """The key of an annotation's point: its id."""
    return str(annotation_id)


def qdrant_id(key: str) -> str:
    """The id Qdrant keeps a point under, which must be a UUID or a whole number.

    It is the MD5 of the key's UTF-8 bytes, written in a UUID's groups with
    no bit changed to mark a version or a variant. So it is no version of
    UUID, and `uuid.uuid3` and `uuid.uuid5` give other ids.
    """
    # Not a use of MD5 that anything's safety rests on, and said so: a Python built to refuse the others still makes it.
    digits = hashlib.md5(key.encode("utf-8"), usedforsecurity=False).hexdigest()
    return f"{digits[:8]}-{digits[8:12]}-{digits[12:16]}-{digits[16:20]}-{digits[20:]}"


def chunk_payload(
    resource_id: ResourceId, chunk: EmbeddingChunk, content_checksum: str, entity_types: Sequence[str], *, machine_read: bool
) -> Payload:
    """The payload of one chunk's point. The entity types are carried in the order given, and the checksum as it is given."""
    types: list[JsonValue] = [*entity_types]
    payload: Payload = {
        "resourceId": str(resource_id),
        "chunkIndex": chunk.chunk_index,
        "text": chunk.text,
        "contentChecksum": content_checksum,
        "entityTypes": types,
    }
    if machine_read:
        payload["machineRead"] = True
    return payload


def annotation_payload(annotation: AnnotationPayload) -> Payload:
    """The payload of an annotation's point. The text it quotes is its `text`, as a chunk's is."""
    types: list[JsonValue] = [*annotation.entity_types]
    payload: Payload = {
        "annotationId": str(annotation.annotation_id),
        "resourceId": str(annotation.resource_id),
        "motivation": annotation.motivation,
        "entityTypes": types,
        "text": annotation.exact_text,
    }
    if annotation.machine_read:
        payload["machineRead"] = True
    return payload


def resource_of(payload: Mapping[str, JsonValue]) -> ResourceId | None:
    """The resource a point is of. `None` for a payload that names none: such a point is no resource's.

    Raises `InvalidIdentifier` for a name that is no resource's id.
    """
    named = payload.get("resourceId")
    return ResourceId(named) if isinstance(named, str) else None


def annotation_of(payload: Mapping[str, JsonValue]) -> AnnotationId | None:
    """The annotation a point is of. `None` for a payload that names none, as a chunk's does not.

    Raises `InvalidIdentifier` for a name that is no annotation's id.
    """
    named = payload.get("annotationId")
    return AnnotationId(named) if isinstance(named, str) else None


def _entity_types(payload: Mapping[str, JsonValue]) -> tuple[str, ...] | None:
    """The entity types a payload states, in its order. `None` for a payload that states none."""
    stated = payload.get("entityTypes")
    if not isinstance(stated, list):
        return None
    return tuple(entity_type for entity_type in stated if isinstance(entity_type, str))


def stamp_of(payload: Mapping[str, JsonValue]) -> ResourceStamp:
    """What a point's payload says of its resource as a whole. The chunk's index and its text are no part of it.

    A payload with no checksum gives a stamp with none, and one with no
    entity types gives an empty list of them.
    """
    checksum = payload.get("contentChecksum")
    return ResourceStamp(
        content_checksum=checksum if isinstance(checksum, str) else None,
        entity_types=_entity_types(payload) or (),
        machine_read=payload.get("machineRead") is True,
    )


def result_of(payload: Mapping[str, JsonValue], score: float) -> VectorSearchResult:
    """What a search answers of a point: the score the search gave it, and what its payload says.

    A result says neither which chunk it is, nor the checksum, nor an
    annotation's motivation. Raises `ValueError` for a payload that names no
    resource or has no text: a search has nothing to answer of such a point.
    """
    resource_id = resource_of(payload)
    if resource_id is None:
        raise ValueError("a point's payload names no resource")
    text = payload.get("text")
    if not isinstance(text, str):
        raise ValueError(f"a point of {resource_id} has a payload with no text")
    return VectorSearchResult(
        score=score,
        resource_id=resource_id,
        text=text,
        annotation_id=annotation_of(payload),
        entity_types=_entity_types(payload),
        machine_read=payload.get("machineRead") is True,
    )
