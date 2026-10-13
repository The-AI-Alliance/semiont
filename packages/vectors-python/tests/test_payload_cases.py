"""What a point of the index is, held to `specs/src/vectors/payload-cases.json` with no store.

The table is the one every implementation of the stores runs. Here
`semiont_vectors.payload` alone is held to all of it: the id a point is kept
under and its payload, whole, for each point a stored case states, in the
chunks' order; the stamp read from a payload, a resource's and an
annotation's; and the result read from one.

What a store answers after it was handed the same writes is the store
contract's (`store_contract.py`), which every store runs. What the table
states of Qdrant's collections is the Qdrant store's to be held to.
"""

from typing import Final

import pytest
from spec import SPEC, JsonObject, objects, read, strings, text, thing
from store_contract import (
    ANNOTATION_STORED,
    PAYLOAD_CASES,
    POINT,
    RESOURCE_STORED,
    annotation,
    chunks,
    machine_read,
    number,
    only,
    part,
    resource,
    written_annotation_stamp,
    written_result,
    written_stamp,
)

from semiont_vectors.payload import (
    ANNOTATION_STAMP_MEMBERS,
    annotation_key,
    annotation_of,
    annotation_payload,
    annotation_stamp_of,
    chunk_key,
    chunk_payload,
    qdrant_id,
    resource_of,
    result_of,
    stamp_of,
)
from semiont_vectors.store import AnnotationStamp

TABLE = read(SPEC / "vectors/payload-cases.json")
COLLECTIONS = thing(TABLE["collections"], "collections")

PARTS: Final[dict[str, tuple[str, ...]]] = {
    "resourceStored": RESOURCE_STORED,
    "annotationStored": ANNOTATION_STORED,
    "stampRead": ("payload", "stamp"),
    "annotationStampRead": ("payload", "stamp"),
    "resultRead": ("collection", "payload", "score", "result"),
}
"""Each part a case may be, and the members that part may have."""


def read_result(payload: JsonObject, score: float) -> JsonObject:
    """The result read from a payload at a score, as the table states one, whole."""
    found = result_of(payload, score)
    stated = written_result(found)
    stated["score"] = found.score
    return stated


def test_the_table_has_a_case_of_each_of_its_five_parts_and_each_case_is_of_one() -> None:
    only(TABLE, ("$comment", "collections", "cases"), "the table")
    for name in PARTS:
        assert part(name) != [], name
    for case in PAYLOAD_CASES:
        why = text(case["why"], "why")
        named = [name for name in PARTS if name in case]
        assert len(named) == 1, why
        only(case, ("why", *named), why)
        only(thing(case[named[0]], named[0]), PARTS[named[0]], why)


@pytest.mark.parametrize("given", part("resourceStored"))
def test_a_resources_chunks_stored(given: JsonObject) -> None:
    resource_id = resource(given)
    checksum = text(given["contentChecksum"], "contentChecksum")
    entity_types = strings(given["entityTypes"], "entityTypes")

    # One point for each chunk, in the chunks' order.
    for chunk, point in zip(chunks(given), objects(given["points"], "points"), strict=True):
        only(point, POINT, "a point")
        payload = chunk_payload(resource_id, chunk, checksum, entity_types, machine_read=machine_read(given))

        assert qdrant_id(chunk_key(resource_id, chunk.chunk_index)) == point["qdrantId"]
        assert payload == point["payload"]
        assert resource_of(payload) == resource_id
        assert annotation_of(payload) is None
        assert written_stamp(stamp_of(payload)) == given["stamp"]
        # A search by a point's own embedding scores it 1, which is the score the table states of every stored point.
        assert read_result(payload, 1.0) == point["result"]


@pytest.mark.parametrize("given", part("annotationStored"))
def test_an_annotation_stored(given: JsonObject) -> None:
    stated = annotation(given)
    point = thing(given["point"], "point")
    only(point, POINT, "the point")
    payload = annotation_payload(stated)

    assert qdrant_id(annotation_key(stated.annotation_id)) == point["qdrantId"]
    assert payload == point["payload"]
    assert resource_of(payload) == stated.resource_id
    assert annotation_of(payload) == stated.annotation_id
    assert annotation_stamp_of(payload) == AnnotationStamp(resource_id=stated.resource_id, entity_types=tuple(stated.entity_types))
    assert read_result(payload, 1.0) == point["result"]


@pytest.mark.parametrize("given", part("stampRead"))
def test_a_stamp_read(given: JsonObject) -> None:
    payload = thing(given["payload"], "payload")
    if "stamp" in given:
        assert resource_of(payload) == payload["resourceId"]
        assert written_stamp(stamp_of(payload)) == given["stamp"]
    else:
        # A point that names no resource is no resource's: no stamp is read from it, and a listing leaves it out.
        assert resource_of(payload) is None


@pytest.mark.parametrize("given", part("annotationStampRead"))
def test_an_annotations_stamp_read(given: JsonObject) -> None:
    payload = thing(given["payload"], "payload")
    if "stamp" in given:
        assert annotation_of(payload) == payload["annotationId"]
        assert written_annotation_stamp(annotation_stamp_of(payload)) == given["stamp"]
        # The members a listing asks a Qdrant for are all that is read: a payload of those alone says the same.
        asked_for = {member: value for member, value in payload.items() if member in ANNOTATION_STAMP_MEMBERS}
        assert annotation_of(asked_for) == annotation_of(payload)
        assert annotation_stamp_of(asked_for) == annotation_stamp_of(payload)
    else:
        # A point that names no annotation is no annotation's: no stamp is read from it, and a listing leaves it out.
        assert annotation_of(payload) is None


@pytest.mark.parametrize("given", part("resultRead"))
def test_a_result_read(given: JsonObject) -> None:
    # A result is read the same from a point of either collection: which one a case names changes nothing here.
    assert text(given["collection"], "collection") in COLLECTIONS
    payload = thing(given["payload"], "payload")
    assert read_result(payload, number(given["score"], "score")) == given["result"]
