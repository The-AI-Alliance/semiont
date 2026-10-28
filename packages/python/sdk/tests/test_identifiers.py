"""The kinds of id, held to the cases every SDK runs (`specs/src/identifiers/kinds.json`).

Each string a kind accepts makes a value of its type, and each it refuses does
not, by every way a value is made: the constructor, `parse`, and decoding. The
types are generated from the same table and each kind's schema, so nothing here
states the rule a second time.
"""

import pytest
from pydantic import TypeAdapter, ValidationError
from spec import SPEC, objects, read, text

from semiont.identifiers import AnnotationId, InvalidIdentifier, JobId, ResourceId, UserId

type Kind = type[ResourceId] | type[AnnotationId] | type[JobId] | type[UserId]

# Each kind's type. A kind the table names and this does not is a kind no test holds.
KINDS: dict[str, Kind] = {
    "ResourceId": ResourceId,
    "AnnotationId": AnnotationId,
    "JobId": JobId,
    "UserId": UserId,
}

TABLE = objects(read(SPEC / "identifiers/kinds.json")["kinds"], "kinds")


def cases(side: str) -> list[tuple[str, str, str]]:
    """Each `(kind, string, why)` the table lists under `accepts` or `refuses`."""
    return [
        (text(kind["schema"], "a kind's schema"), text(case["id"], "a case's id"), text(case["why"], "a case's why"))
        for kind in TABLE
        for case in objects(kind[side], side)
    ]


def test_every_kind_the_table_names_is_held() -> None:
    assert {text(kind["schema"], "a kind's schema") for kind in TABLE} == set(KINDS)


def test_each_kind_states_the_rule_its_schema_states() -> None:
    for name, kind in KINDS.items():
        assert read(SPEC / f"components/schemas/{name}.json")["pattern"] == kind.PATTERN


@pytest.mark.parametrize(("name", "string", "why"), cases("accepts"))
def test_a_kind_accepts(name: str, string: str, why: str) -> None:
    kind = KINDS[name]
    made = kind(string)
    assert made == string, why
    assert type(made) is kind
    assert type(kind.parse(string)) is kind
    assert type(TypeAdapter(kind).validate_python(string)) is kind
    assert type(TypeAdapter(kind).validate_json(TypeAdapter(str).dump_json(string))) is kind


@pytest.mark.parametrize(("name", "string", "why"), cases("refuses"))
def test_a_kind_refuses(name: str, string: str, why: str) -> None:
    kind = KINDS[name]
    with pytest.raises(InvalidIdentifier) as refused:
        kind(string)
    assert refused.value.kind == name, why
    assert refused.value.value == string
    assert kind.parse(string) is None
    with pytest.raises(ValidationError):
        TypeAdapter(kind).validate_python(string)
    with pytest.raises(ValidationError):
        TypeAdapter(kind).validate_json(TypeAdapter(str).dump_json(string))


def test_one_kind_is_not_another_at_run_time() -> None:
    # A type checker already refuses to ask whether a `ResourceId` is an
    # `AnnotationId`; this asks it of values whose kind it cannot see.
    made: list[str] = [ResourceId("an-id"), AnnotationId("an-id"), JobId("an-id"), UserId("did:web:kb.example:users:a")]
    for value in made:
        assert [name for name, kind in KINDS.items() if isinstance(value, kind)] == [type(value).__name__]


def test_an_id_reads_as_the_text_it_is() -> None:
    assert f"/resources/{ResourceId('res-1')}" == "/resources/res-1"
    assert TypeAdapter(ResourceId).dump_json(ResourceId("res-1")) == b'"res-1"'
