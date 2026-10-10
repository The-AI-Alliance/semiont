"""The citation resolver, held to `specs/src/worker/citation-cases.json`.

It is the table every worker's resolver runs, so that one generated text
yields one resolved text and one set of citations whichever language resolved
it.
"""

import logging
from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import GatheredContext
from spec import SPEC

from semiont_worker.generation.citations import (
    CitableIds,
    GenerationCitation,
    ResolvedCitations,
    collect_citable_ids,
    resolve_citation_tokens,
)
from semiont_worker.log import LOG


class Stated(BaseModel, frozen=True, extra="forbid", strict=True):
    """Something the table states: a member it does not have a place for here cannot be read, and fails."""


class StatedCitation(Stated, frozen=True):
    resource_id: Annotated[str, Field(alias="resourceId")]
    annotation_id: Annotated[str | None, Field(alias="annotationId")] = None
    start: int
    end: int
    exact: str


class StatedResolved(Stated, frozen=True):
    text: str
    citations: list[StatedCitation]


class Case(Stated, frozen=True):
    why: str
    text: str
    context_resource_ids: Annotated[list[str], Field(alias="contextResourceIds")]
    context_annotation_ids: Annotated[list[str], Field(alias="contextAnnotationIds")]
    resolved: StatedResolved
    dropped: list[str]


class ContextCase(Stated, frozen=True):
    why: str
    # A gathered context is the SDK's shape, read as the SDK reads one off the wire.
    context: GatheredContext | None
    resource_ids: Annotated[list[str], Field(alias="resourceIds")]
    annotation_ids: Annotated[list[str], Field(alias="annotationIds")]


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    cases: list[Case]
    contexts: list[ContextCase]


TABLE: Final = Table.model_validate_json((SPEC / "worker/citation-cases.json").read_bytes())


def citation_of(stated: StatedCitation) -> GenerationCitation:
    """A citation as the table states one. Its ids are ids: one the table states that is none fails here."""
    return GenerationCitation(
        resource_id=ResourceId(stated.resource_id),
        annotation_id=None if stated.annotation_id is None else AnnotationId(stated.annotation_id),
        start=stated.start,
        end=stated.end,
        exact=stated.exact,
    )


def warned_of(caplog: pytest.LogCaptureFixture) -> list[object]:
    """The id each warning names, in order. A dropped token is warned about, and that is the only place it is said."""
    for record in caplog.records:
        assert record.name == LOG.name, f"{record.name} logged {record.getMessage()!r}"
        assert record.levelno == logging.WARNING, f"{record.levelname}: {record.getMessage()}"
    return [vars(record).get("resourceId") for record in caplog.records]


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 39
    assert len(TABLE.contexts) >= 3


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_text_is_resolved_as_the_table_says(case: Case, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger=LOG.name)
    citable = CitableIds(resource_ids=frozenset(case.context_resource_ids), annotation_ids=frozenset(case.context_annotation_ids))

    resolved = resolve_citation_tokens(case.text, citable)

    expected = ResolvedCitations(content=case.resolved.text, citations=[citation_of(stated) for stated in case.resolved.citations])
    assert resolved == expected, case.why
    assert warned_of(caplog) == case.dropped, case.why
    # What the table states is true of the text it states it of: a citation's words are the text between its offsets.
    for citation in resolved.citations:
        assert resolved.content[citation.start : citation.end] == citation.exact, case.why


@pytest.mark.parametrize("case", TABLE.contexts, ids=lambda case: case.why)
def test_a_context_makes_citable_the_ids_the_table_says(case: ContextCase) -> None:
    expected = CitableIds(resource_ids=frozenset(case.resource_ids), annotation_ids=frozenset(case.annotation_ids))
    assert collect_citable_ids(case.context) == expected, case.why


# No case of the table rests on a character about which the white space a language is born with disagrees. These do.

R1: Final = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset())


def cited(start: int, end: int, exact: str) -> GenerationCitation:
    return GenerationCitation(resource_id=ResourceId("r1"), annotation_id=None, start=start, end=end, exact=exact)


def test_the_next_line_is_white_space_which_javascript_s_own_does_not_count() -> None:
    # U+0085 has the White_Space property. It ends no id, so what holds it is no token; and it is no part of a claim's end.
    assert resolve_citation_tokens("One. [[r\u00851]]", R1) == ResolvedCitations(content="One. [[r\u00851]]", citations=[])
    assert resolve_citation_tokens("One.\u0085[[r1]]", R1) == ResolvedCitations(content="One.\u0085", citations=[cited(0, 4, "One.")])
    # And it is passed where a claim starts.
    assert resolve_citation_tokens("One.\u0085Two.[[r1]]", R1) == ResolvedCitations(
        content="One.\u0085Two.", citations=[cited(5, 9, "Two.")]
    )


def test_the_byte_order_mark_is_not_white_space_which_javascript_s_own_counts(caplog: pytest.LogCaptureFixture) -> None:
    # U+FEFF does not have the property. It is a character of an id like any other: the token is one, and names no resource id.
    assert resolve_citation_tokens("One. [[r\ufeff1]]", R1) == ResolvedCitations(content="One.", citations=[])
    assert warned_of(caplog) == ["r\ufeff1"]
    # And it is a character of a claim like any other.
    assert resolve_citation_tokens("One.\ufeff[[r1]]", R1) == ResolvedCitations(content="One.\ufeff", citations=[cited(4, 5, "\ufeff")])


def test_a_unit_separator_is_not_white_space_which_python_s_own_counts(caplog: pytest.LogCaptureFixture) -> None:
    # U+001F does not have the property either, and `str.isspace` says it is white space.
    assert resolve_citation_tokens("One. [[r\x1f1]]", R1) == ResolvedCitations(content="One.", citations=[])
    assert warned_of(caplog) == ["r\x1f1"]
    assert resolve_citation_tokens("One.\x1f[[r1]]", R1) == ResolvedCitations(content="One.\x1f", citations=[cited(4, 5, "\x1f")])


# The table's number has the digits 0 to 9 on both sides of its full stop, and stands inside its text. These hold the rule's edges.


def test_only_the_digits_0_to_9_put_a_full_stop_inside_a_number() -> None:
    # The Arabic-Indic digits are digits to `str.isdigit`, and not to the rule: the full stop between them closes a sentence.
    text = "Old. Pi is \u0663.\u0661\u0664 here. [[r1]]"
    assert resolve_citation_tokens(text, R1) == ResolvedCitations(
        content="Old. Pi is \u0663.\u0661\u0664 here.", citations=[cited(13, 21, "\u0661\u0664 here.")]
    )


def test_a_full_stop_that_begins_the_text_has_no_digit_before_it() -> None:
    # Nothing stands before it, so it is between no two digits, whatever the text ends with: it closes, and the claim starts past it.
    assert resolve_citation_tokens(".5 and 7 [[r1]]", R1) == ResolvedCitations(content=".5 and 7", citations=[cited(1, 8, "5 and 7")])


def test_a_citation_carries_ids_and_not_text() -> None:
    citable = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset({"ann-7"}))
    (citation,) = resolve_citation_tokens("Ice melts. [[r1/ann-7]]", citable).citations
    assert type(citation.resource_id) is ResourceId
    assert type(citation.annotation_id) is AnnotationId


def test_each_dropped_token_says_why_it_was(caplog: pytest.LogCaptureFixture) -> None:
    citable = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset({"ann-7"}))
    resolve_citation_tokens("[[r1]] One. [[zzz]] [[r1/ann-8]]", citable)
    assert [(record.getMessage(), vars(record).get("resourceId"), vars(record).get("annotationId")) for record in caplog.records] == [
        ("Citation token has no preceding claim text — dropped", "r1", None),
        ("Citation token references an id absent from the provided context — dropped", "zzz", None),
        ("Citation token references an annotation absent from the provided context — dropped", "r1", "ann-8"),
    ]
