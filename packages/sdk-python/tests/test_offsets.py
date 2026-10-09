"""What a text offset counts, held to `specs/src/text/offset-cases.json`: Unicode code points from the start of the text.

A Python `str` is indexed by code point, so an offset is a string's own index
and this package converts nothing. The table is run to show it: each span is
found by the search the builders use, and read back by a plain slice.
"""

from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field
from spec import SPEC

from semiont._spans import places


class StatedSpan(BaseModel, frozen=True, extra="forbid"):
    exact: str
    occurrence: int
    start: int
    end: int


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    text: str
    code_points: Annotated[int, Field(alias="codePoints")]
    spans: list[StatedSpan]


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "text/offset-cases.json").read_bytes())


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 10


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_text_is_as_long_as_its_code_points(case: Case) -> None:
    assert len(case.text) == case.code_points


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_span_is_found_at_its_offsets_and_its_offsets_give_the_span(case: Case) -> None:
    for span in case.spans:
        found = places(case.text, span.exact)[span.occurrence - 1]
        assert (found, found + len(span.exact)) == (span.start, span.end), f"{case.why}: {span.exact!r} found"
        assert case.text[span.start : span.end] == span.exact, f"{case.why}: {span.exact!r} read back"
