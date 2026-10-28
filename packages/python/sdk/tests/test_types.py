"""The protocol's shapes, as generated: typed by the kinds of id, named two ways, immutable."""

import inspect
from typing import TypeAliasType, get_args

import pytest
from pydantic import ValidationError
from spec import SPEC, JsonObject, objects, read, strings, text

import semiont.identifiers
import semiont.types
from semiont.identifiers import AnnotationId, JobId, ResourceId, UserId
from semiont.model import WireModel
from semiont.types import Annotation, MarkDeleteCommand, ResourceDescriptor

KINDS: dict[str, type[str]] = {"ResourceId": ResourceId, "AnnotationId": AnnotationId, "JobId": JobId, "UserId": UserId}

MODELS = [
    model
    for _, model in inspect.getmembers(semiont.types, inspect.isclass)
    if issubclass(model, WireModel) and model.__module__ == semiont.types.__name__
]


def mentions(annotation: object, kind: type[str]) -> bool:
    """Whether `kind` is anywhere in a field's type."""
    if annotation is kind:
        return True
    if isinstance(annotation, TypeAliasType):
        return mentions(annotation.__value__, kind)
    return any(mentions(part, kind) for part in get_args(annotation))


def test_every_schema_the_spec_names_is_a_type_here() -> None:
    """The drift gate compares the generator with itself; this is what holds it to the spec."""
    stated = sorted(path.stem for path in (SPEC / "components/schemas").glob("*.json"))
    assert len(stated) > 250
    missing = [name for name in stated if name not in KINDS and not hasattr(semiont.types, name)]
    assert missing == []
    assert all(hasattr(semiont.identifiers, name) for name in KINDS)
    unexported = [name for name in stated if name not in KINDS and name not in semiont.types.__all__]
    assert unexported == []


def test_a_property_named_for_a_kind_of_id_is_typed_by_it() -> None:
    """The rule `lint:spec-identifiers` holds the spec to, held of what was generated from it."""
    named = {
        wire: KINDS[text(kind["schema"], "a kind's schema")]
        for kind in objects(read(SPEC / "identifiers/kinds.json")["kinds"], "kinds")
        for wire in strings(kind["properties"], "a kind's properties")
    }
    held = 0
    loose: list[str] = []
    for model in MODELS:
        for name, field in model.model_fields.items():
            kind = named.get(field.alias or name)
            if kind is None:
                continue
            held += 1
            if not mentions(field.annotation, kind):
                loose.append(f"{model.__name__}.{name}: {field.annotation!r} is not a {kind.__name__}")
    assert loose == []
    assert held > 150, "the census found few id fields: it is reading the wrong thing"


def test_a_model_is_built_by_python_names_and_written_by_the_wires() -> None:
    command = MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=ResourceId("res-1"))
    assert command.model_dump(mode="json", exclude_unset=True) == {"annotationId": "a-1", "resourceId": "res-1"}
    assert MarkDeleteCommand.model_validate_json(b'{"annotationId":"a-1","resourceId":"res-1"}') == command
    assert type(command.annotation_id) is AnnotationId


def test_a_model_is_immutable() -> None:
    command = MarkDeleteCommand(annotation_id=AnnotationId("a-1"))
    with pytest.raises(ValidationError):
        # The plain assignment is refused by both checkers before it can run.
        command.__setattr__("annotation_id", AnnotationId("a-2"))


def test_decoding_refuses_an_id_its_kind_refuses() -> None:
    with pytest.raises(ValidationError):
        MarkDeleteCommand.model_validate_json(b'{"annotationId":"a b"}')


def test_an_annotation_survives_the_round_trip() -> None:
    wire = (
        b'{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"ann-1","motivation":"linking",'
        b'"target":{"source":"res-1","selector":[{"type":"TextQuoteSelector","exact":"Achilles"}]},'
        b'"body":[{"type":"TextualBody","value":"Person","purpose":"tagging"},{"type":"SpecificResource","source":"res-2","purpose":"linking"}],'
        b'"created":"2026-01-01T00:00:00Z"}'
    )
    annotation = Annotation.model_validate_json(wire)
    assert type(annotation.id) is AnnotationId
    assert Annotation.model_validate_json(annotation.model_dump_json(exclude_unset=True)) == annotation


def test_what_a_model_reads_it_writes_back_as_it_came() -> None:
    # A client hands on what it was sent. Text the spec gives a format (a
    # time, a URI) stays the text it was: a parsed time or URL is written back
    # in another spelling than it was read in.
    described: JsonObject = {
        "@context": "https://schema.org/",
        "@id": "res-1",
        "name": "Described",
        "representations": [
            {"mediaType": "text/plain", "created": "2026-10-06T05:04:06.111Z", "modified": "2026-10-06T05:04:06.123456789+02:00"}
        ],
        "license": "https://example.org",
        "isPartOf": ["HTTPS://Example.org/a b"],
        "dateCreated": "2026-10-06T05:04:06+00:00",
    }
    assert ResourceDescriptor.model_validate(described).model_dump(mode="json", exclude_unset=True) == described


def test_no_shape_is_typed_by_something_that_rewrites_what_it_reads() -> None:
    source = inspect.getsource(semiont.types)
    imported = {
        name.strip()
        for line in source.splitlines()
        if line.startswith("from pydantic import ")
        for name in line.split("import ")[1].split(",")
    }
    assert imported == {"JsonValue", "Field"}


def test_a_property_the_spec_says_may_be_null_may_be_null() -> None:
    held = 0
    refusing: list[str] = []
    for path in sorted((SPEC / "components/schemas").glob("*.json")):
        properties = read(path).get("properties")
        model = getattr(semiont.types, path.stem, None)
        if not isinstance(properties, dict) or not (inspect.isclass(model) and issubclass(model, WireModel)):
            continue
        by_wire = {field.alias or name: field for name, field in model.model_fields.items()}
        for wire, stated in properties.items():
            if isinstance(stated, dict) and stated.get("nullable") is True:
                held += 1
                if type(None) not in get_args(by_wire[wire].annotation):
                    refusing.append(f"{path.stem}.{wire}")
    assert refusing == []
    assert held >= 5, "the census found few nullable properties: it is reading the wrong thing"
