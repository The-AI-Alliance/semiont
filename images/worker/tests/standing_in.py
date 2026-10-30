"""What the tests of the processors share: what a processor is handed, and what stands in for the detection or the generation it calls.

A processor does one job from start to end, and what it calls is held by
tests of its own: a detection (`test_detection.py`), a generation
(`test_resource_generation.py`), the compiler (`test_typst.py`). So each is
stood in for here by a function that takes what the real one takes, keeps
what it was asked with, and does as its test scripts. A stand-in is put in
the processors' module under the real one's name, and `test_processors.py`
holds each to the real one's parameters.
"""

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Protocol, final

import pytest
from pydantic import JsonValue
from semiont.annotations import TextSpan, annotation_of_span
from semiont.identifiers import JobId, ResourceId
from semiont.model import written
from semiont.types import (
    Agent,
    AgentSoftware,
    AnchoredText,
    Annotation,
    AnnotationBodies,
    GenerationJobParams,
    JobProgress,
    JobReportProgressCommand,
    MarkJobCompleteCommand,
    MarkJobResult,
    Motivation,
    SupportedMediaType,
    TagSchema,
    UnitCursor,
)
from semiont.watched import Variable, Watched
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse

from semiont_worker import processors
from semiont_worker.detection.annotation_detection import OnActivity, OnChunkResults
from semiont_worker.detection.chunk_plan import ChunkCursor, UnderReportedPiece
from semiont_worker.detection.entity_extractor import Mention
from semiont_worker.detection.parsers import AssessmentMatch, CommentMatch, TagMatch
from semiont_worker.generation.resource_generation import GeneratedDocument, Repair
from semiont_worker.generation.typst import Compiled, LandedCompile, NotCompiled
from semiont_worker.processors import BuildAnnotation, OnChunkComplete, UnitCheckpoint

RESOURCE: Final = ResourceId("res-test")
JOB: Final = JobId("job-test")
GENERATOR: Final[Agent] = AgentSoftware(
    type="Software", id="did:web:test.local:agents:semiont-worker", name="test test", provider="test", model="test"
)


def text_build(text: str) -> BuildAnnotation:
    """How a span of `text` is built into an annotation of the resource, as the worker's agent."""

    def build(motivation: Motivation, span: TextSpan, body: AnnotationBodies | None) -> Annotation:
        return annotation_of_span(text, span, resource_id=RESOURCE, motivation=motivation, generator=GENERATOR, body=body)

    return build


def pdf_build(anchored: AnchoredText) -> BuildAnnotation:
    """The same of a PDF's anchored text: a span is selected by where its words are on a page."""

    def build(motivation: Motivation, span: TextSpan, body: AnnotationBodies | None) -> Annotation:
        return annotation_of_span(anchored, span, resource_id=RESOURCE, motivation=motivation, generator=GENERATOR, body=body)

    return build


def as_reported(report: JobProgress) -> JsonValue:
    """A report as the wire carries it: inside the command a held job sends it in."""
    command = JobReportProgressCommand(
        resource_id=RESOURCE, job_id=JOB, job_type="mark", attempt=1, percentage=report.percentage, progress=report
    )
    return written(command)["progress"]


def as_completed(result: MarkJobResult) -> JsonValue:
    """A `mark` job's result as the wire carries it: inside the command a held job completes with."""
    return written(MarkJobCompleteCommand(resource_id=RESOURCE, job_id=JOB, job_type="mark", attempt=1, result=result))["result"]


def report(percentage: int, message: Mapping[str, JsonValue], extra: Mapping[str, JsonValue]) -> JsonValue:
    """A report as the worker service's suite writes one: its percentage, its message, and what else it states."""
    return {"percentage": percentage, "message": {**message}, **extra}


@final
class Unasked:
    """A provider nothing is asked of: what a processor calls is stood in for, and a stand-in asks no model."""

    def __init__(self, max_concurrency: int) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "test"
        self.max_concurrency: Final = max_concurrency
        self.verify_detection_yield: Final = False

    async def limits(self) -> InferenceLimits:
        raise AssertionError("a provider that is stood in for is asked nothing")

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        raise AssertionError("a provider that is stood in for is asked nothing")

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        raise AssertionError("a provider that is stood in for is asked nothing")


@final
class Told:
    """What a processor reported, in order."""

    def __init__(self) -> None:
        self.reports: list[JobProgress] = []

    def __call__(self, report: JobProgress) -> None:
        self.reports.append(report)

    def said(self) -> list[JsonValue]:
        """Each report as the wire carries it."""
        return [as_reported(told) for told in self.reports]

    def codes(self) -> list[str]:
        """The code of each report's message."""
        codes: list[str] = []
        for told in self.reports:
            assert told.message is not None, "a processor reports a code with every percentage"
            codes.append(told.message.code)
        return codes


@final
class Committed:
    """What a processor handed over to be committed, a piece at a time, each with where that left its unit."""

    def __init__(self) -> None:
        self.batches: list[list[Annotation]] = []
        self.checkpoints: list[UnitCheckpoint] = []

    async def __call__(self, annotations: list[Annotation], checkpoint: UnitCheckpoint) -> None:
        # A turn of the loop, as a commit that waits on the record takes: were it not awaited, the processor would have gone on by now.
        await asyncio.sleep(0)
        self.batches.append(annotations)
        self.checkpoints.append(checkpoint)

    def annotations(self) -> list[Annotation]:
        """Every annotation handed over, in order."""
        return [annotation for batch in self.batches for annotation in batch]


@final
class Handed:
    """What a processor is handed of the service around it, each part kept for its test to read."""

    def __init__(self, max_concurrency: int) -> None:
        self.client: Final = Unasked(max_concurrency)
        self.told: Final = Told()
        self.committed: Final = Committed()
        self.sink: OnChunkComplete = self.committed
        """What the processor is handed to commit a piece with: `committed`, unless a test puts something before it."""
        self.cancelled: Final = Variable[bool](False)
        self.finished: list[str] = []
        """The units a linking job said were finished, in the order it said so."""

    async def unit_complete(self, unit: str) -> None:
        self.finished.append(unit)


# ── a detection that is stood in for ────────────────────────────────────


class HandsOn[M](Protocol):
    """What a script needs of the call it runs in: the text, and whoever is handed each piece's items."""

    @property
    def text(self) -> str: ...

    @property
    def hand_on(self) -> OnChunkResults[M]: ...


@final
@dataclass(frozen=True, slots=True)
class Asked[M]:
    """One call of a detection of passages that is stood in for: what it was asked with."""

    text: str
    client: InferenceClient
    of_the_job: Mapping[str, object]
    """What the call was told of its job, each under the parameter's name."""
    cancelled: Watched[bool]
    on_activity: OnActivity
    resume: UnitCursor | None
    hand_on: OnChunkResults[M]


@final
@dataclass(frozen=True, slots=True)
class AskedForMentions:
    """One call of the entity extractor that is stood in for: what it was asked with."""

    text: str
    entity_types: Sequence[str]
    client: InferenceClient
    of_the_job: Mapping[str, object]
    cancelled: Watched[bool]
    on_activity: OnActivity
    on_under_report: Callable[[UnderReportedPiece], None]
    on_counted: Callable[[int], None]
    on_unchecked: Callable[[], None]
    resume: UnitCursor | None
    hand_on: OnChunkResults[Mention]


type Script[A] = Callable[[A], Awaitable[None]]
"""What a stand-in does once it has kept what it was asked with."""


def in_turn[A](*scripts: Script[A]) -> Script[A]:
    """The first call does as the first of `scripts`, the second as the second, and a call beyond them fails its test."""
    remaining = iter(scripts)

    async def script(asked: A) -> None:
        nth = next(remaining, None)
        assert nth is not None, "the stand-in was called more often than its test scripted"
        await nth(asked)

    return script


async def nothing_found[M](asked: HandsOn[M]) -> None:
    """Hand on one piece, the whole text, in which nothing was found and nothing dropped."""
    await asked.hand_on([], ChunkCursor(next=len(asked.text), size=1), 0)


def one_piece[M](items: Sequence[M]) -> Script[HandsOn[M]]:
    """Hand on `items` as the one piece of the text: the walk then stands at the text's end, and nothing was dropped."""
    return pieces((items, None, 0))


def pieces[M](*handed: tuple[Sequence[M], ChunkCursor | None, int]) -> Script[HandsOn[M]]:
    """Hand on each piece in turn: its items, where the walk then stands (the text's end, where none is given), and how many it dropped."""

    async def script(asked: HandsOn[M]) -> None:
        for items, cursor, dropped in handed:
            await asked.hand_on([*items], ChunkCursor(next=len(asked.text), size=1) if cursor is None else cursor, dropped)

    return script


def highlights_stood_in(monkeypatch: pytest.MonkeyPatch, script: Script[Asked[TextSpan]]) -> list[Asked[TextSpan]]:
    """Stand in for `detect_highlights`, and answer every call made of it, as it is made."""
    asked: list[Asked[TextSpan]] = []

    async def detect_highlights(
        text: str,
        client: InferenceClient,
        *,
        instructions: str | None,
        density: float | None,
        source_language: str | None,
        cancelled: Watched[bool],
        on_activity: OnActivity,
        resume: UnitCursor | None,
        on_chunk_results: OnChunkResults[TextSpan],
    ) -> None:
        of_the_job = {"instructions": instructions, "density": density, "source_language": source_language}
        call = Asked(text, client, of_the_job, cancelled, on_activity, resume, on_chunk_results)
        asked.append(call)
        await script(call)

    monkeypatch.setattr(processors, "detect_highlights", detect_highlights)
    return asked


def comments_stood_in(monkeypatch: pytest.MonkeyPatch, script: Script[Asked[CommentMatch]]) -> list[Asked[CommentMatch]]:
    """Stand in for `detect_comments`, and answer every call made of it, as it is made."""
    asked: list[Asked[CommentMatch]] = []

    async def detect_comments(
        text: str,
        client: InferenceClient,
        *,
        instructions: str | None,
        tone: str | None,
        density: float | None,
        language: str | None,
        source_language: str | None,
        cancelled: Watched[bool],
        on_activity: OnActivity,
        resume: UnitCursor | None,
        on_chunk_results: OnChunkResults[CommentMatch],
    ) -> None:
        of_the_job = {
            "instructions": instructions,
            "tone": tone,
            "density": density,
            "language": language,
            "source_language": source_language,
        }
        call = Asked(text, client, of_the_job, cancelled, on_activity, resume, on_chunk_results)
        asked.append(call)
        await script(call)

    monkeypatch.setattr(processors, "detect_comments", detect_comments)
    return asked


def assessments_stood_in(monkeypatch: pytest.MonkeyPatch, script: Script[Asked[AssessmentMatch]]) -> list[Asked[AssessmentMatch]]:
    """Stand in for `detect_assessments`, and answer every call made of it, as it is made."""
    asked: list[Asked[AssessmentMatch]] = []

    async def detect_assessments(
        text: str,
        client: InferenceClient,
        *,
        instructions: str | None,
        tone: str | None,
        density: float | None,
        language: str | None,
        source_language: str | None,
        cancelled: Watched[bool],
        on_activity: OnActivity,
        resume: UnitCursor | None,
        on_chunk_results: OnChunkResults[AssessmentMatch],
    ) -> None:
        of_the_job = {
            "instructions": instructions,
            "tone": tone,
            "density": density,
            "language": language,
            "source_language": source_language,
        }
        call = Asked(text, client, of_the_job, cancelled, on_activity, resume, on_chunk_results)
        asked.append(call)
        await script(call)

    monkeypatch.setattr(processors, "detect_assessments", detect_assessments)
    return asked


def tags_stood_in(monkeypatch: pytest.MonkeyPatch, script: Script[Asked[TagMatch]]) -> list[Asked[TagMatch]]:
    """Stand in for `detect_tags`, and answer every call made of it, as it is made."""
    asked: list[Asked[TagMatch]] = []

    async def detect_tags(
        text: str,
        client: InferenceClient,
        *,
        schema: TagSchema,
        category: str,
        source_language: str | None,
        cancelled: Watched[bool],
        on_activity: OnActivity,
        resume: UnitCursor | None,
        on_chunk_results: OnChunkResults[TagMatch],
    ) -> None:
        of_the_job = {"schema": schema, "category": category, "source_language": source_language}
        call = Asked(text, client, of_the_job, cancelled, on_activity, resume, on_chunk_results)
        asked.append(call)
        await script(call)

    monkeypatch.setattr(processors, "detect_tags", detect_tags)
    return asked


def mentions_stood_in(monkeypatch: pytest.MonkeyPatch, script: Script[AskedForMentions]) -> list[AskedForMentions]:
    """Stand in for `extract_entities`, and answer every call made of it, as it is made."""
    asked: list[AskedForMentions] = []

    async def extract_entities(
        text: str,
        entity_types: Sequence[str],
        client: InferenceClient,
        *,
        include_descriptive_references: bool,
        source_language: str | None,
        cancelled: Watched[bool],
        on_activity: OnActivity,
        on_under_report: Callable[[UnderReportedPiece], None],
        on_counted: Callable[[int], None],
        on_unchecked: Callable[[], None],
        resume: UnitCursor | None,
        on_chunk_results: OnChunkResults[Mention],
    ) -> None:
        of_the_job = {"include_descriptive_references": include_descriptive_references, "source_language": source_language}
        call = AskedForMentions(
            text,
            entity_types,
            client,
            of_the_job,
            cancelled,
            on_activity,
            on_under_report,
            on_counted,
            on_unchecked,
            resume,
            on_chunk_results,
        )
        asked.append(call)
        await script(call)

    monkeypatch.setattr(processors, "extract_entities", extract_entities)
    return asked


# ── a generation that is stood in for ───────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class AskedToGenerate:
    """One call of the generation that is stood in for: what it was asked with."""

    params: GenerationJobParams
    output_media_type: SupportedMediaType
    client: InferenceClient
    repair: Repair | None


def generation_stood_in(monkeypatch: pytest.MonkeyPatch, answer: Callable[[AskedToGenerate], GeneratedDocument]) -> list[AskedToGenerate]:
    """Stand in for `generate_resource_from_topic`: each call is answered what `answer` makes of it. Answers every call made, as made."""
    asked: list[AskedToGenerate] = []

    async def generate_resource_from_topic(
        params: GenerationJobParams, output_media_type: SupportedMediaType, client: InferenceClient, repair: Repair | None
    ) -> GeneratedDocument:
        call = AskedToGenerate(params, output_media_type, client, repair)
        asked.append(call)
        return answer(call)

    monkeypatch.setattr(processors, "generate_resource_from_topic", generate_resource_from_topic)
    return asked


def landing_stood_in(monkeypatch: pytest.MonkeyPatch, outcome: LandedCompile | NotCompiled) -> list[tuple[str, list[int]]]:
    """Stand in for `compile_typst_landing`: every landing compile is answered `outcome`.

    Answers each source compiled and the ends marked in it, as they were asked for.
    """
    asked: list[tuple[str, list[int]]] = []

    def compile_typst_landing(source: str, ends: Sequence[int]) -> LandedCompile | NotCompiled:
        asked.append((source, list(ends)))
        return outcome

    monkeypatch.setattr(processors, "compile_typst_landing", compile_typst_landing)
    return asked


def compiler_stood_in(monkeypatch: pytest.MonkeyPatch, outcomes: Sequence[Compiled | NotCompiled]) -> list[str]:
    """Stand in for `compile_typst`: each compile is answered the next of `outcomes`, and the last of them from then on.

    Answers every source compiled, as it is compiled.
    """
    compiled: list[str] = []

    def compile_typst(source: str) -> Compiled | NotCompiled:
        compiled.append(source)
        return outcomes[min(len(compiled), len(outcomes)) - 1]

    monkeypatch.setattr(processors, "compile_typst", compile_typst)
    return compiled
