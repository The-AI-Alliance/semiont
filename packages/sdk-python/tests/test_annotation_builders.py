"""The annotation builders, held to `specs/src/annotations/builder-cases.json`: the table every SDK's builders run.

`reconcile` has a table of its own (`test_reconcile.py`). Here are the two that
build: an annotation of a span (`cases`) and one of a resource as a whole
(`resources`), each compared as a commit carries it.
"""

import inspect
import re
from datetime import UTC, datetime, timedelta
from operator import methodcaller
from typing import Annotated, Final

import pytest
from pydantic import BaseModel, Field, JsonValue
from spec import SPEC, JsonObject, objects, read, strings

from semiont import annotations, error_codes, errors
from semiont.annotations import SpanRefusedError, TextSpan, annotation_of_resource, annotation_of_span, reconcile, target_source
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import Agent, AnchoredText, Annotation, AnnotationBodies, MarkCommitCommand, Motivation, TextualBody


class SpanCase(BaseModel, frozen=True, extra="forbid"):
    why: str
    text: str | None = None
    anchored: AnchoredText | None = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    generator: Agent
    motivation: Motivation
    span: JsonObject
    body: AnnotationBodies | None = None
    annotation: JsonObject | None = None
    refused: str | None = None


class ResourceCase(BaseModel, frozen=True, extra="forbid"):
    why: str
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    motivation: Motivation
    generator: Agent | None = None
    body: AnnotationBodies | None = None
    annotation: JsonObject


class Unstated(BaseModel, frozen=True, extra="forbid"):
    cases: list[str]
    resources: list[str]


class Table(BaseModel, frozen=True):
    unstated: Unstated
    builders: list[str]
    cases: list[SpanCase]
    resources: list[ResourceCase]


TABLE: Final = Table.model_validate_json((SPEC / "annotations/builder-cases.json").read_bytes())
BUILT: Final = [case for case in TABLE.cases if case.annotation is not None]
REFUSED: Final = [case for case in TABLE.cases if case.refused is not None]

BUILDERS: Final[dict[str, object]] = {
    "reconcile": reconcile,
    "annotationOfSpan": annotation_of_span,
    "annotationOfResource": annotation_of_resource,
}

INSTANT: Final = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")


def as_python_spells(name: str) -> str:
    """`annotationOfSpan` → `annotation_of_span`."""
    return "".join(f"_{letter.lower()}" if letter.isupper() else letter for letter in name)


def span_of(stated: JsonObject) -> TextSpan:
    """The span a case states, made as untyped code makes one.

    One case states a fraction for an offset. Both type checkers refuse that
    (`tests/refusals`), and the builder is to refuse it when it is called.
    """
    made: TextSpan = methodcaller("__call__", **stated)(TextSpan)
    return made


def build(case: SpanCase) -> Annotation:
    subject = case.text if case.text is not None else case.anchored
    assert subject is not None, case.why
    return annotation_of_span(
        subject,
        span_of(case.span),
        resource_id=case.resource_id,
        motivation=case.motivation,
        generator=case.generator,
        body=case.body,
    )


def as_committed(annotation: Annotation) -> JsonObject:
    """An annotation as `job.commit` sends it: in a batch, which is written as its annotations were made."""
    batch = MarkCommitCommand(resource_id=target_source(annotation.target), annotations=[annotation])
    (sent,) = objects(written(batch)["annotations"], "the batch's annotations")
    return sent


def without_its_moment(sent: JsonObject) -> JsonObject:
    """What a case states of a built annotation: all but `created`, which is checked here to be the moment it was built."""
    created = sent["created"]
    assert isinstance(created, str)
    assert INSTANT.fullmatch(created), f"{created} is not an RFC 3339 date-time in UTC to the millisecond"
    assert abs(datetime.now(UTC) - datetime.fromisoformat(created)) < timedelta(minutes=1)
    return {name: value for name, value in sent.items() if name != "created"}


def test_the_table_has_its_cases_and_each_is_of_a_text_or_of_a_pdf_and_is_built_or_refused() -> None:
    assert len(TABLE.cases) >= 33
    assert len(TABLE.resources) >= 4
    assert len(BUILT) + len(REFUSED) == len(TABLE.cases)
    for case in TABLE.cases:
        assert (case.text is None) != (case.anchored is None), case.why
        assert (case.annotation is None) != (case.refused is None), case.why


def test_what_no_case_can_state_is_the_moment_an_annotation_was_built() -> None:
    assert (TABLE.unstated.cases, TABLE.unstated.resources) == (["created"], ["created"])


def test_there_is_a_builder_here_for_each_the_table_names_and_no_other() -> None:
    assert sorted(BUILDERS) == sorted(TABLE.builders)
    assert len(TABLE.builders) == 3
    for name, builder in BUILDERS.items():
        assert builder is getattr(annotations, as_python_spells(name))


def test_the_module_offers_its_readers_its_builders_and_the_types_the_builders_take_and_give() -> None:
    readers = strings(read(SPEC / "annotations/reader-cases.json")["readers"], "readers")
    functions = {name for name in annotations.__all__ if inspect.isfunction(getattr(annotations, name))}
    assert functions == {as_python_spells(name) for name in [*readers, *TABLE.builders]}
    assert set(annotations.__all__) - functions == {
        "AnchorMethod",
        "MatchQuality",
        "QuotedText",
        "ReconciledSpan",
        "SpanRefusal",
        "SpanRefusedError",
        "TextSpan",
    }


@pytest.mark.parametrize("case", BUILT, ids=lambda case: case.why)
def test_an_annotation_of_a_span_is_built_as_the_table_says(case: SpanCase) -> None:
    assert without_its_moment(as_committed(build(case))) == case.annotation, case.why


@pytest.mark.parametrize("case", REFUSED, ids=lambda case: case.why)
def test_a_span_that_is_not_the_text_s_is_refused_by_the_name_the_table_gives(case: SpanCase) -> None:
    with pytest.raises(SpanRefusedError) as refused:
        build(case)
    assert refused.value.code == case.refused, case.why


def test_the_refusals_the_table_states_are_the_vocabulary_of_the_error_codes_and_no_other() -> None:
    # `specs/src/errors/codes.json` names the refusals, and `semiont.error_codes` is generated from it.
    assert sorted({case.refused for case in REFUSED if case.refused is not None}) == sorted(error_codes.SPAN_REFUSALS)
    # What the builders' module offers is that vocabulary and its failure, and no copy of either.
    assert annotations.SpanRefusal is error_codes.SpanRefusal
    assert annotations.SpanRefusedError is errors.SpanRefusedError


@pytest.mark.parametrize("case", TABLE.resources, ids=lambda case: case.why)
def test_an_annotation_of_a_resource_is_built_as_the_table_says(case: ResourceCase) -> None:
    built = annotation_of_resource(case.resource_id, motivation=case.motivation, generator=case.generator, body=case.body)
    assert without_its_moment(as_committed(built)) == case.annotation, case.why


def test_an_option_given_as_none_is_an_option_not_given_in_what_is_written_and_in_the_id() -> None:
    def commented(body: TextualBody) -> JsonObject:
        built = annotation_of_span(
            "Ada Lovelace wrote the first algorithm.",
            TextSpan(start=0, end=12, exact="Ada Lovelace", prefix=None, suffix=None),
            resource_id=ResourceId("res-1"),
            motivation="commenting",
            generator=TABLE.cases[0].generator,
            body=body,
        )
        return without_its_moment(as_committed(built))

    said: JsonValue = {"type": "TextualBody", "value": "an author"}
    with_nothing = commented(TextualBody(type="TextualBody", value="an author", purpose=None, format=None))
    assert with_nothing["body"] == said
    assert with_nothing == commented(TextualBody(type="TextualBody", value="an author"))
