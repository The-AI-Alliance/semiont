"""Finding a claim again in a PDF's text, held to the `claims` and the `landing` of `specs/src/annotations/pdf-locate-cases.json`.

The table's `cases` are the locating every SDK does for a span of a PDF, and
each SDK runs them. Its `claims` and its `landing` are the rule of Semiont's
worker alone: every place the text of a PDF the worker made has a claim, and
which of them a citation is anchored to, by where the renderer says the cited
span ended.
"""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field, JsonValue
from semiont.types import AnchoredText, PdfTextItem
from spec import SPEC

from semiont_worker.generation.claim_search import find_claim_spans, find_landed_claim
from semiont_worker.generation.typst import Landed


class Span(BaseModel, frozen=True, extra="forbid", strict=True):
    start: int
    end: int


class Claim(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    text: str
    claim: str
    spans: list[Span]


class StatedLanded(BaseModel, frozen=True, extra="forbid", strict=True):
    page: int
    x: float
    y: float


class Landing(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    text: str
    # The text's items, read as the SDK reads them off the wire.
    items: list[JsonValue]
    claim: str
    landed: StatedLanded
    span: Span | None


class Table(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    run_by: Annotated[dict[str, list[str]], Field(alias="runBy")]
    """Who runs the table, which lint:spec-case-tables holds it to."""
    # The locating of a span, which the SDK's builder does and the SDK's own tests run.
    cases: list[JsonValue]
    claims: list[Claim]
    landing: list[Landing]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/pdf-locate-cases.json").read_bytes())


def test_the_runner_found_the_table_s_claims_and_landings() -> None:
    assert len(TABLE.claims) >= 21
    assert len(TABLE.landing) >= 13
    # Every answer is held: no place, one place, several; a landing at a place, and at none.
    assert any(not case.spans for case in TABLE.claims)
    assert any(len(case.spans) == 1 for case in TABLE.claims)
    assert any(len(case.spans) > 1 for case in TABLE.claims)
    assert any(case.span is None for case in TABLE.landing)
    assert any(case.span is not None for case in TABLE.landing)


@pytest.mark.parametrize("case", TABLE.claims, ids=lambda case: case.why)
def test_a_claim_is_found_at_every_place_the_table_says(case: Claim) -> None:
    found = find_claim_spans(case.text, case.claim)
    assert found == [(span.start, span.end) for span in case.spans], case.why


@pytest.mark.parametrize("case", TABLE.landing, ids=lambda case: case.why)
def test_a_citation_is_anchored_to_the_place_it_landed_or_to_none(case: Landing) -> None:
    anchored = AnchoredText(text=case.text, items=[PdfTextItem.model_validate(item) for item in case.items])
    landed = Landed(page=case.landed.page, x=case.landed.x, y=case.landed.y)
    found = find_landed_claim(anchored, case.claim, landed)
    assert found == (None if case.span is None else (case.span.start, case.span.end)), case.why


def test_a_found_span_is_the_text_s_own_code_points() -> None:
    # An offset counts code points: a character outside the Basic Multilingual Plane ahead of the claim is one.
    text = "\U0001f600 see the extraor \ndinarily long word."
    ((start, end),) = find_claim_spans(text, "extraordinarily long")
    assert text[start:end] == "extraor \ndinarily long"


def test_a_break_is_passed_over_with_one_space_beside_it_at_the_most() -> None:
    # One space before the break and one after it are the break's own. A second on either side is a space the claim does not have.
    assert find_claim_spans("extraor \n dinarily", "extraordinarily") == [(0, 18)]
    assert find_claim_spans("extraor  \ndinarily", "extraordinarily") == []
    assert find_claim_spans("extraor\n  dinarily", "extraordinarily") == []


def test_a_space_is_never_passed_over_for_nothing() -> None:
    assert find_claim_spans("a b c", "abc") == []
    assert find_claim_spans("a\nb\nc", "abc") == [(0, 5)]
