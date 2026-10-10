"""The five `mark` processors: what each asks of its detection, builds, hands over to be committed, reports, and answers.

`docs/protocol/WORKER-SERVICE.md` states what a `mark` job does, and each
test here that holds one of its rules names the rule. The detection a
processor calls is stood in for (`standing_in.py`): what a detection does
with a model's reply is `test_detection.py`'s to hold. What is built is
built for real, by the SDK's builder over the text, so an annotation here is
the annotation a job commits. Cancellation is `test_cancellation.py`'s.
"""

import inspect
import logging
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final

import pytest
from aio import run, turns
from counted import counted
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from pydantic import JsonValue
from semiont.annotations import QuotedText, SpanRefusedError, TextSpan, target_selector, target_source, text_quote_selector
from semiont.model import written
from semiont.types import (
    AnchoredText,
    Annotation,
    AssessingJobParams,
    CommentingJobParams,
    FragmentSelector,
    HighlightingJobParams,
    JobDetectionResult,
    LinkingJobParams,
    PdfTextItem,
    Selector,
    TagCategory,
    TaggingJobParams,
    TagSchema,
    TextPositionSelector,
    UnitCursor,
)
from spec import PROJECT
from standing_in import (
    GENERATOR,
    RESOURCE,
    Asked,
    AskedForMentions,
    Handed,
    as_completed,
    assessments_stood_in,
    comments_stood_in,
    compiler_stood_in,
    generation_stood_in,
    highlights_stood_in,
    in_turn,
    mentions_stood_in,
    nothing_found,
    one_piece,
    pdf_build,
    pieces,
    report,
    tags_stood_in,
    text_build,
)

from semiont_worker import processors
from semiont_worker.detection import annotation_detection, entity_extractor
from semiont_worker.detection.chunk_plan import ChunkCursor, UnderReportedPiece
from semiont_worker.detection.entity_extractor import Mention
from semiont_worker.detection.parsers import AssessmentMatch, CommentMatch, TagMatch, read_comments, read_highlights, read_tags
from semiont_worker.generation import resource_generation, typst
from semiont_worker.processors import (
    BuildAnnotation,
    Cancelled,
    UnitCheckpoint,
    process_assessment_job,
    process_comment_job,
    process_highlight_job,
    process_reference_job,
    process_tag_job,
)

NOT_RESUMED: Final[Mapping[str, UnitCursor]] = {}
"""The cursors of a job on its first attempt: none."""
NONE_FINISHED: Final[Sequence[str]] = ()
"""The units earlier attempts of a job on its first attempt finished: none."""

SCHEMA: Final = TagSchema(
    id="schema-1",
    name="Test Schema",
    description="Test",
    domain="test",
    tags=[
        TagCategory(name="catA", description="A", examples=[]),
        TagCategory(name="catB", description="B", examples=[]),
        TagCategory(name="Issue", description="Issue", examples=[]),
    ],
)

HIGHLIGHTING: Final = HighlightingJobParams(motivation="highlighting")
COMMENTING: Final = CommentingJobParams(motivation="commenting")
ASSESSING: Final = AssessingJobParams(motivation="assessing")


def linking(*entity_types: str) -> LinkingJobParams:
    return LinkingJobParams(motivation="linking", entity_types=[*entity_types])


def tagging(*categories: str) -> TaggingJobParams:
    return TaggingJobParams(motivation="tagging", schema_id=SCHEMA.id, categories=[*categories])


# ── running a processor ─────────────────────────────────────────────────


def highlight(
    text: str, handed: Handed, params: HighlightingJobParams, resume: Mapping[str, UnitCursor], build: BuildAnnotation
) -> JobDetectionResult | Cancelled:
    return run(
        process_highlight_job(
            text,
            handed.client,
            params,
            build_annotation=build,
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=resume,
        )
    )


def comment(text: str, handed: Handed, params: CommentingJobParams, resume: Mapping[str, UnitCursor]) -> JobDetectionResult | Cancelled:
    return run(
        process_comment_job(
            text,
            handed.client,
            params,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=resume,
        )
    )


def assess(text: str, handed: Handed, params: AssessingJobParams, resume: Mapping[str, UnitCursor]) -> JobDetectionResult | Cancelled:
    return run(
        process_assessment_job(
            text,
            handed.client,
            params,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=resume,
        )
    )


def link(
    text: str, handed: Handed, params: LinkingJobParams, resume: Mapping[str, UnitCursor], completed_units: Sequence[str]
) -> JobDetectionResult | Cancelled:
    return run(
        process_reference_job(
            text,
            handed.client,
            params,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_unit_complete=handed.unit_complete,
            on_chunk_complete=handed.sink,
            resume_cursors=resume,
            completed_units=completed_units,
        )
    )


def tag(text: str, handed: Handed, params: TaggingJobParams, resume: Mapping[str, UnitCursor]) -> JobDetectionResult | Cancelled:
    return run(
        process_tag_job(
            text,
            handed.client,
            params,
            SCHEMA,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=resume,
        )
    )


def ran(outcome: JobDetectionResult | Cancelled) -> JobDetectionResult:
    """What a processor that ran to its end answered. One a cancellation stopped has no result, and fails a test that did not expect it."""
    assert isinstance(outcome, JobDetectionResult), f"the processor was stopped by a cancellation: {outcome}"
    return outcome


# ── what a detection hands on, as these tests write it ──────────────────


def span(text: str, words: str) -> TextSpan:
    """The first place `text` has `words`, as a span with no context stated."""
    start = text.index(words)
    return TextSpan(start=start, end=start + len(words), exact=words)


def commented(text: str, words: str, comment_: str) -> CommentMatch:
    found = span(text, words)
    return CommentMatch(start=found.start, end=found.end, exact=found.exact, comment=comment_)


def assessed(text: str, words: str, assessment: str) -> AssessmentMatch:
    found = span(text, words)
    return AssessmentMatch(start=found.start, end=found.end, exact=found.exact, assessment=assessment)


def tagged(text: str, words: str, category: str) -> TagMatch:
    found = span(text, words)
    return TagMatch(start=found.start, end=found.end, exact=found.exact, category=category)


def mention(words: str, entity_type: str) -> Mention:
    return Mention(quoted=QuotedText(exact=words), entity_type=entity_type)


# ── reading what was committed ──────────────────────────────────────────


def selectors(annotation: Annotation) -> list[Selector]:
    selector = target_selector(annotation.target)
    assert isinstance(selector, list)
    return selector


def position(annotation: Annotation) -> tuple[int, int]:
    """The offsets an annotation of a text is at."""
    (at,) = [selector for selector in selectors(annotation) if isinstance(selector, TextPositionSelector)]
    return at.start, at.end


def quoted(annotation: Annotation) -> str:
    """The words an annotation quotes."""
    quote = text_quote_selector(selectors(annotation))
    assert quote is not None
    return quote.exact


def body_of(annotation: Annotation) -> JsonValue:
    """An annotation's body as the wire carries it."""
    return written(annotation)["body"]


def textual(value: str, purpose: str, language: str | None) -> dict[str, JsonValue]:
    """A `TextualBody` of plain text as the wire carries one, with its language where it states one."""
    body: dict[str, JsonValue] = {"type": "TextualBody", "value": value, "purpose": purpose, "format": "text/plain"}
    return body if language is None else {**body, "language": language}


def cursor(next_: int, size: int, found: int, emitted: int, errors: int) -> UnitCursor:
    return UnitCursor(next=next_, size=size, found=found, emitted=emitted, errors=errors)


# ── the stand-ins take what the detections take ─────────────────────────


def parameters(function: object) -> list[tuple[str, str]]:
    """Each parameter a function takes: its name, and whether it is given by place or by name."""
    assert callable(function)
    return [(parameter.name, parameter.kind.name) for parameter in inspect.signature(function).parameters.values()]


def test_each_stand_in_takes_what_the_function_it_stands_in_for_takes(monkeypatch: pytest.MonkeyPatch) -> None:
    real: dict[str, object] = {
        "detect_highlights": annotation_detection.detect_highlights,
        "detect_comments": annotation_detection.detect_comments,
        "detect_assessments": annotation_detection.detect_assessments,
        "detect_tags": annotation_detection.detect_tags,
        "extract_entities": entity_extractor.extract_entities,
        "generate_resource_from_topic": resource_generation.generate_resource_from_topic,
        "compile_typst": typst.compile_typst,
    }
    # What the processors' module calls is the real thing, under the real thing's name.
    assert {name: getattr(processors, name) for name in real} == real

    highlights_stood_in(monkeypatch, nothing_found)
    comments_stood_in(monkeypatch, nothing_found)
    assessments_stood_in(monkeypatch, nothing_found)
    tags_stood_in(monkeypatch, nothing_found)
    mentions_stood_in(monkeypatch, nothing_found)
    generation_stood_in(monkeypatch, lambda asked: resource_generation.GeneratedDocument(content="", truncated=False))
    compiler_stood_in(monkeypatch, [typst.Compiled(pdf=b"")])
    for name, function in real.items():
        stood_in: object = getattr(processors, name)
        assert stood_in is not function
        assert parameters(stood_in) == parameters(function), name


# ── highlighting, commenting, assessing: one unit, named by its motivation ──


def test_a_highlighting_job_commits_a_highlight_of_each_passage_and_reports_as_d17_says(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "important text and the critical part is here."
    highlights_stood_in(monkeypatch, one_piece([span(text, "important"), span(text, "critical")]))
    handed = Handed(1)

    result = ran(highlight(text, handed, HighlightingJobParams(motivation="highlighting", density=5), NOT_RESUMED, text_build(text)))

    committed = handed.committed.annotations()
    assert [(annotation.motivation, target_source(annotation.target), quoted(annotation)) for annotation in committed] == [
        ("highlighting", RESOURCE, "important"),
        ("highlighting", RESOURCE, "critical"),
    ]
    # K1: a highlight has no body.
    assert ["body" in written(annotation) for annotation in committed] == [False, False]
    # D15: the job's result is its counts.
    assert as_completed(result) == {"found": 2, "persisted": 2}
    # D17: loading at 10, analyzing at 30, the count after the piece, and the end. Every report repeats what the job was asked with.
    echo: dict[str, JsonValue] = {"requestParams": [{"label": "density", "value": "5"}]}
    assert handed.told.said() == [
        report(10, {"code": "loading"}, echo),
        report(30, {"code": "analyzing"}, echo),
        report(60, {"code": "creating-annotations", "count": 2}, echo),
        report(100, {"code": "complete-created", "count": 2, "motivation": "highlighting"}, echo),
    ]


def test_an_annotation_says_what_made_it_and_nothing_of_who_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    # G4 and D11: the agent is the `generator`, and no `creator` is stated: who asked for the job is the record's to say.
    text = "x marks it"
    highlights_stood_in(monkeypatch, one_piece([span(text, "x")]))
    comments_stood_in(monkeypatch, one_piece([commented(text, "x", "c")]))
    assessments_stood_in(monkeypatch, one_piece([assessed(text, "x", "a")]))
    mentions_stood_in(monkeypatch, one_piece([mention("x", "Person")]))
    tags_stood_in(monkeypatch, one_piece([tagged(text, "x", "catA")]))
    handed = Handed(1)

    ran(highlight(text, handed, HIGHLIGHTING, NOT_RESUMED, text_build(text)))
    ran(comment(text, handed, COMMENTING, NOT_RESUMED))
    ran(assess(text, handed, ASSESSING, NOT_RESUMED))
    ran(link(text, handed, linking("Person"), NOT_RESUMED, NONE_FINISHED))
    ran(tag(text, handed, tagging("catA"), NOT_RESUMED))

    committed = handed.committed.annotations()
    assert [annotation.motivation for annotation in committed] == ["highlighting", "commenting", "assessing", "linking", "tagging"]
    for annotation in committed:
        carried = written(annotation)
        assert annotation.generator == GENERATOR
        assert "creator" not in carried
        assert "wasAttributedTo" not in carried
        assert "modified" not in carried


PDF: Final = AnchoredText(
    text="alpha beta\ngamma delta",
    items=[
        PdfTextItem(start=0, end=5, page=1, x=72, y=720, width=40, height=12),
        PdfTextItem(start=6, end=10, page=1, x=118, y=720, width=34, height=12),
        PdfTextItem(start=11, end=16, page=1, x=72, y=700, width=45, height=12),
        PdfTextItem(start=17, end=22, page=1, x=125, y=700, width=42, height=12),
    ],
)


def test_two_highlights_of_a_pdf_at_two_places_are_two_annotations(monkeypatch: pytest.MonkeyPatch) -> None:
    # A span of a PDF has no position selector (D10). Two that differ only in where they are must not be taken for one.
    highlights_stood_in(monkeypatch, one_piece([span(PDF.text, "alpha"), span(PDF.text, "delta")]))
    handed = Handed(1)

    result = ran(highlight(PDF.text, handed, HIGHLIGHTING, NOT_RESUMED, pdf_build(PDF)))

    committed = handed.committed.annotations()
    assert [quoted(annotation) for annotation in committed] == ["alpha", "delta"]
    assert as_completed(result) == {"found": 2, "persisted": 2}
    assert [
        [selector.value for selector in selectors(annotation) if isinstance(selector, FragmentSelector)] for annotation in committed
    ] == [
        ["page=1&viewrect=72,720,40,12"],
        ["page=1&viewrect=125,700,42,12"],
    ]
    assert not any(isinstance(selector, TextPositionSelector) for annotation in committed for selector in selectors(annotation))


def test_a_comment_s_body_is_a_list_of_one_textual_body_in_the_job_s_language_or_english(monkeypatch: pytest.MonkeyPatch) -> None:
    # K2.
    text = "passage here"
    for stated, language in ((None, "en"), ("fr", "fr")):
        comments_stood_in(monkeypatch, one_piece([commented(text, "passage", "interesting point")]))
        handed = Handed(1)

        result = ran(comment(text, handed, CommentingJobParams(motivation="commenting", density=3, language=stated), NOT_RESUMED))

        (annotation,) = handed.committed.annotations()
        assert annotation.motivation == "commenting"
        assert body_of(annotation) == [textual("interesting point", "commenting", language)]
        assert as_completed(result) == {"found": 1, "persisted": 1}


def test_an_assessment_s_body_is_one_textual_body_and_no_list(monkeypatch: pytest.MonkeyPatch) -> None:
    # K3.
    text = "claim made"
    for stated, language in ((None, "en"), ("fr", "fr")):
        assessments_stood_in(monkeypatch, one_piece([assessed(text, "claim", "dubious")]))
        handed = Handed(1)

        result = ran(assess(text, handed, AssessingJobParams(motivation="assessing", density=3, language=stated), NOT_RESUMED))

        (annotation,) = handed.committed.annotations()
        assert annotation.motivation == "assessing"
        assert body_of(annotation) == textual("dubious", "assessing", language)
        assert as_completed(result) == {"found": 1, "persisted": 1}


# ── what a detection is asked with ──────────────────────────────────────


def test_a_highlighting_detection_is_asked_with_what_the_job_states_and_what_the_processor_was_handed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked = highlights_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)
    params = HighlightingJobParams(motivation="highlighting", instructions="Mark dates.", density=2, source_language="fr")

    ran(highlight("content", handed, params, NOT_RESUMED, text_build("content")))

    (call,) = asked
    assert (call.text, call.client, call.cancelled, call.resume) == ("content", handed.client, handed.cancelled, None)
    assert call.of_the_job == {"instructions": "Mark dates.", "density": 2, "source_language": "fr"}

    asked = highlights_stood_in(monkeypatch, nothing_found)
    ran(highlight("content", Handed(1), HIGHLIGHTING, NOT_RESUMED, text_build("content")))
    assert asked[0].of_the_job == {"instructions": None, "density": None, "source_language": None}


def test_a_commenting_and_an_assessing_detection_are_asked_with_the_job_s_two_languages_and_its_tone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    comments = comments_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)
    ran(
        comment(
            "content",
            handed,
            CommentingJobParams(
                motivation="commenting", instructions="Explain.", tone="scholarly", density=4, language="de", source_language="fr"
            ),
            NOT_RESUMED,
        )
    )
    (call,) = comments
    assert (call.text, call.client, call.cancelled, call.resume) == ("content", handed.client, handed.cancelled, None)
    assert call.of_the_job == {"instructions": "Explain.", "tone": "scholarly", "density": 4, "language": "de", "source_language": "fr"}

    assessments = assessments_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)
    ran(
        assess(
            "content",
            handed,
            AssessingJobParams(
                motivation="assessing", instructions="Judge.", tone="critical", density=3, language="es", source_language="pt"
            ),
            NOT_RESUMED,
        )
    )
    (judged,) = assessments
    assert (judged.text, judged.client, judged.cancelled, judged.resume) == ("content", handed.client, handed.cancelled, None)
    assert judged.of_the_job == {"instructions": "Judge.", "tone": "critical", "density": 3, "language": "es", "source_language": "pt"}


def test_an_extraction_is_asked_for_one_entity_type_with_what_the_job_states(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = mentions_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)

    ran(
        link(
            "content",
            handed,
            LinkingJobParams(motivation="linking", entity_types=["Location"], source_language="fr"),
            NOT_RESUMED,
            NONE_FINISHED,
        )
    )

    (call,) = asked
    assert (call.text, call.entity_types, call.client, call.cancelled, call.resume) == (
        "content",
        ["Location"],
        handed.client,
        handed.cancelled,
        None,
    )
    # K4: names only, unless the job has `includeDescriptiveReferences`.
    assert call.of_the_job == {"include_descriptive_references": False, "source_language": "fr"}

    asked = mentions_stood_in(monkeypatch, nothing_found)
    described = LinkingJobParams(motivation="linking", entity_types=["Location"], include_descriptive_references=True)
    ran(link("content", Handed(1), described, NOT_RESUMED, NONE_FINISHED))
    assert asked[0].of_the_job == {"include_descriptive_references": True, "source_language": None}


def test_a_tagging_detection_is_asked_for_one_category_of_the_schema_handed_over_with_the_job(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = tags_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)

    ran(
        tag(
            "content",
            handed,
            TaggingJobParams(motivation="tagging", schema_id=SCHEMA.id, categories=["Issue"], source_language="fr"),
            NOT_RESUMED,
        )
    )

    (call,) = asked
    assert (call.text, call.client, call.cancelled, call.resume) == ("content", handed.client, handed.cancelled, None)
    # K7: the schema is the one the dispatcher handed over, whole, and not its id.
    assert call.of_the_job == {"schema": SCHEMA, "category": "Issue", "source_language": "fr"}


# ── the builder refuses a span that is not the text's ───────────────────


@pytest.mark.parametrize(
    ("handed_on", "refusal"),
    [
        (TextSpan(start=0, end=9, exact="important"), "exact-mismatch"),
        (TextSpan(start=4, end=9, exact="quick", prefix="WRONG PREFIX"), "prefix-mismatch"),
        (TextSpan(start=4, end=9, exact="quick", suffix="WRONG SUFFIX"), "suffix-mismatch"),
    ],
)
def test_a_span_that_is_not_the_text_s_fails_the_job_and_nothing_of_its_piece_is_handed_over(
    monkeypatch: pytest.MonkeyPatch, handed_on: TextSpan, refusal: str
) -> None:
    text = "the quick brown fox"
    highlights_stood_in(monkeypatch, one_piece([span(text, "fox"), handed_on]))
    handed = Handed(1)

    with pytest.raises(SpanRefusedError) as refused:
        highlight(text, handed, HIGHLIGHTING, NOT_RESUMED, text_build(text))

    assert refused.value.code == refusal
    assert handed.committed.batches == []


# ── a detection's own reading, through to what is committed ─────────────


def test_a_highlight_the_model_gave_no_offsets_for_is_committed_where_the_text_has_its_words(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "preamble important text and more."

    async def reading(asked: Asked[TextSpan]) -> None:
        await one_piece(read_highlights([{"exact": "important"}], asked.text).matches)(asked)

    highlights_stood_in(monkeypatch, reading)
    handed = Handed(1)

    ran(highlight(text, handed, HIGHLIGHTING, NOT_RESUMED, text_build(text)))

    (annotation,) = handed.committed.annotations()
    start, end = position(annotation)
    assert (text[start:end], quoted(annotation)) == ("important", "important")


def test_a_tag_s_context_is_the_text_s_own_and_never_the_model_s(monkeypatch: pytest.MonkeyPatch) -> None:
    # D9. The model's prefix overlaps the start of what it quoted.
    exact = "The question for decision"
    text = f"Kenison, C.J.\n{exact} by this appeal."

    async def reading(asked: Asked[TagMatch]) -> None:
        proposed: list[JsonValue] = [{"exact": exact, "prefix": "Kenison, C.J.\nTh", "suffix": " by this appeal."}]
        await one_piece(read_tags(proposed, asked.text, "Issue").matches)(asked)

    tags_stood_in(monkeypatch, reading)
    handed = Handed(1)

    ran(tag(text, handed, tagging("Issue"), NOT_RESUMED))

    (annotation,) = handed.committed.annotations()
    start, end = position(annotation)
    assert (start, text[start:end]) == (14, exact)
    quote = text_quote_selector(selectors(annotation))
    assert quote is not None
    assert quote.prefix == "Kenison, C.J.\n"


@pytest.mark.parametrize(
    ("proposed", "start"),
    [
        # Nothing the model said chooses among the three: the first.
        ({"exact": "foo", "prefix": "IRRELEVANT_PREFIX", "suffix": "IRRELEVANT_SUFFIX", "comment": "one of them"}, 2),
        # What it said stands beside the middle one.
        ({"exact": "foo", "prefix": "Y ", "suffix": " Z", "comment": "middle one"}, 8),
    ],
)
def test_a_comment_on_words_the_text_has_three_times_is_committed_where_the_model_s_context_says(
    monkeypatch: pytest.MonkeyPatch, proposed: dict[str, JsonValue], start: int
) -> None:
    # D8.
    text = "X foo Y foo Z foo W"

    async def reading(asked: Asked[CommentMatch]) -> None:
        await one_piece(read_comments([proposed], asked.text).matches)(asked)

    comments_stood_in(monkeypatch, reading)
    handed = Handed(1)

    ran(comment(text, handed, COMMENTING, NOT_RESUMED))

    (annotation,) = handed.committed.annotations()
    assert position(annotation) == (start, start + 3)


# ── D5: a span two pieces both see is one annotation ────────────────────


def test_each_piece_is_handed_over_as_it_lands_and_a_span_two_pieces_both_see_is_committed_once(monkeypatch: pytest.MonkeyPatch) -> None:
    # D13 and D5.
    text = "important text and the critical part is here."
    first, second = ChunkCursor(next=20, size=250), ChunkCursor(next=len(text), size=250)
    highlights_stood_in(
        monkeypatch, pieces(([span(text, "important")], first, 0), ([span(text, "important"), span(text, "critical")], second, 0))
    )
    handed = Handed(1)

    result = ran(highlight(text, handed, HIGHLIGHTING, NOT_RESUMED, text_build(text)))

    assert [[quoted(annotation) for annotation in batch] for batch in handed.committed.batches] == [["important"], ["critical"]]
    # Counted twice as found, and committed once.
    assert as_completed(result) == {"found": 3, "persisted": 2}
    assert handed.committed.checkpoints == [
        UnitCheckpoint(unit="highlighting", cursor=cursor(20, 250, 1, 1, 0)),
        UnitCheckpoint(unit="highlighting", cursor=cursor(len(text), 250, 3, 2, 0)),
    ]
    # D17: the count after each piece is of the annotations made so far.
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing"}, {}),
        report(60, {"code": "creating-annotations", "count": 1}, {}),
        report(60, {"code": "creating-annotations", "count": 2}, {}),
        report(100, {"code": "complete-created", "count": 2, "motivation": "highlighting"}, {}),
    ]


def test_two_proposals_alike_in_one_piece_are_one_annotation(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Only one phrase here to highlight."
    highlights_stood_in(monkeypatch, one_piece([span(text, "one phrase"), span(text, "one phrase")]))
    handed = Handed(1)

    result = ran(highlight(text, handed, HIGHLIGHTING, NOT_RESUMED, text_build(text)))

    assert [quoted(annotation) for annotation in handed.committed.annotations()] == ["one phrase"]
    assert as_completed(result) == {"found": 2, "persisted": 1}


def test_two_comments_on_one_passage_that_say_different_things_are_two_annotations(monkeypatch: pytest.MonkeyPatch) -> None:
    # D5: alike in motivation, place and body. These differ in body.
    text = "A critical finding."
    comments_stood_in(monkeypatch, one_piece([commented(text, "critical", "first"), commented(text, "critical", "second")]))
    handed = Handed(1)

    result = ran(comment(text, handed, COMMENTING, NOT_RESUMED))

    assert [body_of(annotation) for annotation in handed.committed.annotations()] == [
        [textual("first", "commenting", "en")],
        [textual("second", "commenting", "en")],
    ]
    assert as_completed(result) == {"found": 2, "persisted": 2}


def test_one_mechanism_decides_what_is_a_repeat() -> None:
    # A second decider beside the first would let repeats through on one path, which no test of one path notices.
    source = (PROJECT / "src/semiont_worker/processors.py").read_text(encoding="utf-8")
    # One for the job of one unit, one for each entity type, one for a tagging job.
    assert source.count("= _repeats_removed()") == 3
    assert source.count("_repeats_removed(") == 4
    assert source.count("set[AnnotationId]") == 1
    for module in ("detection/annotation_detection.py", "detection/entity_extractor.py"):
        assert "_repeats_removed" not in (PROJECT / "src/semiont_worker" / module).read_text(encoding="utf-8")


# ── D17: what a job of one unit reports ─────────────────────────────────


def test_every_report_repeats_the_job_s_instructions_tone_and_density_in_that_order(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "A critical finding."
    comments_stood_in(monkeypatch, one_piece([commented(text, "critical", "note")]))
    handed = Handed(1)
    params = CommentingJobParams(motivation="commenting", instructions="Focus on methodology", tone="scholarly", density=5)

    ran(comment(text, handed, params, NOT_RESUMED))

    echo: JsonValue = [
        {"label": "instructions", "value": "Focus on methodology"},
        {"label": "tone", "value": "scholarly"},
        {"label": "density", "value": "5"},
    ]
    reports = handed.told.said()
    assert len(reports) == 4
    for told in reports:
        assert isinstance(told, dict)
        assert told["requestParams"] == echo


def test_what_is_repeated_is_the_job_s_own_words_less_the_white_space_at_their_ends_and_a_density_as_json_writes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "A critical finding."
    highlights_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)
    # The next line (U+0085) is white space, and the byte order mark (U+FEFF) is not.
    params = HighlightingJobParams(
        motivation="highlighting", instructions="\u0085  Mark the Führer-era citations \ufeff \u2003", density=2.5
    )

    ran(highlight(text, handed, params, NOT_RESUMED, text_build(text)))

    assert handed.told.said()[0] == report(
        10,
        {"code": "loading"},
        {
            "requestParams": [
                {"label": "instructions", "value": "Mark the Führer-era citations \ufeff"},
                {"label": "density", "value": "2.5"},
            ]
        },
    )


def test_a_job_asked_with_nothing_to_repeat_states_no_request_params_and_blank_instructions_are_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "A critical finding."
    assessments_stood_in(monkeypatch, one_piece([assessed(text, "critical", "weak")]))
    handed = Handed(1)

    ran(assess(text, handed, AssessingJobParams(motivation="assessing", instructions=" \n\t"), NOT_RESUMED))

    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing"}, {}),
        report(60, {"code": "creating-annotations", "count": 1}, {}),
        report(100, {"code": "complete-created", "count": 1, "motivation": "assessing"}, {}),
    ]


def test_where_a_job_stands_is_reported_between_thirty_and_sixty_by_how_far_through_the_text_it_is(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # D17: analyzing at 30 + round(30 x next / length), and F9: the same again while a generation is awaited.
    text = "x" * 120

    async def walking(asked: Asked[TextSpan]) -> None:
        asked.on_activity(0, 120)
        await asked.hand_on([], ChunkCursor(next=40, size=10), 0)
        asked.on_activity(40, 120)
        # A half is rounded to the greater: 30 x 90 / 120 is 22.5, and is reported as 53.
        asked.on_activity(90, 120)
        asked.on_activity(119, 120)

    highlights_stood_in(monkeypatch, walking)
    handed = Handed(1)

    highlight(text, handed, HighlightingJobParams(motivation="highlighting", density=1), NOT_RESUMED, text_build(text))

    echo: dict[str, JsonValue] = {"requestParams": [{"label": "density", "value": "1"}]}
    assert handed.told.said()[2:7] == [
        report(30, {"code": "analyzing"}, echo),
        report(60, {"code": "creating-annotations", "count": 0}, echo),
        report(40, {"code": "analyzing"}, echo),
        report(53, {"code": "analyzing"}, echo),
        report(60, {"code": "analyzing"}, echo),
    ]


# ── D15: found, persisted and errors mean one thing in every path ───────

TEXT: Final = "alpha beta gamma delta"
END: Final = len(TEXT)

type HandedOn = Sequence[tuple[Sequence[str], ChunkCursor | None, int]]
"""What a detection hands on, as these tests write it for every kind alike.

For each piece: the words of the passages kept, where the walk then stands,
and how many proposals were dropped.
"""


@final
@dataclass(frozen=True, slots=True)
class OneUnit:
    """A job of one unit, of one kind: its unit's name, and how these tests run one over `TEXT`."""

    unit: str
    job: Callable[[pytest.MonkeyPatch, HandedOn, Handed, Mapping[str, UnitCursor]], JobDetectionResult | Cancelled]


def highlighting_job(
    monkeypatch: pytest.MonkeyPatch, handed_on: HandedOn, handed: Handed, resume: Mapping[str, UnitCursor]
) -> JobDetectionResult | Cancelled:
    highlights_stood_in(monkeypatch, pieces(*(([span(TEXT, words) for words in kept], at, dropped) for kept, at, dropped in handed_on)))
    return highlight(TEXT, handed, HIGHLIGHTING, resume, text_build(TEXT))


def commenting_job(
    monkeypatch: pytest.MonkeyPatch, handed_on: HandedOn, handed: Handed, resume: Mapping[str, UnitCursor]
) -> JobDetectionResult | Cancelled:
    comments_stood_in(
        monkeypatch, pieces(*(([commented(TEXT, words, f"on {words}") for words in kept], at, dropped) for kept, at, dropped in handed_on))
    )
    return comment(TEXT, handed, COMMENTING, resume)


def assessing_job(
    monkeypatch: pytest.MonkeyPatch, handed_on: HandedOn, handed: Handed, resume: Mapping[str, UnitCursor]
) -> JobDetectionResult | Cancelled:
    assessments_stood_in(
        monkeypatch, pieces(*(([assessed(TEXT, words, f"of {words}") for words in kept], at, dropped) for kept, at, dropped in handed_on))
    )
    return assess(TEXT, handed, ASSESSING, resume)


def tagging_job(
    monkeypatch: pytest.MonkeyPatch, handed_on: HandedOn, handed: Handed, resume: Mapping[str, UnitCursor]
) -> JobDetectionResult | Cancelled:
    tags_stood_in(monkeypatch, pieces(*(([tagged(TEXT, words, "catA") for words in kept], at, dropped) for kept, at, dropped in handed_on)))
    return tag(TEXT, handed, tagging("catA"), resume)


def linking_job(
    monkeypatch: pytest.MonkeyPatch, handed_on: HandedOn, handed: Handed, resume: Mapping[str, UnitCursor]
) -> JobDetectionResult | Cancelled:
    mentions_stood_in(
        monkeypatch, pieces(*(([mention(words, "Person") for words in kept], at, dropped) for kept, at, dropped in handed_on))
    )
    return link(TEXT, handed, linking("Person"), resume, NONE_FINISHED)


OF_ONE_MOTIVATION: Final = [
    OneUnit("highlighting", highlighting_job),
    OneUnit("commenting", commenting_job),
    OneUnit("assessing", assessing_job),
]
OF_PASSAGES: Final = [*OF_ONE_MOTIVATION, OneUnit("catA", tagging_job)]
EVERY_KIND: Final = [*OF_PASSAGES, OneUnit("Person", linking_job)]


def named(kinds: Sequence[OneUnit]) -> pytest.MarkDecorator:
    return pytest.mark.parametrize("kind", kinds, ids=[kind.unit for kind in kinds])


@named(EVERY_KIND)
def test_what_was_proposed_is_found_and_what_made_no_annotation_is_an_error_on_the_result_and_on_the_cursor(
    monkeypatch: pytest.MonkeyPatch, kind: OneUnit
) -> None:
    handed = Handed(1)

    result = ran(kind.job(monkeypatch, [(["alpha", "gamma"], ChunkCursor(next=END, size=500), 3)], handed, NOT_RESUMED))

    # Five proposed, two recorded, three that made nothing.
    counts = as_completed(result)
    assert isinstance(counts, dict)
    assert {name: counts[name] for name in ("found", "persisted", "errors")} == {"found": 5, "persisted": 2, "errors": 3}
    # The cursor carries the same three: one observation of one piece.
    assert handed.committed.checkpoints == [UnitCheckpoint(unit=kind.unit, cursor=cursor(END, 500, 5, 2, 3))]


@named(EVERY_KIND)
def test_a_job_whose_every_proposal_made_an_annotation_states_no_errors(monkeypatch: pytest.MonkeyPatch, kind: OneUnit) -> None:
    handed = Handed(1)

    result = ran(kind.job(monkeypatch, [(["alpha", "gamma"], ChunkCursor(next=END, size=500), 0)], handed, NOT_RESUMED))

    counts = as_completed(result)
    assert isinstance(counts, dict)
    # Absent is the one way to say none: a nought, or a null, is refused where the result is read.
    assert "errors" not in counts
    assert {name: counts[name] for name in ("found", "persisted")} == {"found": 2, "persisted": 2}
    assert handed.committed.checkpoints == [UnitCheckpoint(unit=kind.unit, cursor=cursor(END, 500, 2, 2, 0))]


@named(EVERY_KIND)
def test_a_resumed_job_s_counts_begin_at_its_unit_s_cursor(monkeypatch: pytest.MonkeyPatch, kind: OneUnit) -> None:
    # U1: the job's result is the whole text's, and so is the cursor it writes, which a third attempt would begin at.
    handed = Handed(1)
    left_at = {kind.unit: cursor(11, 500, 4, 2, 2)}

    result = ran(kind.job(monkeypatch, [(["delta"], ChunkCursor(next=END, size=350), 1)], handed, left_at))

    counts = as_completed(result)
    assert isinstance(counts, dict)
    assert {name: counts[name] for name in ("found", "persisted", "errors")} == {"found": 6, "persisted": 3, "errors": 3}
    assert handed.committed.checkpoints == [UnitCheckpoint(unit=kind.unit, cursor=cursor(END, 350, 6, 3, 3))]


@named(OF_ONE_MOTIVATION)
def test_only_a_linking_job_s_result_says_anything_of_pieces_kept_under_reported_and_only_a_tagging_job_s_of_categories(
    monkeypatch: pytest.MonkeyPatch, kind: OneUnit
) -> None:
    result = ran(kind.job(monkeypatch, [(["alpha"], None, 0)], Handed(1), NOT_RESUMED))
    assert as_completed(result) == {"found": 1, "persisted": 1}


def test_a_unit_is_taken_up_at_the_cursor_the_job_was_claimed_with_for_it(monkeypatch: pytest.MonkeyPatch) -> None:
    # U1. A unit is named where its job is run, so only here can a cursor's key be matched to the unit it is of.
    highlights = highlights_stood_in(monkeypatch, nothing_found)
    ran(
        highlight(
            "content",
            Handed(1),
            HIGHLIGHTING,
            {"highlighting": cursor(3, 400, 0, 0, 0), "Person": cursor(5, 9, 0, 0, 0)},
            text_build("content"),
        )
    )
    assert [call.resume for call in highlights] == [cursor(3, 400, 0, 0, 0)]

    comments = comments_stood_in(monkeypatch, nothing_found)
    ran(comment("content", Handed(1), COMMENTING, {"commenting": cursor(4, 300, 0, 0, 0), "highlighting": cursor(3, 400, 0, 0, 0)}))
    assert [call.resume for call in comments] == [cursor(4, 300, 0, 0, 0)]

    assessments = assessments_stood_in(monkeypatch, nothing_found)
    ran(assess("content", Handed(1), ASSESSING, {"assessing": cursor(5, 200, 0, 0, 0), "commenting": cursor(4, 300, 0, 0, 0)}))
    assert [call.resume for call in assessments] == [cursor(5, 200, 0, 0, 0)]

    # An entity type has its own, and so has a category: each walks the whole text, and one cursor for all would skip text.
    mentions = mentions_stood_in(monkeypatch, nothing_found)
    ran(
        link(
            "content",
            Handed(1),
            linking("Person", "Location"),
            {"Person": cursor(6, 560, 0, 0, 0), "Location": cursor(2, 900, 0, 0, 0)},
            NONE_FINISHED,
        )
    )
    assert {call.entity_types[0]: call.resume for call in mentions} == {
        "Person": cursor(6, 560, 0, 0, 0),
        "Location": cursor(2, 900, 0, 0, 0),
    }

    tags = tags_stood_in(monkeypatch, nothing_found)
    ran(tag("content", Handed(1), tagging("catA", "catB"), {"catA": cursor(4, 300, 0, 0, 0), "catB": cursor(1, 700, 0, 0, 0)}))
    assert {call.of_the_job["category"]: call.resume for call in tags} == {"catA": cursor(4, 300, 0, 0, 0), "catB": cursor(1, 700, 0, 0, 0)}


# ── linking: one unit for each entity type ──────────────────────────────


def test_a_reference_s_body_is_a_list_of_one_textual_body_that_tags_its_entity_type(monkeypatch: pytest.MonkeyPatch) -> None:
    # K4.
    text = "Paris and Berlin"
    for stated, language in ((None, "en"), ("fr", "fr")):
        mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location"), mention("Berlin", "Location")]))
        handed = Handed(1)
        params = LinkingJobParams(motivation="linking", entity_types=["Location"], language=stated)

        result = ran(link(text, handed, params, NOT_RESUMED, NONE_FINISHED))

        committed = handed.committed.annotations()
        assert [(annotation.motivation, position(annotation), quoted(annotation)) for annotation in committed] == [
            ("linking", (0, 5), "Paris"),
            ("linking", (10, 16), "Berlin"),
        ]
        assert [body_of(annotation) for annotation in committed] == [[textual("Location", "tagging", language)]] * 2
        assert as_completed(result) == {"found": 2, "persisted": 2}


def test_a_linking_job_reports_as_d18_says(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Ada Lovelace met Charles Babbage in London, far from Paris and from Rome."

    async def person(asked: AskedForMentions) -> None:
        asked.on_counted(2)
        await one_piece([mention("Ada Lovelace", "Person"), mention("Charles Babbage", "Person")])(asked)

    async def place(asked: AskedForMentions) -> None:
        asked.on_counted(3)
        await one_piece([mention("London", "Place"), mention("Paris", "Place"), mention("Rome", "Place")])(asked)

    mentions_stood_in(monkeypatch, in_turn(person, place))
    handed = Handed(1)

    result = ran(link(text, handed, linking("Person", "Place"), NOT_RESUMED, NONE_FINISHED))

    request_params: JsonValue = [{"label": "entity-types", "value": "Person, Place"}]
    person_done: JsonValue = {"value": "Person", "foundCount": 2, "persistedCount": 2}
    place_done: JsonValue = {"value": "Place", "foundCount": 3, "persistedCount": 3}

    def standing(
        percentage: int, entity_type: str, processed: int, found: int, expected: int | None, emitted: int, completed: list[JsonValue]
    ) -> JsonValue:
        return report(
            percentage,
            {"code": "detecting-entities", "entityType": entity_type},
            {
                "current": {"kind": "entity-type", "value": entity_type},
                "processed": processed,
                "total": 2,
                "entitiesFound": found,
                **({} if expected is None else {"entitiesExpected": expected}),
                "entitiesEmitted": emitted,
                "completedItems": completed,
                "requestParams": request_params,
            },
        )

    assert handed.told.said() == [
        report(10, {"code": "loading"}, {"requestParams": request_params}),
        # Person: begun, counted, committed, finished.
        standing(20, "Person", 0, 0, None, 0, []),
        standing(20, "Person", 0, 0, 2, 0, []),
        standing(20, "Person", 0, 2, 2, 2, []),
        standing(50, "Person", 1, 2, 2, 2, [person_done]),
        # Place: the same four.
        standing(50, "Place", 1, 2, 2, 2, [person_done]),
        standing(50, "Place", 1, 2, 5, 2, [person_done]),
        standing(50, "Place", 1, 5, 5, 5, [person_done]),
        standing(80, "Place", 2, 5, 5, 5, [person_done, place_done]),
        report(
            100,
            {"code": "complete-created", "count": 5, "motivation": "linking"},
            {"entitiesExpected": 5, "completedItems": [person_done, place_done], "requestParams": request_params},
        ),
    ]
    assert as_completed(result) == {"found": 5, "persisted": 5}
    # D14: a type is said to be finished once its last batch is handed over, and in the job's order on a model asked one thing at a time.
    assert handed.finished == ["Person", "Place"]
    assert [checkpoint.unit for checkpoint in handed.committed.checkpoints] == ["Person", "Place"]


def test_a_linking_job_whose_provider_counts_nothing_states_no_entities_expected(monkeypatch: pytest.MonkeyPatch) -> None:
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)

    ran(link("Paris and Berlin and Rome", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    reports = handed.told.said()
    assert len(reports) == 5
    for told in reports:
        assert isinstance(told, dict)
        # No claim, and not nought.
        assert "entitiesExpected" not in told


def test_what_was_counted_adds_up_over_pieces_and_what_was_found_moves_as_each_piece_is_handed_over(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "Paris and Berlin and Rome"

    async def two_pieces(asked: AskedForMentions) -> None:
        asked.on_counted(4)
        await asked.hand_on([mention("Paris", "Location")], ChunkCursor(next=10, size=5), 0)
        asked.on_counted(3)
        await asked.hand_on([mention("Berlin", "Location")], ChunkCursor(next=len(text), size=5), 0)

    mentions_stood_in(monkeypatch, two_pieces)
    handed = Handed(1)

    ran(link(text, handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    standing = [told for told in handed.told.reports if told.message is not None and told.message.code == "detecting-entities"]
    assert [(told.entities_expected, told.entities_found, told.entities_emitted) for told in standing] == [
        (None, 0, 0),
        (4, 0, 0),
        (4, 1, 1),
        (7, 1, 1),
        (7, 2, 2),
        (7, 2, 2),
    ]


def test_while_an_extraction_is_under_way_a_linking_job_says_again_where_it_stands(monkeypatch: pytest.MonkeyPatch) -> None:
    # F9: a detection that awaits a generation reports where it stands again. For a linking job that is the report of its type.
    async def awaited(asked: AskedForMentions) -> None:
        asked.on_activity(0, 7)
        asked.on_activity(0, 7)

    mentions_stood_in(monkeypatch, awaited)
    handed = Handed(1)

    ran(link("content", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    said = handed.told.said()
    assert said[1] == said[2] == said[3]
    assert handed.told.codes() == [
        "loading",
        "detecting-entities",
        "detecting-entities",
        "detecting-entities",
        "detecting-entities",
        "complete-created",
    ]


@final
class InFlight:
    """How many extractions were under way at once, at the most."""

    def __init__(self) -> None:
        self.now = 0
        self.most = 0

    async def __call__(self, asked: AskedForMentions) -> None:
        self.now += 1
        self.most = max(self.most, self.now)
        await turns()
        self.now -= 1


def test_entity_types_are_asked_about_as_many_at_once_as_the_provider_says_and_no_more(monkeypatch: pytest.MonkeyPatch) -> None:
    # K4 and K8: one at a time on a model that takes one thing at a time, and several where the provider has room.
    for bound, at_once in ((4, 4), (1, 1), (2, 2)):
        in_flight = InFlight()
        asked = mentions_stood_in(monkeypatch, in_flight)
        handed = Handed(bound)
        types = [f"T{number}" for number in range(8)]

        result = ran(link("x " * 50, handed, linking(*types), NOT_RESUMED, NONE_FINISHED))

        assert in_flight.most == at_once
        assert sorted(call.entity_types[0] for call in asked) == types
        assert [len(call.entity_types) for call in asked] == [1] * 8
        assert sorted(handed.finished) == types
        assert as_completed(result) == {"found": 0, "persisted": 0}
        # D18: each report is at 20 + round(60 x finished / types). The last a type makes is of itself among the finished,
        # and a half is rounded to the greater: three of eight is 22.5, and seven of eight 52.5.
        as_finished = [told.percentage for told in handed.told.reports if told.processed is not None and told.processed > 0][-1:]
        assert as_finished == [80]
        if bound == 1:
            standing = [(told.processed, told.percentage) for told in handed.told.reports if told.processed is not None]
            assert sorted(set(standing)) == [(0, 20), (1, 28), (2, 35), (3, 43), (4, 50), (5, 58), (6, 65), (7, 73), (8, 80)]


def test_an_entity_type_with_no_name_is_passed_over_without_a_word(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)

    result = ran(link("Paris", handed, linking("", "Location"), NOT_RESUMED, NONE_FINISHED))

    # It is not asked about, and is not finished. It is still one of the job's types by number: the job ends with one of two done.
    assert [call.entity_types for call in asked] == [["Location"]]
    assert handed.finished == ["Location"]
    assert as_completed(result) == {"found": 1, "persisted": 1}
    last = handed.told.reports[-2]
    assert (last.percentage, last.processed, last.total) == (50, 1, 2)


def test_entity_types_that_finish_out_of_the_job_s_order_are_each_finished_once(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Paris and Ada are here."

    async def location_slow(asked: AskedForMentions) -> None:
        if asked.entity_types[0] == "Location":
            await turns()
            await one_piece([mention("Paris", "Location")])(asked)
        else:
            await one_piece([mention("Ada", "Person")])(asked)

    mentions_stood_in(monkeypatch, location_slow)
    handed = Handed(4)

    result = ran(link(text, handed, linking("Location", "Person"), NOT_RESUMED, NONE_FINISHED))

    assert handed.finished == ["Person", "Location"]
    # The last report lists the finished in the order they finished, each once.
    last = handed.told.reports[-1]
    assert last.completed_items is not None
    assert [(item.value, item.found_count, item.persisted_count) for item in last.completed_items] == [("Person", 1, 1), ("Location", 1, 1)]
    assert as_completed(result) == {"found": 2, "persisted": 2}


def test_a_mention_the_text_does_not_have_makes_no_annotation_and_is_counted_and_said(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # D8 and D15.
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    text = "Alice went to Paris."
    mentions_stood_in(monkeypatch, one_piece([mention("Alice", "Person"), mention("NoSuchPerson", "Person")]))
    handed = Handed(1)

    result = ran(link(text, handed, linking("Person"), NOT_RESUMED, NONE_FINISHED))

    (annotation,) = handed.committed.annotations()
    assert (target_source(annotation.target), position(annotation), quoted(annotation)) == (RESOURCE, (0, 5), "Alice")
    assert as_completed(result) == {"found": 2, "persisted": 1, "errors": 1}
    assert handed.committed.checkpoints == [UnitCheckpoint(unit="Person", cursor=cursor(len(text), 1, 2, 1, 1))]
    (dropped,) = [record for record in caplog.records if record.getMessage() == "Entity dropped — text not found in source"]
    assert (dropped.levelno, vars(dropped)["text"], vars(dropped)["entityType"]) == (logging.ERROR, "NoSuchPerson", "Person")


def test_how_each_reference_was_anchored_is_counted_as_a_reference_s_and_a_doubtful_place_is_warned_of(
    monkeypatch: pytest.MonkeyPatch, metric_reader: InMemoryMetricReader, caplog: pytest.LogCaptureFixture
) -> None:
    # A mention is anchored where its annotation is made, which for a linking job is here: so here is where it is noted.
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    text = "Paris, and Rome, and then Paris again."
    mentions_stood_in(monkeypatch, one_piece([mention("Rome", "Location"), mention("Paris", "Location")]))
    handed = Handed(1)
    before = counted(metric_reader, "semiont.detection.anchors", "detection.label", "anchor.method")

    ran(link(text, handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    # The text has `Rome` once. It has `Paris` twice, and nothing the model said chose: the first was taken.
    assert [position(annotation) for annotation in handed.committed.annotations()] == [(11, 15), (0, 5)]
    assert counted(metric_reader, "semiont.detection.anchors", "detection.label", "anchor.method") - before == Counter(
        {("reference", "unique-match"): 1, ("reference", "first-of-many"): 1}
    )
    (warned,) = [record for record in caplog.records if record.getMessage() == "Annotation anchored via degraded method"]
    assert {key: vars(warned)[key] for key in ("label", "text", "anchorMethod")} == {
        "label": "reference",
        "text": "Paris",
        "anchorMethod": "first-of-many",
    }


def test_a_mention_of_another_entity_type_than_was_asked_for_is_found_and_an_error_though_it_is_no_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # K4: the extractor drops it and says how many, and the job counts each as a proposal that made nothing.
    mentions_stood_in(monkeypatch, pieces(([mention("alpha", "Person")], ChunkCursor(next=END, size=500), 2)))
    handed = Handed(1)

    result = ran(link(TEXT, handed, linking("Person"), NOT_RESUMED, NONE_FINISHED))

    assert as_completed(result) == {"found": 3, "persisted": 1, "errors": 2}
    assert handed.committed.checkpoints == [UnitCheckpoint(unit="Person", cursor=cursor(END, 500, 3, 1, 2))]


def test_a_type_with_no_mentions_is_handed_over_and_finished_like_any_other(monkeypatch: pytest.MonkeyPatch) -> None:
    # D13: a piece with nothing to commit is checkpointed all the same. And the type is finished: a later attempt does not do it again.
    mentions_stood_in(monkeypatch, nothing_found)
    handed = Handed(1)

    result = ran(link("content", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    assert handed.committed.batches == [[]]
    assert handed.committed.checkpoints == [UnitCheckpoint(unit="Location", cursor=cursor(7, 1, 0, 0, 0))]
    assert handed.finished == ["Location"]
    assert as_completed(result) == {"found": 0, "persisted": 0}


def test_three_mentions_at_one_place_are_one_reference_and_one_place_of_two_types_is_two(monkeypatch: pytest.MonkeyPatch) -> None:
    # D5: within an entity type. The same words as two types are two annotations: their bodies differ.
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")] * 3))
    handed = Handed(1)
    result = ran(link("A trip to Paris.", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))
    assert len(handed.committed.annotations()) == 1
    assert as_completed(result) == {"found": 3, "persisted": 1}

    text = "The metal Mercury is dense."
    mentions_stood_in(monkeypatch, in_turn(one_piece([mention("Mercury", "Planet")]), one_piece([mention("Mercury", "Element")])))
    handed = Handed(1)
    result = ran(link(text, handed, linking("Planet", "Element"), NOT_RESUMED, NONE_FINISHED))
    assert [(position(annotation), body_of(annotation)) for annotation in handed.committed.annotations()] == [
        ((10, 17), [textual("Planet", "tagging", "en")]),
        ((10, 17), [textual("Element", "tagging", "en")]),
    ]
    assert as_completed(result) == {"found": 2, "persisted": 2}


def test_what_a_type_found_and_what_was_recorded_of_it_are_both_said_when_it_is_finished(monkeypatch: pytest.MonkeyPatch) -> None:
    # Three proposals at two places: the repeat is found and not recorded, and the two counts differ.
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location"), mention("Paris", "Location"), mention("Berlin", "Location")]))
    handed = Handed(1)

    ran(link("Paris and Berlin", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    said = handed.told.said()[-1]
    assert isinstance(said, dict)
    assert said["completedItems"] == [{"value": "Location", "foundCount": 3, "persistedCount": 2}]


def test_a_batch_the_record_refuses_fails_the_job_and_its_type_is_neither_counted_nor_finished(monkeypatch: pytest.MonkeyPatch) -> None:
    # F8, and D14: a type is finished only once its last batch is established.
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)
    refused = RuntimeError("mark:commit failed: sink down")
    asked = 0

    async def refusing(annotations: list[Annotation], checkpoint: UnitCheckpoint) -> None:
        nonlocal asked
        asked += 1
        if asked == 1:
            raise refused
        await handed.committed(annotations, checkpoint)

    handed.sink = refusing

    with pytest.raises(RuntimeError) as raised:
        link("Paris and Berlin", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED)

    assert raised.value is refused
    assert (asked, handed.finished) == (1, [])
    # Nothing was said after the batch was handed over: not that it was established, and no end.
    assert handed.told.codes() == ["loading", "detecting-entities"]

    # The next attempt does the whole type again, and counts it once.
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    result = ran(link("Paris and Berlin", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))
    assert as_completed(result) == {"found": 1, "persisted": 1}
    assert (asked, handed.finished) == (2, ["Location"])


def test_a_type_that_fails_stops_the_job_with_the_types_before_it_finished_and_itself_not(monkeypatch: pytest.MonkeyPatch) -> None:
    stalled = RuntimeError("Location stalled")

    async def failing(asked: AskedForMentions) -> None:
        raise stalled

    mentions_stood_in(monkeypatch, in_turn(one_piece([mention("Greeley", "Person")]), nothing_found, failing))
    handed = Handed(1)

    with pytest.raises(RuntimeError) as raised:
        link("Greeley went west", handed, linking("Person", "Date", "Location"), NOT_RESUMED, NONE_FINISHED)

    assert raised.value is stalled
    # A type with nothing found is finished like any other.
    assert handed.finished == ["Person", "Date"]
    assert [
        (checkpoint.unit, len(batch)) for checkpoint, batch in zip(handed.committed.checkpoints, handed.committed.batches, strict=True)
    ] == [
        ("Person", 1),
        ("Date", 0),
    ]


def test_a_type_is_handed_over_a_piece_at_a_time_and_said_to_be_finished_once(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "important text and the critical part is here."
    first, last = ChunkCursor(next=20, size=250), ChunkCursor(next=len(text), size=250)
    mentions_stood_in(monkeypatch, pieces(([mention("important", "Person")], first, 0), ([mention("critical", "Person")], last, 0)))
    handed = Handed(1)

    result = ran(link(text, handed, linking("Person"), NOT_RESUMED, NONE_FINISHED))

    assert [[quoted(annotation) for annotation in batch] for batch in handed.committed.batches] == [["important"], ["critical"]]
    assert handed.finished == ["Person"]
    # The answer is the job's counts and nothing more: the annotations left a piece at a time.
    assert as_completed(result) == {"found": 2, "persisted": 2}


def test_a_piece_kept_though_under_reported_is_said_with_its_type_and_counted_in_the_result(monkeypatch: pytest.MonkeyPatch) -> None:
    # K5.
    text = "Paris and Berlin and Rome"

    async def once(asked: AskedForMentions) -> None:
        asked.on_under_report(UnderReportedPiece(found=1, counted=4, piece_chars=530))
        await one_piece([mention("Paris", "Location")])(asked)

    mentions_stood_in(monkeypatch, once)
    handed = Handed(1)
    result = ran(link(text, handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))
    said = handed.told.said()[-1]
    assert isinstance(said, dict)
    assert said["completedItems"] == [
        {"value": "Location", "foundCount": 1, "persistedCount": 1, "underReported": {"pieces": 1, "found": 1, "counted": 4}}
    ]
    assert as_completed(result) == {"found": 1, "persisted": 1, "underReportedPieces": 1}

    # Two pieces of one type are said together.
    async def twice(asked: AskedForMentions) -> None:
        asked.on_under_report(UnderReportedPiece(found=1, counted=4, piece_chars=530))
        asked.on_under_report(UnderReportedPiece(found=2, counted=9, piece_chars=610))
        await nothing_found(asked)

    mentions_stood_in(monkeypatch, twice)
    handed = Handed(1)
    result = ran(link(text, handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))
    said = handed.told.said()[-1]
    assert isinstance(said, dict)
    assert said["completedItems"] == [
        {"value": "Location", "foundCount": 0, "persistedCount": 0, "underReported": {"pieces": 2, "found": 3, "counted": 13}}
    ]
    assert as_completed(result) == {"found": 0, "persisted": 0, "underReportedPieces": 2}


def test_a_type_none_of_whose_pieces_was_under_reported_says_nothing_of_it(monkeypatch: pytest.MonkeyPatch) -> None:
    mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)

    result = ran(link("Paris and Berlin and Rome", handed, linking("Location"), NOT_RESUMED, NONE_FINISHED))

    said = handed.told.said()[-1]
    assert isinstance(said, dict)
    # Absent, and not a nought or a null.
    assert said["completedItems"] == [{"value": "Location", "foundCount": 1, "persistedCount": 1}]
    assert as_completed(result) == {"found": 1, "persisted": 1}


def test_the_same_mentions_found_again_are_the_same_annotations_under_the_same_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    # WORKER-CONTRACT A2: a job that is retried commits the same annotations under the same ids.
    text = "Ada Lovelace met Charles Babbage in London."
    ids: list[list[str]] = []
    # A job that states English and one that states no language write the same body, and so the same id.
    for language in (None, None, "en"):
        mentions_stood_in(monkeypatch, one_piece([mention("Ada Lovelace", "Person"), mention("Charles Babbage", "Person")]))
        handed = Handed(1)
        ran(
            link(
                text, handed, LinkingJobParams(motivation="linking", entity_types=["Person"], language=language), NOT_RESUMED, NONE_FINISHED
            )
        )
        ids.append([annotation.id for annotation in handed.committed.annotations()])

    assert len(set(ids[0])) == 2
    assert ids[0] == ids[1] == ids[2]


# ── U2: a linking job claimed with finished entity types ────────────────


def standing_of(handed: Handed) -> list[JsonValue]:
    """The reports of where a linking job stands, in order."""
    return [said for said, code in zip(handed.told.said(), handed.told.codes(), strict=True) if code == "detecting-entities"]


def test_a_type_an_earlier_attempt_finished_is_not_done_again_and_is_counted_by_its_cursor_from_the_first_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "Paris and Berlin and Rome"
    asked = mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)
    # Person ended at the end of the text: twenty proposed, eighteen recorded, one that made nothing.
    ended = {"Person": cursor(len(text), 250, 20, 18, 1)}

    result = ran(link(text, handed, linking("Person", "Location"), ended, ["Person"]))

    assert [call.entity_types for call in asked] == [["Location"]]
    # Only what this attempt finished is said to be finished by it.
    assert handed.finished == ["Location"]
    assert as_completed(result) == {"found": 21, "persisted": 19, "errors": 1}

    person: JsonValue = {"value": "Person", "foundCount": 20, "persistedCount": 18}
    location: JsonValue = {"value": "Location", "foundCount": 1, "persistedCount": 1}
    request_params: JsonValue = [{"label": "entity-types", "value": "Person, Location"}]
    current: JsonValue = {"kind": "entity-type", "value": "Location"}
    standing = standing_of(handed)
    # Both types are the job's, and one of them is finished before this attempt asks anything.
    assert standing[0] == report(
        50,
        {"code": "detecting-entities", "entityType": "Location"},
        {
            "current": current,
            "processed": 1,
            "total": 2,
            "entitiesFound": 20,
            "entitiesEmitted": 18,
            "completedItems": [person],
            "requestParams": request_params,
        },
    )
    assert standing[-1] == report(
        80,
        {"code": "detecting-entities", "entityType": "Location"},
        {
            "current": current,
            "processed": 2,
            "total": 2,
            "entitiesFound": 21,
            "entitiesEmitted": 19,
            "completedItems": [person, location],
            "requestParams": request_params,
        },
    )
    assert handed.told.said()[-1] == report(
        100,
        {"code": "complete-created", "count": 19, "motivation": "linking"},
        {"completedItems": [person, location], "requestParams": request_params},
    )


def test_a_finished_type_the_record_holds_no_cursor_for_is_not_done_again_and_counts_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Paris and Berlin and Rome"
    asked = mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)

    result = ran(link(text, handed, linking("Person", "Location"), NOT_RESUMED, ["Person"]))

    assert [call.entity_types for call in asked] == [["Location"]]
    assert as_completed(result) == {"found": 1, "persisted": 1}
    first, last = handed.told.reports[1], handed.told.reports[-2]
    # Among the finished by number. Nothing says what it found, so it is not listed.
    assert (first.percentage, first.processed, first.total, first.entities_found, first.entities_emitted, first.completed_items) == (
        50,
        1,
        2,
        0,
        0,
        [],
    )
    assert last.completed_items is not None
    assert (last.percentage, last.processed, [item.value for item in last.completed_items]) == (80, 2, ["Location"])


def test_a_job_whose_every_type_was_finished_asks_about_nothing_and_answers_the_whole_job_from_its_cursors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "Paris and Berlin and Rome"
    asked = mentions_stood_in(monkeypatch, one_piece([mention("Paris", "Location")]))
    handed = Handed(1)
    ended = {"Person": cursor(len(text), 250, 20, 18, 1), "Location": cursor(len(text), 250, 3, 3, 0)}

    # The record names them in another order than the job does.
    result = ran(link(text, handed, linking("Person", "Location"), ended, ["Location", "Person"]))

    assert asked == []
    assert handed.finished == []
    assert as_completed(result) == {"found": 23, "persisted": 21, "errors": 1}
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {"requestParams": [{"label": "entity-types", "value": "Person, Location"}]}),
        report(
            100,
            {"code": "complete-created", "count": 21, "motivation": "linking"},
            {
                # The finished are listed in the job's order.
                "completedItems": [
                    {"value": "Person", "foundCount": 20, "persistedCount": 18},
                    {"value": "Location", "foundCount": 3, "persistedCount": 3},
                ],
                "requestParams": [{"label": "entity-types", "value": "Person, Location"}],
            },
        ),
    ]


# ── tagging: one unit for each category ─────────────────────────────────


def test_a_tag_s_body_is_its_category_and_the_schema_it_is_a_category_of(monkeypatch: pytest.MonkeyPatch) -> None:
    # K7: two bodies. Only the category's is in a language: the other is a schema's id.
    text = "foo bar baz"
    for stated, language in ((None, "en"), ("de", "de")):
        tags_stood_in(
            monkeypatch,
            in_turn(one_piece([tagged(text, "foo", "catA"), tagged(text, "bar", "catA")]), one_piece([tagged(text, "baz", "catB")])),
        )
        handed = Handed(1)
        params = TaggingJobParams(motivation="tagging", schema_id=SCHEMA.id, categories=["catA", "catB"], language=stated)

        result = ran(tag(text, handed, params, NOT_RESUMED))

        committed = handed.committed.annotations()
        assert [(annotation.motivation, quoted(annotation)) for annotation in committed] == [
            ("tagging", "foo"),
            ("tagging", "bar"),
            ("tagging", "baz"),
        ]
        assert [body_of(annotation) for annotation in committed] == [
            [textual("catA", "tagging", language), textual("schema-1", "classifying", None)],
            [textual("catA", "tagging", language), textual("schema-1", "classifying", None)],
            [textual("catB", "tagging", language), textual("schema-1", "classifying", None)],
        ]
        # D15: a tagging job adds the annotations committed for each category that has any.
        assert as_completed(result) == {"found": 3, "persisted": 3, "byCategory": {"catA": 2, "catB": 1}}


def test_a_tagging_job_reports_as_d19_says_and_checkpoints_each_category_under_its_own_name(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "Issue: the duty of care."
    tags_stood_in(monkeypatch, in_turn(one_piece([tagged(text, "duty of care", "catA")]), nothing_found))
    handed = Handed(1)

    result = ran(tag(text, handed, tagging("catA", "catB"), NOT_RESUMED))

    def at(category: str, processed: int, completed: list[JsonValue]) -> dict[str, JsonValue]:
        return {"current": {"kind": "category", "value": category}, "processed": processed, "total": 2, "completedItems": completed}

    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing-tags"}, {}),
        report(30, {"code": "analyzing-tags"}, at("catA", 0, [])),
        report(60, {"code": "creating-tag-annotations", "count": 1}, {}),
        report(45, {"code": "analyzing-tags"}, at("catB", 1, [{"value": "catA", "foundCount": 1}])),
        # Said after each category's piece, with what the job has made so far.
        report(60, {"code": "creating-tag-annotations", "count": 1}, {}),
        report(100, {"code": "complete-created", "count": 1, "motivation": "tagging"}, {}),
    ]
    # D13 and D14: a category with nothing to commit is checkpointed all the same, each under its own name.
    assert handed.committed.checkpoints == [
        UnitCheckpoint(unit="catA", cursor=cursor(len(text), 1, 1, 1, 0)),
        UnitCheckpoint(unit="catB", cursor=cursor(len(text), 1, 0, 0, 0)),
    ]
    # A category with no annotation is not among the counts by category.
    assert as_completed(result) == {"found": 1, "persisted": 1, "byCategory": {"catA": 1}}


def test_a_tagging_job_that_made_nothing_states_no_category(monkeypatch: pytest.MonkeyPatch) -> None:
    tags_stood_in(monkeypatch, nothing_found)
    result = ran(tag("content", Handed(1), tagging("catA"), NOT_RESUMED))
    assert as_completed(result) == {"found": 0, "persisted": 0, "byCategory": {}}


def test_where_a_tagging_job_stands_in_a_category_is_that_category_s_share_of_thirty_to_sixty(monkeypatch: pytest.MonkeyPatch) -> None:
    # D19, and F9 while a generation is awaited.
    async def walking(asked: Asked[TagMatch]) -> None:
        asked.on_activity(60, 120)
        await nothing_found(asked)

    tags_stood_in(monkeypatch, walking)
    handed = Handed(1)
    categories = [f"cat{number}" for number in range(4)]
    schema = TagSchema(
        id="four",
        name="Four",
        description="Four",
        domain="test",
        tags=[TagCategory(name=name, description=name, examples=[]) for name in categories],
    )

    run(
        process_tag_job(
            "x" * 120,
            handed.client,
            TaggingJobParams(motivation="tagging", schema_id="four", categories=categories),
            schema,
            build_annotation=text_build("x" * 120),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )

    of_categories = [told for told in handed.told.reports if told.current is not None]
    assert [(told.current.value if told.current is not None else None, told.processed, told.percentage) for told in of_categories] == [
        # Begun at 30 + round(30 x 0 / 4), and halfway through it at 30 + round(30 x 0.5 / 4).
        ("cat0", 0, 30),
        ("cat0", 0, 34),
        ("cat1", 1, 38),
        ("cat1", 1, 41),
        ("cat2", 2, 45),
        ("cat2", 2, 49),
        # A half is rounded to the greater: 30 x 3 / 4 is 22.5.
        ("cat3", 3, 53),
        ("cat3", 3, 56),
    ]
    assert {told.total for told in of_categories} == {4}


def test_two_tags_alike_are_one_annotation_and_are_counted_once_for_their_category(monkeypatch: pytest.MonkeyPatch) -> None:
    # D5, and D15: the counts by category are of what is committed.
    text = "Issue: the duty of care."
    tags_stood_in(monkeypatch, one_piece([tagged(text, "duty of care", "Issue"), tagged(text, "duty of care", "Issue")]))
    handed = Handed(1)

    result = ran(tag(text, handed, tagging("Issue"), NOT_RESUMED))

    assert [position(annotation) for annotation in handed.committed.annotations()] == [(11, 23)]
    assert as_completed(result) == {"found": 2, "persisted": 1, "byCategory": {"Issue": 1}}


def test_a_resumed_tagging_job_counts_by_category_what_an_earlier_attempt_committed(monkeypatch: pytest.MonkeyPatch) -> None:
    # U1: a category whose cursor stands at the length of the text is asked nothing, and is counted by its cursor.
    text = "Paris and Berlin and Rome"

    async def as_the_walk_does(asked: Asked[TagMatch]) -> None:
        if asked.resume is None:
            category = asked.of_the_job["category"]
            assert isinstance(category, str)
            await one_piece([tagged(text, "Paris", category)])(asked)

    tags_stood_in(monkeypatch, as_the_walk_does)
    handed = Handed(1)

    # catA was walked to the end of the text: three proposed, two recorded, one that made nothing.
    result = ran(tag(text, handed, tagging("catA", "catB"), {"catA": cursor(len(text), 300, 3, 2, 1)}))

    assert as_completed(result) == {"found": 4, "persisted": 3, "errors": 1, "byCategory": {"catA": 2, "catB": 1}}
    assert handed.told.said()[-1] == report(100, {"code": "complete-created", "count": 3, "motivation": "tagging"}, {})
