"""One held job, from the claim that handed it over to its settle.

The SDK's claiming is the worker's side of the queue: a held job says its own
lifecycle, commits its own annotations and settles once
(`docs/protocol/WORKER-CONTRACT.md`). This module is the work. It reads what
the job needs, runs the job through its processor
(`semiont_worker.processors`), commits what the processor hands over, and
says how the job went: completed, with its result; cancelled, with the units
it finished; or failed, with the failure's class and where the job stood.
`docs/protocol/WORKER-SERVICE.md` states each step.

A job's progress reports are sent without the job waiting for the gateway to
take each one, and all of them are sent before the job is settled: a held job
refuses a report once it has settled. A report the gateway does not take
fails nothing.
"""

import asyncio
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Final, Literal, assert_never, final

from pydantic import ValidationError
from semiont.annotations import TextSpan, annotation_of_resource, annotation_of_span
from semiont.claims import HeldJob, HeldMarkJob, HeldYieldJob
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.identifiers import ResourceId
from semiont.job_filter import job_matches_filter
from semiont.media_types import capabilities_of
from semiont.model import written
from semiont.resources import primary_media_type
from semiont.timing import GENERATED_TEXT_ASKS_COUNT
from semiont.transport import PutBinaryRequest, Transport
from semiont.types import (
    Agent,
    AnchoredText,
    AnchoredTextAbsent,
    Annotation,
    AssessingJobParams,
    CommentingJobParams,
    ExtractedText,
    ExtractionDeclined,
    HighlightingJobParams,
    JobDeclined,
    JobFilter,
    JobProgress,
    JobProgressCompleteGenerated,
    LinkingJobParams,
    MarkJobDone,
    SpecificResource,
    UnitCursor,
    YieldJobDone,
)
from semiont_inference.interface import InferenceClient

from semiont_worker import telemetry
from semiont_worker.detection.prepare_detection import DetectionDecline, DetectionSource, prepare_detection
from semiont_worker.failure_class import DeterministicJobError, classify_failure, words_of
from semiont_worker.generation.claim_search import find_landed_claim
from semiont_worker.held_params import HeldTagging, held_generation, held_mark, motivation_of
from semiont_worker.log import LOG
from semiont_worker.processors import (
    Cancelled,
    GeneratedArtifact,
    GeneratedText,
    UnitCheckpoint,
    process_assessment_job,
    process_comment_job,
    process_generation_job,
    process_highlight_job,
    process_reference_job,
    process_tag_job,
)

type Outcome = Literal["completed", "cancelled"]
"""How a job that did not fail ended. A job that was declined is one that completed."""


@final
class _Reports:
    """A job's progress reports, each sent without the job waiting for the gateway to take it."""

    def __init__(self, job: HeldJob) -> None:
        self._job: Final = job
        self._on_their_way: list[asyncio.Task[None]] = []

    def say(self, progress: JobProgress) -> None:
        """Send a report. It is on its way when this returns, and not yet taken."""
        self._on_their_way = [report for report in self._on_their_way if not report.done()]
        self._on_their_way.append(asyncio.ensure_future(self._send(progress)))

    async def _send(self, progress: JobProgress) -> None:
        # A job its worker's stopping has settled says nothing more.
        if self._job.settled:
            return
        try:
            await self._job.progress(progress)
        except SemiontError:
            # A report is no part of the work: one the gateway did not take fails nothing, and the transport tells of it.
            return

    async def taken(self) -> None:
        """Wait until every report made so far has been taken by the gateway, or could not be."""
        while self._on_their_way:
            # Those waited for are taken off first: what is left to wait for is what was said meanwhile.
            waited_for, self._on_their_way = self._on_their_way, []
            await asyncio.gather(*waited_for)

    async def dropped(self) -> None:
        """End the reports still on their way: the job is over, however it ended."""
        ended, self._on_their_way = self._on_their_way, []
        for report in ended:
            report.cancel()
        await asyncio.gather(*ended, return_exceptions=True)


@final
@dataclass(slots=True)
class _Stood:
    """Where a job stands, as this attempt has stated it: what its failure carries.

    Kept outside the work, because the failure is said where the work has
    already been left.
    """

    completed_units: list[str] = field(default_factory=list[str])
    """The units this attempt finished, in the order they finished."""
    unit_cursors: dict[str, UnitCursor] | None = None
    """The cursor of every unit the job has begun, once this attempt has stated them. Nothing until it has."""


def _what(job: HeldJob) -> str:
    """What a job is, as a claim names it, for a message."""
    if job.job_type == "yield":
        return job.job_type
    return f"mark ({motivation_of(job.params) or 'no motivation'})"


async def run_job(
    job: HeldJob,
    *,
    client: SemiontClient[Transport],
    inference: InferenceClient,
    generator: Agent,
    accepts: Sequence[JobFilter],
) -> None:
    """Do `job` and settle it: complete it, cancel it, or fail it with the failure's class and where the job stood.

    Whatever stops the work becomes the job's failure and is not raised. A
    job its worker's stopping has already settled is left as it is. This
    worker being cancelled is not the job's failure, and is raised.
    """
    LOG.info("Processing job", extra={"jobId": job.job_id, "type": job.job_type, "resourceId": job.resource_id})
    began = time.perf_counter()
    motivation = motivation_of(job.params) if job.job_type == "mark" else None
    reports = _Reports(job)
    stood = _Stood()
    noting = asyncio.ensure_future(_note_a_cancellation(job))
    outcome: telemetry.JobOutcome = "failed"
    try:
        # The job's own block: it runs in the trace of the claim that handed the job over, which the job's span continues.
        async with job:
            try:
                with telemetry.holding(job.job_type, motivation, job_id=job.job_id, resource_id=job.resource_id):
                    outcome = await _work(job, client, inference, generator, accepts, reports, stood)
            except Exception as failure:
                await _fail(job, failure, reports, stood)
    finally:
        noting.cancel()
        await asyncio.gather(noting, reports.dropped(), return_exceptions=True)
        telemetry.record_job_outcome(job.job_type, motivation, outcome, began)


async def _note_a_cancellation(job: HeldJob) -> None:
    """Say in the log that a cancellation has named the job. The work stops where it can: nothing is ended here."""
    async for cancelled in job.cancelled:
        if cancelled:
            LOG.info("Cancel requested for active job \N{EM DASH} stopping at its next stopping place", extra={"jobId": job.job_id})
            return


async def _fail(job: HeldJob, failure: Exception, reports: _Reports, stood: _Stood) -> None:
    """Say that the job failed: the error as text, its class where it has one, and the checkpoint this attempt stated."""
    # Classed here, while the failure is still what it is: on the wire it is text.
    failure_class = classify_failure(failure)
    LOG.error("Job failed", extra={"jobId": job.job_id, "error": words_of(failure), "failureClass": failure_class}, exc_info=failure)
    # A settle the gateway did not take has released the job already, and there is nothing more to say of it.
    if job.settled:
        return
    try:
        await reports.taken()
        await job.fail(
            words_of(failure),
            failure_class=failure_class,
            completed_units=stood.completed_units or None,
            unit_cursors=stood.unit_cursors or None,
        )
    except SemiontError as unsaid:
        # The failure itself could not be said. The job is released, and the dispatcher's sweep concludes it.
        LOG.error("Job failure could not be reported", extra={"jobId": job.job_id, "error": words_of(unsaid)})


async def _work(
    job: HeldJob,
    client: SemiontClient[Transport],
    inference: InferenceClient,
    generator: Agent,
    accepts: Sequence[JobFilter],
    reports: _Reports,
    stood: _Stood,
) -> Outcome:
    await job.start()
    held = {"jobType": job.job_type, "params": written(job.params)}
    if not any(job_matches_filter(written(accepted), held) for accepted in accepts):
        # The dispatcher hands out only what the claim accepts, so this is a job the two disagree about. No second
        # attempt changes the jobs this engine is claimed for.
        raise DeterministicJobError(f"Worker not configured for job: {_what(job)}")
    if isinstance(job, HeldMarkJob):
        return await _mark(job, client, inference, generator, reports, stood)
    return await _yield(job, client, inference, generator, reports)


# ── a mark job ──────────────────────────────────────────────────────────


async def _mark(
    job: HeldMarkJob, client: SemiontClient[Transport], inference: InferenceClient, generator: Agent, reports: _Reports, stood: _Stood
) -> Outcome:
    resource_id = job.resource_id
    what = _what(job)
    descriptor = await client.browse.resource(resource_id).fresh()
    media_type = primary_media_type(descriptor)
    with telemetry.preparing(resource_id=resource_id, media_type=media_type or "unknown"):
        source = await prepare_detection(
            media_type or "", client.browse.resource_content, resource_id, generator, client.browse.resource_anchored_text
        )

    if isinstance(source, DetectionDecline):
        match source.declined:
            case "not-yet":
                # The Smelter has not settled this resource's text. The work is not ready: the failure has no class,
                # so a later attempt may find it.
                raise RuntimeError(
                    f"Anchored text not yet derived for resource {resource_id} \N{EM DASH} Smelter has not settled; retrying"
                )
            case "no-extractor":
                # A media type with nothing to read is as unreadable on every attempt.
                raise DeterministicJobError(
                    f"Cannot run {what} on resource {resource_id}: "
                    f"media type '{media_type or 'unknown'}' has no extractable text to analyze"
                )
            case "no-map" | "unknown":
                raise DeterministicJobError(
                    f"Cannot run {what} on resource {resource_id}: anchored-text consult returned '{source.declined}'"
                )
            case "no-text-layer" | "encrypted" | "corrupt" | "too-large" | "empty":
                # The resource has nothing to read. Nothing went wrong: the job completes, and says why it did no work.
                await job.complete(JobDeclined(declined=True, reason=source.declined))
                return "completed"
            case _:
                assert_never(source.declined)

    description = held_mark(job.params)
    if description is None:
        # A job this engine was handed and cannot run: a tagging job without the schema its `schemaId` names. A
        # second attempt would be handed the same job.
        raise DeterministicJobError(f"No processor for job: {what}")

    ended = await _detect(job, description, source, inference, reports, stood)
    await reports.taken()
    if isinstance(ended, Cancelled):
        # Stopped for a cancellation: the job is said to be cancelled, with the units it did finish.
        await job.cancel(ended.completed_units or None)
        return "cancelled"
    await job.complete(ended)
    return "completed"


async def _detect(
    job: HeldMarkJob,
    description: HighlightingJobParams | CommentingJobParams | AssessingJobParams | LinkingJobParams | HeldTagging,
    source: DetectionSource,
    inference: InferenceClient,
    reports: _Reports,
    stood: _Stood,
) -> MarkJobDone | Cancelled:
    """Run a detection through the processor of its motivation, committing each piece and saying where that leaves the job."""
    # The cursor of every unit the job has begun: each as the job was claimed with it, until this attempt commits a
    # piece of that unit. A finished unit keeps its cursor, where it ended.
    unit_cursors = dict(job.unit_cursors)

    async def commit_chunk(annotations: list[Annotation], checkpoint: UnitCheckpoint) -> None:
        """Commit a piece's annotations, then record where that leaves its unit: one step, so a cursor never leads the record."""
        await job.commit(job.resource_id, annotations)
        unit_cursors[checkpoint.unit] = checkpoint.cursor
        stood.unit_cursors = dict(unit_cursors)
        await job.checkpoint(list(stood.completed_units), dict(unit_cursors))

    async def unit_complete(unit: str) -> None:
        """Say that an entity type is finished. Every piece of it is committed by now, and it keeps its cursor."""
        stood.completed_units.append(unit)
        stood.unit_cursors = dict(unit_cursors)
        await job.checkpoint(list(stood.completed_units), dict(unit_cursors) or None)

    match description:
        case HighlightingJobParams():
            return await process_highlight_job(
                source.text,
                inference,
                description,
                build_annotation=source.build_annotation,
                on_progress=reports.say,
                cancelled=job.cancelled,
                on_chunk_complete=commit_chunk,
                resume_cursors=job.unit_cursors,
            )
        case CommentingJobParams():
            return await process_comment_job(
                source.text,
                inference,
                description,
                build_annotation=source.build_annotation,
                on_progress=reports.say,
                cancelled=job.cancelled,
                on_chunk_complete=commit_chunk,
                resume_cursors=job.unit_cursors,
            )
        case AssessingJobParams():
            return await process_assessment_job(
                source.text,
                inference,
                description,
                build_annotation=source.build_annotation,
                on_progress=reports.say,
                cancelled=job.cancelled,
                on_chunk_complete=commit_chunk,
                resume_cursors=job.unit_cursors,
            )
        case LinkingJobParams():
            return await process_reference_job(
                source.text,
                inference,
                description,
                build_annotation=source.build_annotation,
                on_progress=reports.say,
                cancelled=job.cancelled,
                on_unit_complete=unit_complete,
                on_chunk_complete=commit_chunk,
                resume_cursors=job.unit_cursors,
                completed_units=job.completed_units,
            )
        case HeldTagging():
            return await process_tag_job(
                source.text,
                inference,
                description.params,
                description.schema,
                build_annotation=source.build_annotation,
                on_progress=reports.say,
                cancelled=job.cancelled,
                on_chunk_complete=commit_chunk,
                resume_cursors=job.unit_cursors,
            )
        case _:
            assert_never(description)


# ── a yield job ─────────────────────────────────────────────────────────


async def _yield(
    job: HeldYieldJob, client: SemiontClient[Transport], inference: InferenceClient, generator: Agent, reports: _Reports
) -> Outcome:
    try:
        params = held_generation(job.params)
    except ValidationError as refused:
        # The params crossed the wire as JSON: a job that is no generation's fails here, and not partway through one.
        lacking = "; ".join(f"{'.'.join(map(str, refusal['loc']))}: {refusal['msg']}" for refusal in refused.errors())
        raise RuntimeError(f"generation job {job.job_id}: params do not satisfy GenerationJobParams ({lacking})") from None

    made = await process_generation_job(inference, params, on_progress=reports.say, cancelled=job.cancelled)
    if isinstance(made, Cancelled):
        # Cancelled by the time its model had answered: nothing is uploaded and nothing committed.
        await reports.taken()
        await job.cancel()
        return "cancelled"

    # Where the artifact is stored is the job's to say, and is used as given. A location whose extension is not the
    # format's is written all the same: whoever asked for the job chose both.
    row = capabilities_of(made.format)
    if row is not None and not params.storage_uri.lower().endswith(row.extension):
        LOG.warning(
            "Storage URI extension does not match the generated format \N{EM DASH} writing it as requested",
            extra={"jobId": job.job_id, "storageUri": params.storage_uri, "format": made.format, "expectedExtension": row.extension},
        )

    # The artifact never travels on the bus: it is uploaded, and the upload's answer is the new resource's id. A job
    # focused on an annotation is bound to it by the upload itself.
    created = await client.yield_.resource(
        PutBinaryRequest(
            name=made.title,
            file=made.content,
            format=made.format,
            storage_uri=params.storage_uri,
            source_resource_id=job.resource_id,
            source_annotation_id=job.annotation_id,
            generation_prompt=params.prompt,
            language=params.language,
            entity_types=params.entity_types or (),
            generator=generator,
            job_id=job.job_id,
        )
    )
    new_resource_id = created.resource_id

    if job.annotation_id is None:
        # Focused on a resource: an annotation of the source as a whole links it to what was made from it. Its id is
        # what it is, so a retried job that makes the same link commits it under the same id.
        link = annotation_of_resource(
            job.resource_id,
            motivation="linking",
            generator=generator,
            body=SpecificResource(type="SpecificResource", source=new_resource_id, purpose="linking"),
        )
        await job.commit(job.resource_id, [link])

    # The citations are on the new resource, and are one batch.
    await job.commit(new_resource_id, await _citations(job, client, made, new_resource_id, generator, reports))

    await reports.taken()
    await job.complete(YieldJobDone(resource_id=new_resource_id, resource_name=made.title, truncated=made.truncated))
    return "completed"


async def _citations(
    job: HeldYieldJob,
    client: SemiontClient[Transport],
    made: GeneratedArtifact,
    new_resource_id: ResourceId,
    generator: Agent,
    reports: _Reports,
) -> list[Annotation]:
    """Each claim the artifact cites, as a linking annotation on the new resource: the claim is its target, and the cited resource its body.

    A text is anchored by offsets into the text as decoded. A PDF is anchored
    by where its words are on a page, so each claim is found again in the
    PDF's own text, which is the Smelter's, at the place the compiler says it
    ended. A claim that is at no place there is dropped, and said in the log,
    and so is every claim of a PDF whose text is not to be had: a citation is
    never made in the wrong place.
    """
    if not made.citations:
        return []

    def citing(cited: ResourceId) -> SpecificResource:
        return SpecificResource(type="SpecificResource", source=cited, purpose="linking")

    if isinstance(made, GeneratedText):
        text = made.content.decode("utf-8")
        return [
            annotation_of_span(
                text,
                TextSpan(start=citation.start, end=citation.end, exact=citation.exact),
                resource_id=new_resource_id,
                motivation="linking",
                generator=generator,
                body=citing(citation.resource_id),
            )
            for citation in made.citations
        ]

    def waiting() -> None:
        # What the job last said, said again: the wait is not a stage of its own, and a long silence reads as a stall.
        reports.say(JobProgress(percentage=100, message=JobProgressCompleteGenerated(code="complete-generated", truncated=made.truncated)))

    anchored = await _generated_pdf_text(client, new_resource_id, waiting)
    if isinstance(anchored, str):
        LOG.warning(
            "PDF citations dropped \N{EM DASH} the generated artifact's text is not to be had",
            extra={"jobId": job.job_id, "resourceId": new_resource_id, "citations": len(made.citations), "reason": anchored},
        )
        return []
    citations: list[Annotation] = []
    for citation in made.citations:
        found = find_landed_claim(anchored, citation.exact, citation.landed)
        if found is None:
            LOG.warning(
                "PDF citation dropped \N{EM DASH} the claim is not in the rendered text where the compiler says it ended",
                extra={
                    "jobId": job.job_id,
                    "resourceId": new_resource_id,
                    "citedResourceId": citation.resource_id,
                    "exactPreview": citation.exact[:80],
                    "landedPage": citation.landed.page,
                },
            )
            continue
        start, end = found
        # The quote is the text under the span as the PDF has it, and not the claim as the source wrote it: a word
        # broken at a line's end has lost its hyphen.
        citations.append(
            annotation_of_span(
                anchored,
                TextSpan(start=start, end=end, exact=anchored.text[start:end]),
                resource_id=new_resource_id,
                motivation="linking",
                generator=generator,
                body=citing(citation.resource_id),
            )
        )
    return citations


async def _generated_pdf_text(client: SemiontClient[Transport], resource_id: ResourceId, waiting: Callable[[], None]) -> AnchoredText | str:
    """The text of a PDF this job has just made, with where each run of it is on its pages, or why it is not to be had.

    It is the Smelter's text, asked for as a detection asks for a PDF's. It
    is not there the moment the resource is: an ask is answered at once when
    the text is stored, and is otherwise held until the Smelter has settled
    the resource, and then answered `not-yet`. So `not-yet` is asked again,
    as many times as the timing table states, and `waiting` is called before
    each further ask.

    Why it is not to be had is answered and never raised. The resource exists
    by now, and a failed job is retried, which would make it a second time.
    """
    for ask in range(GENERATED_TEXT_ASKS_COUNT):
        if ask > 0:
            waiting()
        answer = await client.browse.resource_anchored_text(resource_id)
        match answer:
            case ExtractedText():
                return answer
            case ExtractionDeclined():
                return answer.declined
            case AnchoredTextAbsent():
                if answer.kind != "not-yet":
                    return answer.kind
            case _:
                assert_never(answer)
    return "not-yet"
