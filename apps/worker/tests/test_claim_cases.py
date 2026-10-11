"""Finding a claim again in a PDF's text, held to the `claims` of `specs/src/annotations/pdf-locate-cases.json`.

The table's `cases` are the locating every SDK does for a span of a PDF, and
each SDK runs them. Its `claims` are the rule of Semiont's worker alone:
where the text of a PDF the worker made has a claim the worker is to cite.
"""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field, JsonValue
from spec import SPEC

from semiont_worker.generation.claim_search import find_claim_span


class Span(BaseModel, frozen=True, extra="forbid", strict=True):
    start: int
    end: int


class Claim(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    text: str
    claim: str
    span: Span | None


class Table(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    # The locating of a span, which the SDK's builder does and the SDK's own tests run.
    cases: list[JsonValue]
    claims: list[Claim]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/pdf-locate-cases.json").read_bytes())


def test_the_runner_found_the_table_s_claims() -> None:
    assert len(TABLE.claims) >= 21
    # Both answers are held: a claim that is found, and one that is not.
    assert any(case.span is None for case in TABLE.claims)
    assert any(case.span is not None for case in TABLE.claims)


@pytest.mark.parametrize("case", TABLE.claims, ids=lambda case: case.why)
def test_a_claim_is_found_where_the_table_says_or_nowhere(case: Claim) -> None:
    found = find_claim_span(case.text, case.claim)
    assert found == (None if case.span is None else (case.span.start, case.span.end)), case.why


def test_a_found_span_is_the_text_s_own_code_points() -> None:
    # An offset counts code points: a character outside the Basic Multilingual Plane ahead of the claim is one.
    text = "\U0001f600 see the extraor \ndinarily long word."
    found = find_claim_span(text, "extraordinarily long")
    assert found is not None
    start, end = found
    assert text[start:end] == "extraor \ndinarily long"


def test_a_break_is_passed_over_with_one_space_beside_it_at_the_most() -> None:
    # One space before the break and one after it are the break's own. A second on either side is a space the claim does not have.
    assert find_claim_span("extraor \n dinarily", "extraordinarily") == (0, 18)
    assert find_claim_span("extraor  \ndinarily", "extraordinarily") is None
    assert find_claim_span("extraor\n  dinarily", "extraordinarily") is None


def test_a_space_is_never_passed_over_for_nothing() -> None:
    assert find_claim_span("a b c", "abc") is None
    assert find_claim_span("a\nb\nc", "abc") == (0, 5)
