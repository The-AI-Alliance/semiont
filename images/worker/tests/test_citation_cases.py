"""The citation resolver, held to `specs/src/worker/citation-cases.json`.

It is the table every worker's resolver runs, so that one generated text
yields one resolved text and one set of citations whichever language resolved
it.
"""

import logging
from collections.abc import Mapping
from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field, JsonValue
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import GatheredContext, SupportedMediaType
from spec import SPEC

from semiont_worker.generation.citations import (
    CitableIds,
    GenerationCitation,
    ResolvedCitations,
    collect_citable_ids,
    resolve_citation_tokens,
)
from semiont_worker.log import LOG
from semiont_worker.media_types import GENERATABLE_MEDIA_TYPES


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
    format: SupportedMediaType
    context_resource_ids: Annotated[list[str], Field(alias="contextResourceIds")]
    context_annotation_ids: Annotated[list[str], Field(alias="contextAnnotationIds")]
    context_names: Annotated[dict[str, str], Field(alias="contextNames")]
    resolved: StatedResolved
    dropped: list[str]


class ContextCase(Stated, frozen=True):
    why: str
    # A gathered context is the SDK's shape, read as the SDK reads one off the wire.
    context: GatheredContext | None
    resource_ids: Annotated[list[str], Field(alias="resourceIds")]
    annotation_ids: Annotated[list[str], Field(alias="annotationIds")]
    names: dict[str, str]


class Table(Stated, frozen=True):
    comment: Annotated[str, Field(alias="$comment")]
    run_by: Annotated[dict[str, list[str]], Field(alias="runBy")]
    """Who runs the table, which lint:spec-case-tables holds it to."""
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
    assert len(TABLE.cases) >= 46
    assert len(TABLE.contexts) >= 5


def test_the_table_writes_a_name_in_every_format_a_yield_job_writes() -> None:
    # A format the registry comes to mark generatable is one a name must be written in: the table states how, before a worker can.
    assert sorted({case.format for case in TABLE.cases}) == sorted(GENERATABLE_MEDIA_TYPES)


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_text_is_resolved_as_the_table_says(case: Case, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger=LOG.name)
    citable = CitableIds(
        resource_ids=frozenset(case.context_resource_ids), annotation_ids=frozenset(case.context_annotation_ids), names=case.context_names
    )

    resolved = resolve_citation_tokens(case.text, citable, case.format)

    expected = ResolvedCitations(content=case.resolved.text, citations=[citation_of(stated) for stated in case.resolved.citations])
    assert resolved == expected, case.why
    assert warned_of(caplog) == case.dropped, case.why
    # What the table states is true of the text it states it of: a citation's words are the text between its offsets.
    for citation in resolved.citations:
        assert resolved.content[citation.start : citation.end] == citation.exact, case.why


@pytest.mark.parametrize("case", TABLE.contexts, ids=lambda case: case.why)
def test_a_context_makes_citable_the_ids_the_table_says(case: ContextCase) -> None:
    expected = CitableIds(resource_ids=frozenset(case.resource_ids), annotation_ids=frozenset(case.annotation_ids), names=case.names)
    assert collect_citable_ids(case.context) == expected, case.why


# No case of the table rests on a character about which the white space a language is born with disagrees. These do.

MARKDOWN: Final[SupportedMediaType] = "text/markdown"
R1: Final = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset(), names={"r1": "Rome"})


def names_given(name: str) -> Mapping[str, str]:
    """The names a context gives where its focus, `res-1`, is named `name`."""
    resource: JsonValue = {"@context": "https://semiont.dev/context/v1", "@id": "res-1", "name": name, "representations": []}
    context = GatheredContext.model_validate(
        {"focus": {"kind": "resource", "resource": resource}, "graph": {"nodes": [], "edges": []}, "metadata": {}}
    )
    return collect_citable_ids(context).names


def test_the_next_line_is_white_space_which_javascript_s_own_does_not_count() -> None:
    # U+0085 has the White_Space property. It ends no id, so what holds it is no token; and it is no part of a name's ends.
    assert resolve_citation_tokens("One. [[r\u00851]]", R1, MARKDOWN) == ResolvedCitations(content="One. [[r\u00851]]", citations=[])
    assert names_given("\u0085Rome\u0085") == {"res-1": "Rome"}


def test_the_byte_order_mark_is_not_white_space_which_javascript_s_own_counts(caplog: pytest.LogCaptureFixture) -> None:
    # U+FEFF does not have the property. It is a character of an id like any other: the token is one, and names no resource id.
    assert resolve_citation_tokens("One. [[r\ufeff1]]", R1, MARKDOWN) == ResolvedCitations(content="One.", citations=[])
    assert warned_of(caplog) == ["r\ufeff1"]
    # And it is a character of a name like any other.
    assert names_given("\ufeffRome") == {"res-1": "\ufeffRome"}


def test_a_unit_separator_is_not_white_space_which_python_s_own_counts(caplog: pytest.LogCaptureFixture) -> None:
    # U+001F does not have the property either, and `str.isspace` says it is white space.
    assert resolve_citation_tokens("One. [[r\x1f1]]", R1, MARKDOWN) == ResolvedCitations(content="One.", citations=[])
    assert warned_of(caplog) == ["r\x1f1"]
    assert names_given("\x1fRome") == {"res-1": "\x1fRome"}


def test_a_name_is_written_in_no_format_that_no_rule_writes_in() -> None:
    # A yield job is refused a format the registry does not mark generatable before anything is asked. Were one to reach here,
    # a name would not be put in it unwritten.
    with pytest.raises(ValueError, match="No rule writes a cited name in text/html"):
        resolve_citation_tokens("[[r1]]", R1, "text/html")


def test_a_citation_carries_ids_and_not_text() -> None:
    citable = CitableIds(resource_ids=frozenset({"r1"}), annotation_ids=frozenset({"ann-7"}), names={"r1": "Rome"})
    (citation,) = resolve_citation_tokens("Ice melts, says [[r1/ann-7]].", citable, MARKDOWN).citations
    assert type(citation.resource_id) is ResourceId
    assert type(citation.annotation_id) is AnnotationId


def test_each_dropped_token_says_why_it_was(caplog: pytest.LogCaptureFixture) -> None:
    citable = CitableIds(resource_ids=frozenset({"r1", "r9"}), annotation_ids=frozenset({"ann-7"}), names={"r1": "Rome"})
    resolve_citation_tokens("[[r9]] One. [[zzz]] [[r1/ann-8]]", citable, MARKDOWN)
    assert [(record.getMessage(), vars(record).get("resourceId"), vars(record).get("annotationId")) for record in caplog.records] == [
        ("Citation token names a source the context gave no name but its id — dropped", "r9", None),
        ("Citation token references an id absent from the provided context — dropped", "zzz", None),
        ("Citation token references an annotation absent from the provided context — dropped", "r1", "ann-8"),
    ]
