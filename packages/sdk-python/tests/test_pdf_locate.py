"""Where a span of a PDF's text is on its pages, held to the `cases` of `specs/src/annotations/pdf-locate-cases.json`.

The table's `claims` find a cited claim in a PDF a worker has generated: that
is the first-party worker's, and no SDK's.
"""

from typing import Final

import pytest
from pydantic import BaseModel
from spec import SPEC

from semiont._pdf_locate import Rectangle, fragment_of, locate
from semiont.types import AnchoredText, PdfTextItem


class StatedSpan(BaseModel, frozen=True, extra="forbid"):
    start: int
    end: int


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    anchored: AnchoredText
    span: StatedSpan
    overlapping: list[PdfTextItem]
    rects: list[Rectangle]
    fragments: list[str]


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/pdf-locate-cases.json").read_bytes())


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 15


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_span_is_located_as_the_table_says(case: Case) -> None:
    overlapping, rectangles = locate(case.anchored, case.span.start, case.span.end)
    assert overlapping == case.overlapping, f"{case.why}: the items the span overlaps"
    assert rectangles == case.rects, f"{case.why}: a rectangle for each line"
    assert [fragment_of(rectangle) for rectangle in rectangles] == case.fragments, f"{case.why}: each rectangle as a fragment"


def test_a_number_python_would_write_with_an_exponent_is_written_as_a_decimal() -> None:
    # Python writes a number below a ten-thousandth with an exponent (5e-05), and the rule is the shortest decimal.
    assert repr(0.00005) == "5e-05"
    hairline = Rectangle(page=1, x=72, y=700.25, width=0.00005, height=12)
    assert fragment_of(hairline) == "page=1&viewrect=72,700.25,0.00005,12"
