"""The graph's two codecs, held to `specs/src/graph/codec-cases.json`.

The table is the one every implementation of the codecs runs: what the graph
stores of an annotation and of a resource, what it reads back and what it
refuses are stated there once, and not once for each language.
"""

import json
from collections.abc import Mapping

import pytest
from pydantic import JsonValue, ValidationError
from semiont.annotations import body_source, entity_types
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import Annotation, ResourceDescriptor
from spec import SPEC, JsonObject, objects, read, strings, text, thing

from semiont_graph.codec import (
    decode_annotation,
    decode_resource,
    encode_annotation,
    encode_resource,
    intended_graph_annotation,
    resolved_body,
    updated_annotation,
)

PARTS = ("annotationStored", "annotationRead", "annotationUpdated", "referenceResolved", "resourceStored", "resourceRead")
CASES = objects(read(SPEC / "graph/codec-cases.json")["cases"], "cases")


def part(name: str) -> list[object]:
    """Each case of one part, named in a test's id by why the case is there."""
    return [pytest.param(thing(case[name], name), id=text(case["why"], "why")) for case in CASES if name in case]


def stated(stored: Mapping[str, object], json_keys: JsonObject) -> tuple[dict[str, object], JsonObject]:
    """A stored bag as the table states one: the plain properties as they are, and each JSON one as the value its string parses to.

    A serializer is free in its spacing and its key order, and the table holds it to neither.
    """
    plain = {key: value for key, value in stored.items() if key not in json_keys}
    parsed: JsonObject = {key: json.loads(str(value)) for key, value in stored.items() if key in json_keys}
    return plain, parsed


def row(properties: JsonValue) -> dict[str, str]:
    """An annotation's row as a store hands it to the codec: every property text."""
    return {key: text(value, key) for key, value in thing(properties, "properties").items()}


def test_the_table_has_a_case_of_each_of_its_six_parts_and_no_case_of_none() -> None:
    for name in PARTS:
        assert any(name in case for case in CASES), name
    for case in CASES:
        assert len([name for name in PARTS if name in case]) == 1, case["why"]


@pytest.mark.parametrize("given", part("annotationStored"))
def test_an_annotation_stored(given: JsonObject) -> None:
    holds = thing(given["holds"], "holds")
    try:
        annotation = Annotation.model_validate(given["annotation"])
    except ValidationError:
        # The one annotation of the table a typed codec is never handed: its body is the empty list, which the
        # protocol's own type refuses. What the table says of it, that nothing of a body is stored or read back,
        # is then the type's to hold.
        assert thing(given["annotation"], "annotation")["body"] == []
        assert "body" not in holds
        assert "source" not in thing(given["properties"], "properties")
        assert given["tags"] == []
        assert given["linksTo"] is None
        return
    stored = encode_annotation(annotation)
    json_keys = thing(given["json"], "json")

    assert stated(stored, json_keys) == (given["properties"], json_keys)
    assert sorted(entity_types(annotation)) == sorted(strings(given["tags"], "tags"))
    assert body_source(annotation.body) == given["linksTo"]
    assert written(intended_graph_annotation(annotation)) == holds
    assert written(decode_annotation(stored, strings(given["tags"], "tags"))) == holds


@pytest.mark.parametrize("given", part("annotationRead"))
def test_a_row_read(given: JsonObject) -> None:
    tags = strings(given["tags"], "tags")
    if "refused" in given:
        with pytest.raises(ValueError, match=text(given["refused"], "refused")):
            decode_annotation(row(given["properties"]), tags)
    else:
        assert written(decode_annotation(row(given["properties"]), tags)) == given["annotation"]


@pytest.mark.parametrize("given", part("annotationUpdated"))
def test_an_annotation_updated(given: JsonObject) -> None:
    current = Annotation.model_validate(given["current"])
    updates = thing(given["updates"], "updates")
    if "refused" in given:
        with pytest.raises(ValueError, match=text(given["refused"], "refused")):
            updated_annotation(current, updates)
    else:
        assert written(updated_annotation(current, updates)) == given["annotation"]


@pytest.mark.parametrize("given", part("referenceResolved"))
def test_a_reference_resolved(given: JsonObject) -> None:
    current = Annotation.model_validate(given["current"])
    resolved = resolved_body(current, ResourceId(text(given["source"], "source")))
    assert [written(item) for item in resolved] == given["body"]


@pytest.mark.parametrize("given", part("resourceStored"))
def test_a_resource_stored(given: JsonObject) -> None:
    resource = ResourceDescriptor.model_validate(given["resource"])
    if "refused" in given:
        with pytest.raises(ValueError, match=text(given["refused"], "refused")):
            encode_resource(resource)
        return
    stored = encode_resource(resource)
    json_keys = thing(given["json"], "json")

    assert stated(stored, json_keys) == (given["properties"], json_keys)
    assert written(decode_resource(stored)) == given["holds"]


@pytest.mark.parametrize("given", part("resourceRead"))
def test_a_resource_row_read(given: JsonObject) -> None:
    properties = thing(given["properties"], "properties")
    if "refused" in given:
        with pytest.raises(ValueError, match=text(given["refused"], "refused")):
            decode_resource(properties)
    else:
        assert written(decode_resource(properties)) == given["resource"]
