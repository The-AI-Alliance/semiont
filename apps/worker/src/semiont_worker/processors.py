"""The processors: one for each kind of job, each doing one job from start to end.

A `mark` job is a detection. Its processor asks a model for spans of the
resource's text a piece at a time (`semiont_worker.detection`), builds an
annotation of each, hands each piece's annotations over to be committed with
where that leaves the unit, reports where the job stands, and answers the
job's counts. A `yield` job makes a resource. Its processor asks a model for
the document (`semiont_worker.generation`) and answers the artifact to
upload. `docs/protocol/WORKER-SERVICE.md` states what each does, rule by
rule.

A processor reads nothing and sends nothing itself. It is handed the text
and how a span of it is built into an annotation
(`semiont_worker.detection.prepare_detection`), a provider, the job's
description, and what it needs of whoever holds the job: where to report,
how a piece is committed and checkpointed, the cursors and the finished
units the job was claimed with, and whether a cancellation has named the
job. It stops for one at its next stopping place, a `mark` job after the
piece it is on and a `yield` job once its model has answered, and answers
that it was cancelled, with the units it had finished.

A job's work is divided into units, the grain it checkpoints at: a
highlighting, commenting or assessing job is one unit, named by its
motivation; a linking job is one unit for each of its entity types; a
tagging job is one unit for each of its categories.
"""

import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal, final

from semiont.annotations import TextSpan, reconcile
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import stated
from semiont.types import (
    Annotation,
    AnnotationBodies,
    AssessingJobParams,
    CommentingJobParams,
    GenerationJobParams,
    HighlightingJobParams,
    JobDetectionResult,
    JobProgress,
    JobProgressAnalyzing,
    JobProgressAnalyzingTags,
    JobProgressCompleteCreated,
    JobProgressCompletedItemsItem,
    JobProgressCompletedItemsItemUnderReported,
    JobProgressCompleteGenerated,
    JobProgressCreatingAnnotations,
    JobProgressCreatingResource,
    JobProgressCreatingTagAnnotations,
    JobProgressCurrent,
    JobProgressDetectingEntities,
    JobProgressGeneratingResource,
    JobProgressLoading,
    JobProgressMessage,
    JobProgressRequestParamsItem,
    LinkingJobParams,
    Motivation,
    SupportedMediaType,
    TaggingJobParams,
    TagSchema,
    TextualBody,
    UnitCursor,
)
from semiont.watched import Watched
from semiont_inference.interface import InferenceClient
from semiont_service.white_space import trimmed

from semiont_worker.detection.anchor_audit import note_anchor
from semiont_worker.detection.annotation_detection import (
    OnActivity,
    OnChunkResults,
    detect_assessments,
    detect_comments,
    detect_highlights,
    detect_tags,
)
from semiont_worker.detection.bounded_concurrency import run_bounded
from semiont_worker.detection.chunk_plan import ChunkCursor, UnderReportedPiece
from semiont_worker.detection.entity_extractor import Mention, extract_entities
from semiont_worker.detection.parsers import AssessmentMatch, CommentMatch, TagMatch
from semiont_worker.failure_class import DeterministicJobError
from semiont_worker.generation.citations import CitableIds, GenerationCitation, collect_citable_ids, resolve_citation_tokens
from semiont_worker.generation.resource_generation import Repair, generate_resource_from_topic, tokens_asked
from semiont_worker.generation.typst import MAX_COMPILE_REPAIRS, Landed, NotCompiled, compile_typst, compile_typst_landing
from semiont_worker.log import LOG
from semiont_worker.media_types import GENERATABLE_MEDIA_TYPES
from semiont_worker.numbers import as_javascript_writes

type BuildAnnotation = Callable[[Motivation, TextSpan, AnnotationBodies | None], Annotation]
"""How a span of the text is built into an annotation of the job's resource: its motivation, the span, and its body where its kind has one.

The text, or a PDF's anchored text, the resource and the agent that works on
it are whoever made the builder's to know
(`semiont_worker.detection.prepare_detection`). A span's offsets are into the
text the model was asked about, and count code points. How the span is
anchored is the one thing that differs by media type, so a processor is the
same for every one.
"""

type OnProgress = Callable[[JobProgress], None]
"""Where a job says where it stands: a percentage, a message that is a code with its values, and what else the job's kind states.

It is not awaited, and it is called while a model is being asked: whoever is
handed a report sends it without making the job wait for it to be taken.
What describes the whole job is said again in every report, since whoever
follows a job holds only the last one.
"""


@final
@dataclass(frozen=True, slots=True)
class UnitCheckpoint:
    """Where one unit stands once the piece just handed over is committed: the cursor a later attempt takes the unit up from."""

    unit: str
    cursor: UnitCursor


type OnChunkComplete = Callable[[list[Annotation], UnitCheckpoint], Awaitable[None]]
"""How a piece's annotations are committed, and its unit's cursor recorded once they are.

It is awaited, and nothing of the piece is counted until it returns: a
failure it raises fails the job with the piece uncounted. The two are one
step so that a cursor never states more than the record holds. It is called
for a piece with no annotations too, which commits nothing and moves its
unit's cursor all the same.
"""

type OnUnitComplete = Callable[[str], Awaitable[None]]
"""How an entity type is said to be finished, once every piece of it is committed. It carries no annotations: each left with its piece."""


@final
@dataclass(frozen=True, slots=True)
class Cancelled:
    """How a job a cancellation stopped ended: the units it had finished by then, which is what `job:cancel` names.

    A unit it was partway through is not among them, and neither is one an
    earlier attempt finished.
    """

    completed_units: list[str]


def _is(cancelled: Watched[bool]) -> bool:
    """Whether a cancellation has named the job by now.

    It is asked afresh at each place a job may stop, since the answer changes
    while the job waits on its model or on the record. A type checker that
    sees `value` read twice in one function takes the second reading for the
    first, which is why every reading is made here.
    """
    return cancelled.value


_PLAIN_TEXT: Final[SupportedMediaType] = "text/plain"
"""What the text of a body is written in."""

_ENGLISH: Final = "en"
"""The language of a body's text where its job states none."""


def _rounded(number: float) -> int:
    """`number` to the nearest whole number, one halfway between two to the greater."""
    below = math.floor(number)
    return below + 1 if number - below >= 0.5 else below


def _textual(value: str, purpose: Literal["commenting", "assessing", "tagging"], language: str | None) -> TextualBody:
    """A body of plain text, in the job's language, or in English where the job states none."""
    return TextualBody(
        type="TextualBody", value=value, purpose=purpose, format=_PLAIN_TEXT, language=_ENGLISH if language is None else language
    )


def _repeats_removed() -> Callable[[list[Annotation]], list[Annotation]]:
    """What takes the repeats out of each piece's annotations, over the pieces of one unit, or of one job whose units share a motivation.

    Two annotations alike in motivation, place and body are one, and that is
    what an annotation's id is worked out from: the second of an id is a
    repeat. Two things make them. Pieces overlap, so a span at a cut is
    proposed twice. And each proposal is looked for in the text alone, so
    several of the same words, with nothing to tell them apart, are found at
    the first place the text has them. Two annotations of one place with
    different bodies are not repeats: one name as two entity types, two
    comments on one passage.
    """
    seen: set[AnnotationId] = set()

    def without_repeats(annotations: list[Annotation]) -> list[Annotation]:
        fresh: list[Annotation] = []
        for annotation in annotations:
            if annotation.id not in seen:
                seen.add(annotation.id)
                fresh.append(annotation)
        return fresh

    return without_repeats


def _detected(
    found: int, persisted: int, errors: int, by_category: dict[str, int] | None, under_reported_pieces: int
) -> JobDetectionResult:
    """A `mark` job's counts.

    `found` is what the model proposed and `persisted` what was committed.
    How many proposals made no annotation, and how many pieces were kept
    though under-reported, are each stated only when there were any: absent
    is the one way to say none.
    """
    return stated(
        JobDetectionResult(
            found=found,
            persisted=persisted,
            errors=errors if errors > 0 else None,
            by_category=by_category,
            under_reported_pieces=under_reported_pieces if under_reported_pieces > 0 else None,
        )
    )


@final
@dataclass(slots=True)
class _Unit:
    """One unit's counts so far, and where its walk stands: what its cursor states, less the size its last piece was cut at."""

    found: int
    emitted: int
    errors: int
    next: int
    """The offset the unit's next piece starts at, or the length of the text after its last."""

    def after(self, cursor: ChunkCursor, found: int, emitted: int, errors: int) -> UnitCursor:
        """The unit's cursor once a piece that leaves the walk at `cursor`, and adds these counts, is committed."""
        return UnitCursor(
            next=cursor.next, size=cursor.size, found=self.found + found, emitted=self.emitted + emitted, errors=self.errors + errors
        )

    def take(self, committed: UnitCursor) -> None:
        """The piece is committed: the unit stands where its cursor says."""
        self.found, self.emitted, self.errors, self.next = committed.found, committed.emitted, committed.errors, committed.next


def _taken_up(prior: UnitCursor | None) -> _Unit:
    """A unit as its job begins it: at the cursor the job was claimed with for it, counts and all, or at the start with nothing counted."""
    if prior is None:
        return _Unit(found=0, emitted=0, errors=0, next=0)
    return _Unit(found=prior.found, emitted=prior.emitted, errors=prior.errors, next=prior.next)


# ── highlighting, commenting, assessing ─────────────────────────────────


def _asked_with(instructions: str | None, tone: str | None, density: float | None) -> list[JobProgressRequestParamsItem] | None:
    """What a job was asked with, for every report to repeat: its instructions, its tone and its density, those it has, in that order.

    The words are the job's own, less the white space at their ends, and
    blank ones are not said. Nothing is answered for a job that has none of
    the three: a report then states no such list, where an empty one would
    be shown as an empty box.
    """
    asked: list[JobProgressRequestParamsItem] = []
    if instructions is not None and trimmed(instructions):
        asked.append(JobProgressRequestParamsItem(label="instructions", value=trimmed(instructions)))
    if tone is not None and trimmed(tone):
        asked.append(JobProgressRequestParamsItem(label="tone", value=trimmed(tone)))
    if density is not None:
        asked.append(JobProgressRequestParamsItem(label="density", value=as_javascript_writes(density)))
    return asked or None


async def _mark_passages[M: TextSpan](
    unit: Literal["highlighting", "commenting", "assessing"],
    text: str,
    asked_with: list[JobProgressRequestParamsItem] | None,
    detect: Callable[[OnActivity, OnChunkResults[M]], Awaitable[None]],
    body_of: Callable[[M], AnnotationBodies | None],
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_chunk_complete: OnChunkComplete,
    prior: UnitCursor | None,
) -> JobDetectionResult | Cancelled:
    """A job of one unit, named by its motivation: what a highlighting, a commenting and an assessing job have in common.

    `detect` asks about the text a piece at a time and hands on each piece's
    passages, and `body_of` is the body of a passage's annotation. `prior` is
    the cursor the job was claimed with for its unit: the counts begin there,
    so the job's result is the whole text's.

    A job cancelled before it began asks nothing and reports nothing. One
    cancelled later stops after the piece it is on, which `detect` sees to,
    and reports no end: its one unit is finished, and named, where that
    piece was the text's last.
    """
    if _is(cancelled):
        return Cancelled(completed_units=[])

    def report(percentage: int, message: JobProgressMessage) -> None:
        on_progress(stated(JobProgress(percentage=percentage, message=message, request_params=asked_with)))

    report(10, JobProgressLoading(code="loading"))
    report(30, JobProgressAnalyzing(code="analyzing"))

    repeats_removed = _repeats_removed()
    counted = _taken_up(prior)

    async def on_chunk_results(matches: list[M], cursor: ChunkCursor, dropped: int) -> None:
        fresh = repeats_removed([build_annotation(unit, match, body_of(match)) for match in matches])
        committing = counted.after(cursor, len(matches) + dropped, len(fresh), dropped)
        report(60, JobProgressCreatingAnnotations(code="creating-annotations", count=committing.emitted))
        await on_chunk_complete(fresh, UnitCheckpoint(unit=unit, cursor=committing))
        counted.take(committing)

    def on_activity(consumed: int, total: int) -> None:
        # Between 30 and 60, by how far through the text the job is.
        report(30 + _rounded((consumed / total) * 30), JobProgressAnalyzing(code="analyzing"))

    await detect(on_activity, on_chunk_results)

    if _is(cancelled):
        return Cancelled(completed_units=[unit] if counted.next >= len(text) else [])

    report(100, JobProgressCompleteCreated(code="complete-created", count=counted.emitted, motivation=unit))
    return _detected(counted.found, counted.emitted, counted.errors, None, 0)


async def process_highlight_job(
    text: str,
    client: InferenceClient,
    params: HighlightingJobParams,
    *,
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_chunk_complete: OnChunkComplete,
    resume_cursors: Mapping[str, UnitCursor],
) -> JobDetectionResult | Cancelled:
    """Do a highlighting job over `text`: a highlight of each passage the model finds worth a reader's attention.

    A highlight has no body.
    """
    prior = resume_cursors.get("highlighting")

    async def detect(on_activity: OnActivity, on_chunk_results: OnChunkResults[TextSpan]) -> None:
        await detect_highlights(
            text,
            client,
            instructions=params.instructions,
            density=params.density,
            source_language=params.source_language,
            cancelled=cancelled,
            on_activity=on_activity,
            resume=prior,
            on_chunk_results=on_chunk_results,
        )

    return await _mark_passages(
        "highlighting",
        text,
        _asked_with(params.instructions, None, params.density),
        detect,
        lambda _highlight: None,
        build_annotation,
        on_progress,
        cancelled,
        on_chunk_complete,
        prior,
    )


async def process_comment_job(
    text: str,
    client: InferenceClient,
    params: CommentingJobParams,
    *,
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_chunk_complete: OnChunkComplete,
    resume_cursors: Mapping[str, UnitCursor],
) -> JobDetectionResult | Cancelled:
    """Do a commenting job over `text`: a comment on each passage the model has one for.

    A comment's body is a list of one body of text: the comment, in the
    job's language.
    """
    prior = resume_cursors.get("commenting")

    async def detect(on_activity: OnActivity, on_chunk_results: OnChunkResults[CommentMatch]) -> None:
        await detect_comments(
            text,
            client,
            instructions=params.instructions,
            tone=params.tone,
            density=params.density,
            language=params.language,
            source_language=params.source_language,
            cancelled=cancelled,
            on_activity=on_activity,
            resume=prior,
            on_chunk_results=on_chunk_results,
        )

    return await _mark_passages(
        "commenting",
        text,
        _asked_with(params.instructions, params.tone, params.density),
        detect,
        lambda match: [_textual(match.comment, "commenting", params.language)],
        build_annotation,
        on_progress,
        cancelled,
        on_chunk_complete,
        prior,
    )


async def process_assessment_job(
    text: str,
    client: InferenceClient,
    params: AssessingJobParams,
    *,
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_chunk_complete: OnChunkComplete,
    resume_cursors: Mapping[str, UnitCursor],
) -> JobDetectionResult | Cancelled:
    """Do an assessing job over `text`: an assessment of each passage the model judges.

    An assessment's body is one body of text and no list: the assessment, in
    the job's language. Whoever reads one reads its `value` straight off the
    body.
    """
    prior = resume_cursors.get("assessing")

    async def detect(on_activity: OnActivity, on_chunk_results: OnChunkResults[AssessmentMatch]) -> None:
        await detect_assessments(
            text,
            client,
            instructions=params.instructions,
            tone=params.tone,
            density=params.density,
            language=params.language,
            source_language=params.source_language,
            cancelled=cancelled,
            on_activity=on_activity,
            resume=prior,
            on_chunk_results=on_chunk_results,
        )

    return await _mark_passages(
        "assessing",
        text,
        _asked_with(params.instructions, params.tone, params.density),
        detect,
        lambda match: _textual(match.assessment, "assessing", params.language),
        build_annotation,
        on_progress,
        cancelled,
        on_chunk_complete,
        prior,
    )


# ── linking ─────────────────────────────────────────────────────────────


@final
@dataclass(slots=True)
class _Linked:
    """What a linking job has counted so far, over every entity type and every attempt."""

    found: int
    emitted: int
    errors: int
    expected: int
    """What the counts of the pieces accepted so far come to. Nought until a piece is counted, and of this attempt alone."""
    under_reported_pieces: int
    finished: int
    """How many entity types are finished: those of earlier attempts, and this one's."""


async def process_reference_job(
    text: str,
    client: InferenceClient,
    params: LinkingJobParams,
    *,
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_unit_complete: OnUnitComplete,
    on_chunk_complete: OnChunkComplete,
    resume_cursors: Mapping[str, UnitCursor],
    completed_units: Sequence[str],
) -> JobDetectionResult | Cancelled:
    """Do a linking job over `text`: a reference at each mention of one of the job's entity types, linked to nothing yet.

    Each entity type is a unit of its own, with its own extraction, its own
    commits and its own cursor, and as many are with the model at once as the
    provider says it has room for. A type's pieces are handed over as each
    lands. Once the last is committed the type is said to be finished
    (`on_unit_complete`), and not before: a type whose commit failed is not
    finished, and a later attempt does it again.

    `completed_units` are the types earlier attempts finished. They are not
    asked about again, and each is counted by the cursor `resume_cursors`
    holds for it. A reference's body is a list of one body of text that tags
    the entity type. It is what a later binding adds the linked resource to.

    A cancellation stops each type that is with the model after the piece it
    is on. One whose last piece that was is finished as any other is, one
    with text left is not, and no type is begun. Nothing is reported after
    the piece's commit, and no end.
    """
    if _is(cancelled):
        return Cancelled(completed_units=[])

    entity_types = list(params.entity_types)
    request_params = [JobProgressRequestParamsItem(label="entity-types", value=", ".join(entity_types))]
    completed_items: list[JobProgressCompletedItemsItem] = []
    # The types this attempt finished, in the order they finished: what a cancellation names.
    finished_units: list[str] = []

    on_progress(JobProgress(percentage=10, message=JobProgressLoading(code="loading"), request_params=request_params))

    # The types an earlier attempt finished are the job's all the same: they are among the finished from the first
    # report, in the job's order, each with what its cursor counted. One the record holds no cursor for is finished,
    # and nothing says what it found: it is not listed.
    finished_earlier = [entity_type for entity_type in entity_types if entity_type in completed_units]
    for entity_type in finished_earlier:
        ended = resume_cursors.get(entity_type)
        if ended is not None:
            completed_items.append(JobProgressCompletedItemsItem(value=entity_type, found_count=ended.found, persisted_count=ended.emitted))
    # A cursor is held for every unit the job has begun, the finished among them, so the counts are the whole job's from the first report.
    job = _Linked(
        found=sum(cursor.found for cursor in resume_cursors.values()),
        emitted=sum(cursor.emitted for cursor in resume_cursors.values()),
        errors=sum(cursor.errors for cursor in resume_cursors.values()),
        expected=0,
        under_reported_pieces=0,
        finished=len(finished_earlier),
    )

    def report(entity_type: str) -> None:
        """Say where the job stands while it works on `entity_type`. Types finish in no order, so it is how many are done, and not which."""
        on_progress(
            stated(
                JobProgress(
                    percentage=20 + _rounded((job.finished / len(entity_types)) * 60),
                    message=JobProgressDetectingEntities(code="detecting-entities", entity_type=entity_type),
                    current=JobProgressCurrent(kind="entity-type", value=entity_type),
                    processed=job.finished,
                    total=len(entity_types),
                    entities_found=job.found,
                    entities_expected=job.expected if job.expected > 0 else None,
                    entities_emitted=job.emitted,
                    completed_items=[*completed_items],
                    request_params=request_params,
                )
            )
        )

    async def link(entity_type: str, _place: int) -> None:
        if not entity_type:
            return
        # A type whose turn comes once the job is cancelled is not begun.
        if _is(cancelled):
            return

        report(entity_type)

        body: AnnotationBodies = [_textual(entity_type, "tagging", params.language)]
        repeats_removed = _repeats_removed()
        prior = resume_cursors.get(entity_type)
        counted = _taken_up(prior)
        kept_under_reported: list[UnderReportedPiece] = []

        def on_counted(mentions: int) -> None:
            job.expected += mentions
            report(entity_type)

        async def on_chunk_results(mentions: list[Mention], cursor: ChunkCursor, dropped: int) -> None:
            built: list[Annotation] = []
            # A mention of another entity type than this unit's was proposed and made nothing: it is counted with
            # those whose text is nowhere.
            nowhere = dropped
            for mention in mentions:
                found = reconcile(text, mention.quoted)
                if found is None:
                    LOG.error(
                        "Entity dropped \N{EM DASH} text not found in source",
                        extra={"text": mention.quoted.exact, "entityType": mention.entity_type},
                    )
                    nowhere += 1
                    continue
                note_anchor("reference", mention.quoted.exact, found.anchor_method)
                built.append(build_annotation("linking", found, body))
            fresh = repeats_removed(built)
            proposed = len(mentions) + dropped
            # The cursor is worked out before the commit, which records it, and taken up after: a piece that fails to
            # commit adds nothing anywhere.
            committing = counted.after(cursor, proposed, len(fresh), nowhere)
            await on_chunk_complete(fresh, UnitCheckpoint(unit=entity_type, cursor=committing))
            counted.take(committing)
            job.found += proposed
            job.emitted += len(fresh)
            job.errors += nowhere
            # A cancelled job has stopped with this piece's commit, and says nothing after it.
            if not _is(cancelled):
                report(entity_type)

        await extract_entities(
            text,
            [entity_type],
            client,
            include_descriptive_references=params.include_descriptive_references is True,
            source_language=params.source_language,
            cancelled=cancelled,
            # While a piece is with the model, and at each boundary between pieces: the job says again where it stands.
            on_activity=lambda _consumed, _total: report(entity_type),
            on_under_report=kept_under_reported.append,
            on_counted=on_counted,
            resume=prior,
            on_chunk_results=on_chunk_results,
        )

        # A cancellation stopped the type with text left: it is not finished.
        if _is(cancelled) and counted.next < len(text):
            return

        # Every piece of the type is committed. Only now is it finished.
        await on_unit_complete(entity_type)
        finished_units.append(entity_type)
        under_reported = (
            JobProgressCompletedItemsItemUnderReported(
                pieces=len(kept_under_reported),
                found=sum(piece.found for piece in kept_under_reported),
                counted=sum(piece.counted for piece in kept_under_reported),
            )
            if kept_under_reported
            else None
        )
        completed_items.append(
            stated(
                JobProgressCompletedItemsItem(
                    value=entity_type, found_count=counted.found, persisted_count=counted.emitted, under_reported=under_reported
                )
            )
        )
        job.under_reported_pieces += len(kept_under_reported)
        job.finished += 1
        if not _is(cancelled):
            report(entity_type)

    await run_bounded([entity_type for entity_type in entity_types if entity_type not in finished_earlier], client.max_concurrency, link)

    # A cancelled job reports no end, whether or not anything was left to do.
    if _is(cancelled):
        return Cancelled(completed_units=finished_units)

    on_progress(
        stated(
            JobProgress(
                percentage=100,
                message=JobProgressCompleteCreated(code="complete-created", count=job.emitted, motivation="linking"),
                entities_expected=job.expected if job.expected > 0 else None,
                completed_items=[*completed_items],
                request_params=request_params,
            )
        )
    )
    return _detected(job.found, job.emitted, job.errors, None, job.under_reported_pieces)


# ── tagging ─────────────────────────────────────────────────────────────


async def process_tag_job(
    text: str,
    client: InferenceClient,
    params: TaggingJobParams,
    schema: TagSchema,
    *,
    build_annotation: BuildAnnotation,
    on_progress: OnProgress,
    cancelled: Watched[bool],
    on_chunk_complete: OnChunkComplete,
    resume_cursors: Mapping[str, UnitCursor],
) -> JobDetectionResult | Cancelled:
    """Do a tagging job over `text`: a tag on each passage that serves as one of the job's categories of `schema`.

    `schema` is the one the job's `schema_id` names, as the Dispatcher handed
    it over with the job. Each category is a unit of its own, taken in the
    job's order, each over the whole text: one cursor for them all would
    skip text for every category but one. A tag's body is a list of two
    bodies of text: the category, in the job's language, and the schema's
    id, which is the one trace of which schema a tag is of.

    A cancellation stops the job after the piece it is on. The category it
    was on is named among the finished where that piece was the text's last,
    no other category is begun, and no end is reported.
    """
    if _is(cancelled):
        return Cancelled(completed_units=[])

    categories = params.categories

    def report(percentage: int, message: JobProgressMessage) -> None:
        on_progress(JobProgress(percentage=percentage, message=message))

    report(10, JobProgressLoading(code="loading"))
    report(30, JobProgressAnalyzingTags(code="analyzing-tags"))

    # One for every category: they share a motivation, and a tag's body states its category, so only true repeats are taken out.
    repeats_removed = _repeats_removed()
    # What earlier attempts committed is the job's too. What they found, and what made nothing, is added a category at a time, below.
    created = sum(cursor.emitted for cursor in resume_cursors.values())
    by_category: dict[str, int] = {}
    completed_items: list[JobProgressCompletedItemsItem] = []
    # The categories whose walk reached the end of the text: what a cancellation names.
    finished_units: list[str] = []

    async def tag(place: int, category: str) -> _Unit:
        """Walk the text for one category, and answer what it counted and where its walk stands."""

        def report_category(share: float) -> None:
            """Say where the job stands in this category: between 30 and 60, by the categories done and `share` of this one."""
            on_progress(
                JobProgress(
                    percentage=30 + _rounded(((place + share) / len(categories)) * 30),
                    message=JobProgressAnalyzingTags(code="analyzing-tags"),
                    current=JobProgressCurrent(kind="category", value=category),
                    processed=place,
                    total=len(categories),
                    completed_items=[*completed_items],
                )
            )

        report_category(0)
        prior = resume_cursors.get(category)
        counted = _taken_up(prior)
        # What earlier attempts committed for this category is in the count by category, as it is in the job's. It is
        # put there once: a category the job names twice is walked twice, and its cursor counted once.
        if counted.emitted > 0:
            by_category.setdefault(category, counted.emitted)

        async def on_chunk_results(matches: list[TagMatch], cursor: ChunkCursor, dropped: int) -> None:
            nonlocal created
            category_of: dict[AnnotationId, str] = {}
            built: list[Annotation] = []
            for match in matches:
                tagged = build_annotation(
                    "tagging",
                    match,
                    [
                        _textual(match.category, "tagging", params.language),
                        TextualBody(type="TextualBody", value=schema.id, purpose="classifying", format=_PLAIN_TEXT),
                    ],
                )
                category_of[tagged.id] = match.category
                built.append(tagged)
            fresh = repeats_removed(built)
            created += len(fresh)
            # By category, what is committed: the repeats are out.
            for tagged in fresh:
                by_category[category_of[tagged.id]] = by_category.get(category_of[tagged.id], 0) + 1
            report(60, JobProgressCreatingTagAnnotations(code="creating-tag-annotations", count=created))
            committing = counted.after(cursor, len(matches) + dropped, len(fresh), dropped)
            await on_chunk_complete(fresh, UnitCheckpoint(unit=category, cursor=committing))
            counted.take(committing)

        await detect_tags(
            text,
            client,
            schema=schema,
            category=category,
            source_language=params.source_language,
            cancelled=cancelled,
            on_activity=lambda consumed, total: report_category(consumed / total),
            resume=prior,
            on_chunk_results=on_chunk_results,
        )
        return counted

    found = 0
    errors = 0
    for place, category in enumerate(categories):
        counted = await tag(place, category)
        if counted.next >= len(text):
            finished_units.append(category)
        if _is(cancelled):
            return Cancelled(completed_units=finished_units)
        found += counted.found
        errors += counted.errors
        completed_items.append(JobProgressCompletedItemsItem(value=category, found_count=counted.found))

    report(100, JobProgressCompleteCreated(code="complete-created", count=created, motivation="tagging"))
    return _detected(found, created, errors, by_category, 0)


# ── generation ──────────────────────────────────────────────────────────

MAX_OUTPUT_BYTES: Final = 200 * 1024 * 1024
"""The most a generated artifact may weigh, in bytes.

It is the most the Smelter reads of a PDF, on purpose: a larger artifact
would be a resource the Smelter declines as too large.
"""


def assert_within_output_budget(byte_length: int) -> None:
    """Refuse an artifact of `byte_length` bytes that is over the most one may weigh.

    A generation that ran away fails, and uploads nothing.
    """
    if byte_length > MAX_OUTPUT_BYTES:
        raise RuntimeError(
            f"Generated artifact exceeds the output byte budget: {byte_length} bytes > {MAX_OUTPUT_BYTES}. Refusing a runaway generation."
        )


@final
@dataclass(frozen=True, slots=True)
class GeneratedText:
    """What a `yield` job that writes text made: the text to upload, and the claims in it to cite.

    It is not the job's result. A generation has none to state before its
    resource exists.
    """

    content: bytes
    """The text's UTF-8."""
    title: str
    """The job's own title."""
    format: SupportedMediaType
    citations: list[GenerationCitation]
    """Each claim with the source it cites, by its offsets into the text as decoded."""
    truncated: bool
    """Whether the model was cut off at the length asked for: the text is then not whole."""


@final
@dataclass(frozen=True, slots=True)
class PdfCitation:
    """One claim of a generated PDF, and the source it cites.

    A PDF is anchored by where its words are on a page, so a claim is cited
    by its words and by where the compiler says it ended: offsets into the
    Typst source say nothing of where the claim is in the PDF.
    """

    resource_id: ResourceId
    """The resource cited: one the context showed."""
    annotation_id: AnnotationId | None
    """The annotation the cited passage came from, where the token named one: one the context showed."""
    exact: str
    """The claim, as the source has it."""
    landed: Landed
    """Where the compiler says the claim ended."""


@final
@dataclass(frozen=True, slots=True)
class GeneratedPdf:
    """What a `yield` job that makes a PDF made: the PDF to upload, and the claims in it to cite.

    It is not the job's result. A generation has none to state before its
    resource exists.
    """

    content: bytes
    """The PDF's bytes."""
    title: str
    """The job's own title."""
    citations: list[PdfCitation]
    truncated: bool
    """Whether the model was cut off at the length asked for: the PDF is then not whole."""

    @property
    def format(self) -> SupportedMediaType:
        return "application/pdf"


type GeneratedArtifact = GeneratedText | GeneratedPdf
"""What a `yield` job made, of either kind."""


def _cited(document: str, citable: CitableIds | None, written_as: SupportedMediaType) -> tuple[str, list[GenerationCitation]]:
    """A document without its citation tokens, and the citations they made. Of a job that asks for none: the document as it is, and none."""
    if citable is None:
        return document, []
    resolved = resolve_citation_tokens(document, citable, written_as)
    return resolved.content, resolved.citations


async def process_generation_job(
    client: InferenceClient, params: GenerationJobParams, *, on_progress: OnProgress, cancelled: Watched[bool]
) -> GeneratedArtifact | Cancelled:
    """Do a `yield` job as far as the artifact: ask the model for the document, and make of its answer what is uploaded.

    The job writes Markdown where it states no format. For a PDF the model
    writes Typst, which the worker compiles. A source that does not compile
    is handed back to the model with what the compiler said, a bounded
    number of times. With `cite`, the tokens the model cites its sources with
    are resolved before anything is stored or compiled: a marked token leaves
    the words it wrapped, a bare one becomes its source's name, and each that
    names what the context showed is answered as a citation of those words.

    A cancellation that has arrived by the time the model has answered ends
    the job there: nothing is made of the answer, and nothing more is
    reported. It does not end the call to the model, which runs to its
    answer or to its own bound.

    Raises a `DeterministicJobError`, before anything is asked of the model,
    for a format the registry does not mark generatable: the worker writes
    the same formats on every attempt.
    """
    output_media_type: SupportedMediaType = "text/markdown" if params.output_media_type is None else params.output_media_type
    if output_media_type not in GENERATABLE_MEDIA_TYPES:
        raise DeterministicJobError(
            f"Unsupported outputMediaType for generation: {output_media_type}. Generation produces {' or '.join(GENERATABLE_MEDIA_TYPES)}."
        )

    def report(percentage: int, message: JobProgressMessage) -> None:
        on_progress(JobProgress(percentage=percentage, message=message))

    # A generation is one call with nothing to measure inside it: it is said to begin, and to be done.
    report(5, JobProgressGeneratingResource(code="generating-resource"))
    citable = collect_citable_ids(params.context) if params.cite else None
    generated = await generate_resource_from_topic(params, output_media_type, client, None)
    if _is(cancelled):
        return Cancelled(completed_units=[])
    source, citations = _cited(generated.content, citable, output_media_type)

    if output_media_type == "application/pdf":
        compiled = compile_typst(source)
        repairs = 0
        while isinstance(compiled, NotCompiled):
            # A source that was cut off and does not compile is not wrong, it is unfinished: every repair is asked for
            # at the same length, and none restores what was never written.
            if generated.truncated:
                raise RuntimeError(
                    f"Generation stopped at the maxTokens ceiling ({tokens_asked(params)} tokens) and the cut-off Typst source does not "
                    f"compile \N{EM DASH} repair cannot help; raise maxTokens. Compile error: {compiled.error}"
                )
            if repairs >= MAX_COMPILE_REPAIRS:
                raise RuntimeError(f"Typst compilation failed after {MAX_COMPILE_REPAIRS} repair attempts: {compiled.error}")
            repairs += 1
            LOG.warning(
                "Typst compile failed \N{EM DASH} feeding the error back for repair",
                extra={"attempt": repairs, "error": compiled.error[:500]},
            )
            generated = await generate_resource_from_topic(params, output_media_type, client, Repair(source=source, error=compiled.error))
            if _is(cancelled):
                return Cancelled(completed_units=[])
            source, citations = _cited(generated.content, citable, output_media_type)
            compiled = compile_typst(source)
        pdf, landed = _landed(source, citations, compiled.pdf)
        assert_within_output_budget(len(pdf))
        report(95, JobProgressCreatingResource(code="creating-resource"))
        report(100, JobProgressCompleteGenerated(code="complete-generated", truncated=generated.truncated))
        return GeneratedPdf(content=pdf, title=params.title, citations=landed, truncated=generated.truncated)

    report(95, JobProgressCreatingResource(code="creating-resource"))
    content = source.encode("utf-8")
    assert_within_output_budget(len(content))
    # The job's last report says it is done, and whether what it made is whole.
    report(100, JobProgressCompleteGenerated(code="complete-generated", truncated=generated.truncated))
    return GeneratedText(content=content, title=params.title, format=output_media_type, citations=citations, truncated=generated.truncated)


def _landed(source: str, citations: list[GenerationCitation], unmarked: bytes) -> tuple[bytes, list[PdfCitation]]:
    """The PDF to upload, and each citation with where the compiler says its claim ended.

    A PDF that cites nothing is the one that compiled. One that cites is
    compiled again with the end of each claim marked, and that compile is the
    PDF: the compiler's points are of its layout. Where the marked source
    does not compile, the marks broke it, and no citation can be placed: the
    PDF is the one that compiled without them, and none is made. A citation
    the compiler gives no point for is dropped. Each drop is said in the log.
    """
    if not citations:
        return unmarked, []
    landing = compile_typst_landing(source, [citation.end for citation in citations])
    if isinstance(landing, NotCompiled):
        LOG.warning(
            "PDF citations dropped \N{EM DASH} the source does not compile with each claim's end marked",
            extra={"citations": len(citations), "error": landing.error[:500]},
        )
        return unmarked, []
    placed: list[PdfCitation] = []
    for citation, landed in zip(citations, landing.landed, strict=True):
        if landed is None:
            LOG.warning(
                "PDF citation dropped \N{EM DASH} the compiler gave no point on its page for where the claim ended",
                extra={"citedResourceId": citation.resource_id, "exactPreview": citation.exact[:80]},
            )
            continue
        placed.append(
            PdfCitation(resource_id=citation.resource_id, annotation_id=citation.annotation_id, exact=citation.exact, landed=landed)
        )
    return landing.pdf, placed
