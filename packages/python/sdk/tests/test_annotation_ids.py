"""The id of an annotation a builder makes, held to `specs/src/annotations/id-cases.json`: the table every SDK's id runs."""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field, JsonValue
from spec import SPEC

from semiont._annotation_id import annotation_id_for
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import Motivation


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    motivation: Motivation
    anchor: str
    body: JsonValue = None
    """What the annotation's body is, as JSON. No case states a body that is `null`: one that states none has none."""
    id: AnnotationId


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/id-cases.json").read_bytes())


def test_the_runner_found_the_table_s_cases_and_none_states_a_body_that_is_null() -> None:
    assert len(TABLE.cases) >= 20
    assert [case.why for case in TABLE.cases if "body" in case.model_fields_set and case.body is None] == []


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_an_annotation_s_id_is_what_the_table_says(case: Case) -> None:
    assert annotation_id_for(case.resource_id, case.motivation, case.anchor, case.body) == case.id, case.why


def test_a_whole_number_is_its_digits_however_python_holds_it() -> None:
    # JSON has one kind of number and Python two: seven is written 7 whether a body holds it as 7 or as 7.0.
    whole = annotation_id_for(ResourceId("res-1"), "commenting", "0:1:a", {"type": "TextualBody", "value": "seven", "Value": 7})
    held_as_a_float = annotation_id_for(ResourceId("res-1"), "commenting", "0:1:a", {"type": "TextualBody", "value": "seven", "Value": 7.0})
    assert held_as_a_float == whole


def test_a_number_that_is_not_whole_has_no_form_the_rule_states_and_is_refused() -> None:
    with pytest.raises(ValueError, match="whole"):
        annotation_id_for(ResourceId("res-1"), "commenting", "0:1:a", {"type": "TextualBody", "value": "half", "Value": 0.5})
