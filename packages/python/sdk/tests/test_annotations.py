"""The annotation readers, held to `specs/src/annotations/reader-cases.json`: the table every SDK's readers run."""

from collections.abc import Callable
from typing import Final

import pytest
from pydantic import BaseModel, JsonValue
from spec import SPEC, JsonObject

from semiont.annotations import (
    annotation_exact_text,
    body_source,
    comment_text,
    entity_types,
    exact_text,
    is_assessment,
    is_body_resolved,
    is_comment,
    is_highlight,
    is_reference,
    is_resolved_reference,
    is_stub_reference,
    is_tag,
    tag_category,
    tag_schema_id,
    target_selector,
    target_source,
    text_quote_selector,
)
from semiont.model import WireModel, written
from semiont.types import Annotation, AnnotationSelector


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    annotation: Annotation
    reads: JsonObject


class Table(BaseModel, frozen=True, populate_by_name=True):
    readers: list[str]
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/reader-cases.json").read_bytes())


def _as_written(selector: AnnotationSelector | WireModel | None) -> JsonValue:
    """What a reader gave, as the table writes it: a selector as the wire carries one, a list of them, or nothing."""
    if selector is None:
        return None
    if isinstance(selector, list):
        return [written(item) for item in selector]
    return written(selector)


def _quote(annotation: Annotation) -> JsonValue:
    selector = target_selector(annotation.target)
    assert selector is not None, "the table gives textQuoteSelector no selector to read"
    return _as_written(text_quote_selector(selector))


READERS: Final[dict[str, Callable[[Annotation], JsonValue]]] = {
    "bodySource": lambda a: body_source(a.body),
    "isBodyResolved": lambda a: is_body_resolved(a.body),
    "targetSource": lambda a: target_source(a.target),
    "targetSelector": lambda a: _as_written(target_selector(a.target)),
    "isHighlight": is_highlight,
    "isReference": is_reference,
    "isAssessment": is_assessment,
    "isComment": is_comment,
    "isTag": is_tag,
    "commentText": comment_text,
    "isStubReference": is_stub_reference,
    "isResolvedReference": is_resolved_reference,
    "exactText": lambda a: exact_text(target_selector(a.target)),
    "annotationExactText": annotation_exact_text,
    "textQuoteSelector": _quote,
    "entityTypes": lambda a: list(entity_types(a)),
    "tagCategory": tag_category,
    "tagSchemaId": tag_schema_id,
}


def test_there_is_a_reader_here_for_each_the_table_names_and_no_other() -> None:
    assert sorted(READERS) == sorted(TABLE.readers)
    assert len(TABLE.readers) == 18


def test_every_case_states_every_reader_but_the_quote_selector_where_there_is_no_selector() -> None:
    for case in TABLE.cases:
        applies = [
            reader for reader in TABLE.readers if reader != "textQuoteSelector" or target_selector(case.annotation.target) is not None
        ]
        assert sorted(case.reads) == sorted(applies), case.why


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.annotation.id)
def test_every_reader_gives_what_the_table_says(case: Case) -> None:
    for reader, answer in case.reads.items():
        assert READERS[reader](case.annotation) == answer, f"{case.why}: {reader}"
