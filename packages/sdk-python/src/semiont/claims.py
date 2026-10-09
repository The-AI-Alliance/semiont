"""A worker's side of the job queue: `job.claim`.

A worker is any party that takes jobs and says how each one went. What it
promises the dispatcher, and everyone who follows a job, is
docs/protocol/WORKER-CONTRACT.md; this module is that contract for Python,
and the worker conformance suite (tests/conformance/worker) holds it on the
wire.

THE MODEL. A worker asks the queue at every moment it becomes idle, and never
otherwise. `job:claim` carries the jobs it takes; the dispatcher answers with
the next pending job that matches one of them, or declines. Queue state is
the truth, and no message carries correctness. The idle moments:

- its claims are first read, once the stream is open;
- it settles the job it holds, immediately, with no timer;
- a matching `job:queued` arrives while it holds nothing;
- the stream opens again: every change to `open` after the first.

`job:queued` is a WAKE-UP with no memory. While the worker holds nothing it
causes a claim; while a claim is in flight it sets a bit that earns exactly
one more claim, so a wake-up cannot be lost in that window; while a job is
held it is ignored, because the settle claims. The check of a wake-up is a
PRE-FILTER: an announcement carries the job description less its input, so
the worker asks its own claim's question of it, `job_matches_filter`, the
comparison the dispatcher makes, and does not spend a round trip to be
declined.

A HELD JOB owns its lifecycle. It says its own start, progress and
checkpoints, and it settles once: `complete`, `fail` and `cancel` each say
the outcome and release the job in one call, and a second is refused.

A HELD JOB COMMITS FOR ITSELF. `commit` sends a batch of annotations to the
record, citing the job, and returns once the batch is established: the record
acknowledged it, or, when no acknowledgement came, answered that the batch's
last annotation is on the resource. The job remembers the weakest of what its
commits observed and states it when it settles, so a worker says neither
which job a batch is for nor how its commits went.

EACH JOB HAS A TRACE OF ITS OWN (WORKER-CONTRACT T1). A claim is made in no
trace, whatever span is current where the idle moment came: the settle of the
job before it runs inside that job's span, and a claim made there would be in
that job's trace. A held job states the trace its reply arrived in (`trace`),
which is the claim's own once the dispatcher has answered in it: a worker
opens its span for the job in that trace, so the span, and every message the
job sends from inside it, continue the trace that began with the claim.

    async with client.job.claim(accepts) as claims:
        async for handed in claims:
            if isinstance(handed, ClaimRefusal):
                continue  # the host judges: `bus.unauthorized` means stop
            async with handed as job:
                await job.start()
                ...
                await job.complete(result)

Held with `async with`, the claims are stopped on the way out, and a job
still held then is failed first. A held job held with `async with` is failed
on the way out if nothing settled it. Python tells nobody when a value is let
go of, so a job that is neither settled nor held that way stays with the
dispatcher until its worker stops.
"""

import asyncio
from collections.abc import Callable, Coroutine, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from types import TracebackType
from typing import Final, Literal, Self, assert_never, final

from pydantic import JsonValue, TypeAdapter

from semiont import telemetry
from semiont.bus import Bus, answer_of, reply_channels_for, request
from semiont.channel import Operation
from semiont.channels import (
    JOB_CANCEL,
    JOB_CANCEL_REQUESTED,
    JOB_CHECKPOINT,
    JOB_COMPLETE,
    JOB_FAIL,
    JOB_QUEUED,
    JOB_REPORT_PROGRESS,
    JOB_START,
)
from semiont.error_codes import BusRequestErrorCode
from semiont.errors import BusRequestError, SemiontError
from semiont.events import Events
from semiont.identifiers import AnnotationId, InvalidIdentifier, JobId, ResourceId
from semiont.job_filter import job_matches_filter
from semiont.model import WireModel, written
from semiont.operations import BROWSE_ANNOTATION_REQUESTED, JOB_CLAIM, MARK_COMMIT
from semiont.timing import HELD_JOB_STALL_CHECK_MS, HELD_JOB_STALL_MS, JOB_CLAIM_TIMEOUT_MS, MARK_COMMIT_TIMEOUT_MS
from semiont.transport import Frame, TraceContext
from semiont.types import (
    Annotation,
    BrowseAnnotationRequest,
    DurabilityEvidence,
    FailureClass,
    JobCancelCommand,
    JobCheckpointCommand,
    JobClaimCommand,
    JobFailCommand,
    JobFilter,
    JobParams,
    JobProgress,
    JobReportProgressCommand,
    JobRunning,
    JobStartCommand,
    JobType,
    MarkCommitCommand,
    MarkJobCompleteCommand,
    MarkJobResult,
    UnitCursor,
    YieldJobCompleteCommand,
    YieldJobResult,
)
from semiont.watched import Variable, Watched

__all__ = [
    "JOB_CLAIM_CHANNELS",
    "JOB_COMMIT_CHANNELS",
    "ActiveJob",
    "ClaimRefusal",
    "Claims",
    "HeldJob",
    "HeldJobStall",
    "HeldMarkJob",
    "HeldYieldJob",
    "WorkerVitals",
    "will_retry_after",
]

JOB_CLAIM_CHANNELS: Final[tuple[str, ...]] = (*reply_channels_for(JOB_CLAIM), JOB_QUEUED.name, JOB_CANCEL_REQUESTED.name)
"""What a worker's stream names for its claims: the replies of `job:claim`, and the two broadcasts a worker reads.

`job:queued` and `job:cancel-requested` reach only a stream that names them,
so a transport made for a worker is given these beside the reply channels of
whatever else the worker awaits.
"""

JOB_COMMIT_CHANNELS: Final[tuple[str, ...]] = reply_channels_for(MARK_COMMIT, BROWSE_ANNOTATION_REQUESTED)
"""What a worker's stream names for its commits: the replies of `mark:commit`, and of the question it asks when one goes unacknowledged.

The question is the read of ONE annotation, and not of a resource's list of
them. Reply channels reach every stream that names them, and the list's
replies are the frames of many megabytes a worker's stream exists to keep
out; one annotation's frame is small.
"""

_STOPPED_WHILE_HELD: Final = "The worker stopped while it held the job"
"""The error of a job failed because its worker stopped, and not because the work failed."""
_LET_GO_UNSETTLED: Final = "The worker let go of the job without settling it"
"""The error of a job that was left without being settled."""

_FILTER: Final = TypeAdapter[JobFilter](JobFilter)


def will_retry_after(retry_count: int, max_retries: int, failure_class: FailureClass | None = None) -> bool:
    """Whether a failed attempt is retried.

    Exactly when the failure is not known to be deterministic and the job has
    retries left, on the record before the failure is applied. Two places need
    the answer and they must never disagree: the dispatcher's queue acts on
    it, and a worker reports it on `job:fail` as `willRetry`, so a follower of
    the job knows whether the failure it just saw is the end. Each language
    has one implementation, and specs/src/jobs/retry-cases.json is the table
    all of them answer alike.
    """
    return failure_class != "deterministic" and retry_count < max_retries


def _weakness(evidence: DurabilityEvidence) -> int:
    """How weak an observation of a commit is, as evidence that the batch is on the record.

    The two a commit is not established by are equally weak: one says the
    record answered that the annotation is not there, the other that nobody
    answered, and neither says more than the other.
    """
    match evidence:
        case "acknowledged":
            return 0
        case "probe-confirmed":
            return 1
        case "probe-refused" | "probe-unreachable":
            return 2
        case _:
            assert_never(evidence)


@final
@dataclass(frozen=True, slots=True)
class ClaimRefusal:
    """A claim that was refused for a reason other than "nothing pending".

    `code` is the code the reply was given, or `None` when the refusal was the
    worker's own: a reply that names no job, or a claim that could not be
    sent. `bus.none-pending` never appears: an empty queue is not a fault.
    `bus.unauthorized` means this credential cannot claim, and will not be
    able to later.
    """

    code: BusRequestErrorCode | None
    message: str


@final
@dataclass(frozen=True, slots=True)
class ActiveJob:
    """The job a worker holds, as its vitals name it."""

    job_id: JobId
    job_type: JobType
    since: datetime


@final
@dataclass(frozen=True, slots=True)
class WorkerVitals:
    """What a worker can say of itself at any moment (WORKER-CONTRACT V1).

    `last_queued_event_at` is any `job:queued` received, matching or not. On
    an idle stack with an empty queue it stands still by design, so a still
    stamp alone is not a fault of the stream. `last_activity_at` (a claim, a
    progress report, a checkpoint, a settle) is the liveness of the work: a
    job stuck partway stops advancing it, and that is what the stall rule
    reads.
    """

    last_queued_event_at: datetime | None
    last_claim_at: datetime | None
    last_finished_at: datetime | None
    """The last settle, whatever its outcome: a worker that fails and moves on is alive."""
    last_activity_at: datetime | None
    active_job: ActiveJob | None
    jobs_completed: int


@final
@dataclass(frozen=True, slots=True)
class HeldJobStall:
    """A held job that showed no activity for `threshold_ms` (WORKER-CONTRACT V2). What its host does then is the host's."""

    job_id: JobId
    job_type: JobType
    held_since: datetime
    last_activity_at: datetime
    silent_for_ms: int
    threshold_ms: int


def _anchor_of(job_type: JobType, params: Mapping[str, JsonValue]) -> AnnotationId | None:
    """The annotation a job is anchored to: the one a `yield` job's context is focused on.

    A `yield` job focused on a resource has none, and neither has a `mark` job.
    """
    if job_type != "yield":
        return None
    context = params.get("context")
    focus = context.get("focus") if isinstance(context, Mapping) else None
    if not isinstance(focus, Mapping) or focus.get("kind") != "annotation":
        return None
    annotation = focus.get("annotation")
    named = annotation.get("id") if isinstance(annotation, Mapping) else None
    if not isinstance(named, str):
        return None
    try:
        return AnnotationId.parse(named)
    except InvalidIdentifier:
        return None


@final
@dataclass(frozen=True, slots=True)
class _Holder:
    """What a held job asks of the claiming that handed it out."""

    wire: Bus
    mark_commit_timeout_ms: int
    """How long each of a commit's requests waits to be answered."""
    active: Callable[[], None]
    """The work showed it is alive."""
    released: Callable[["_Held", bool], None]
    """The job is settled, and no longer held: whether it was completed."""


class _Held:
    """What a held job is, whatever its verb."""

    def __init__(self, holder: _Holder, claimed: JobRunning, cancelled: Variable[bool], trace: TraceContext | None) -> None:
        metadata, params = claimed.metadata, claimed.params
        self._holder: Final = holder
        self.trace: Final = trace
        """The trace the job is run in: the one its reply arrived in. Nothing for a reply that arrived in none."""
        self.job_id: Final = metadata.id
        self.resource_id: Final[ResourceId] = params.resource_id
        self.params: Final[JobParams] = params
        """The job's parameters as the dispatcher holds them: the description, and what the dispatcher adds."""
        # Both appear on the record once an attempt has checkpointed. Absent, each reads as none.
        self.completed_units: Final[Sequence[str]] = tuple(metadata.completed_units or ())
        """The units earlier attempts finished. A worker does not do them again. Empty on a first attempt."""
        self.unit_cursors: Final[Mapping[str, UnitCursor]] = dict(metadata.unit_cursors or {})
        """How far each unit begun and not finished got on an earlier attempt. Empty on a first attempt."""
        self.retry_count: Final = metadata.retry_count
        self.max_retries: Final = metadata.max_retries
        self.attempt: Final = metadata.retry_count + 1
        """Which attempt this is, 1-based. Every lifecycle message states it."""
        self.annotation_id: Final = _anchor_of(metadata.type, written(params))
        """The annotation the job is anchored to: the one a `yield` job's context is focused on."""
        self._type: Final[JobType] = metadata.type
        self._cancelled: Final = cancelled
        self._begun = False
        self._settled = False
        self._durability: DurabilityEvidence | None = None
        """The weakest of what this job's commits observed, across every batch and every resource it committed on.

        The strongest thing still true of the job as a whole. None until a
        batch is committed, and never a default: a job that commits nothing
        states nothing.
        """

    @property
    def cancelled(self) -> Watched[bool]:
        """Whether a cancellation has named this job: the answer now, and the change to it.

        The work stops where it can, and the worker says `cancel`.
        """
        return self._cancelled

    @property
    def settled(self) -> bool:
        """Whether the job has been settled: completed, failed or cancelled."""
        return self._settled

    def _unsettled(self, saying: str) -> None:
        if self._settled:
            raise RuntimeError(f"Job {self.job_id} is already settled: it cannot say {saying}")

    async def start(self) -> None:
        """`job:start`: the job's first message, said once."""
        self._unsettled(JOB_START.name)
        if self._begun:
            raise RuntimeError(f"job:start is a held job's first message, said once: job {self.job_id} has already said more")
        self._begun = True
        await self._holder.wire.emit(
            JOB_START,
            JobStartCommand(
                resource_id=self.resource_id,
                job_id=self.job_id,
                job_type=self._type,
                attempt=self.attempt,
                annotation_id=self.annotation_id,
            ),
        )

    async def progress(self, progress: JobProgress) -> None:
        """`job:report-progress`. Counts as activity."""
        self._unsettled(JOB_REPORT_PROGRESS.name)
        self._begun = True
        self._holder.active()
        said = progress if self.annotation_id is None else progress.model_copy(update={"annotation_id": self.annotation_id})
        await self._holder.wire.emit(
            JOB_REPORT_PROGRESS,
            JobReportProgressCommand(
                resource_id=self.resource_id,
                job_id=self.job_id,
                job_type=self._type,
                attempt=self.attempt,
                annotation_id=self.annotation_id,
                percentage=progress.percentage,
                progress=said,
            ),
        )

    async def checkpoint(self, completed_units: Sequence[str], unit_cursors: Mapping[str, UnitCursor] | None = None) -> None:
        """`job:checkpoint`: what a later attempt resumes from. Counts as activity.

        The units finished, and how far each unit begun and not finished got.
        """
        self._unsettled(JOB_CHECKPOINT.name)
        self._begun = True
        self._holder.active()
        await self._holder.wire.emit(
            JOB_CHECKPOINT,
            JobCheckpointCommand(
                job_id=self.job_id, completed_units=list(completed_units), unit_cursors=None if unit_cursors is None else dict(unit_cursors)
            ),
        )

    async def commit(self, resource_id: ResourceId, annotations: Sequence[Annotation]) -> None:
        """`mark:commit` for this job: returns once the batch is established.

        It sends the batch to the record and WAITS for the record to say it
        has it. The gateway taking the message says nothing of the record: a
        record that is down discards a batch the gateway accepted, and a job
        that counted the batch as done would report work that never landed.

        A commit the record does not acknowledge in time is not thereby lost.
        If the gateway goes down after the record appended the batch, the
        acknowledgement cannot be routed, and a job failed on that would be
        failed over annotations that are on the record. So the outcome
        follows what the record holds, and not the arrival of a message: the
        record is asked. A batch is never sent a second time to find out.
        That would double the work, and where the acknowledgement was lost
        because the gateway is down, the second commit would only time out as
        the first did.

        A commit that was not established raises what its unanswered request
        raised: that request's own failure. What was observed leaves by the
        job's settle, the one place it can still be told.
        """
        self._unsettled(MARK_COMMIT.request.name)
        if not annotations:
            # A batch of no annotations is no commit: there is nothing to establish.
            return
        try:
            await self._answered(MARK_COMMIT, MarkCommitCommand(resource_id=resource_id, annotations=list(annotations), job_id=self.job_id))
        except BusRequestError as unanswered:
            # The record's refusal, and every other failure of the request, is
            # the commit's failure as it is. Only an acknowledgement that did
            # not arrive leaves what the record holds unknown.
            if unanswered.code != "bus.timeout":
                raise
            observed = await self._ask_whether_recorded(resource_id, annotations[-1].id)
            self._observe(observed)
            if observed != "probe-confirmed":
                raise
            return
        self._observe("acknowledged")

    async def _ask_whether_recorded(self, resource_id: ResourceId, annotation_id: AnnotationId) -> DurabilityEvidence:
        """What asking whether the annotation is on the resource observes.

        Asked of the LAST annotation of a batch nobody acknowledged, and that
        is enough: the record appends a batch in order and stops at the first
        annotation it cannot append (WORKER-CONTRACT A5), so the last being
        there says every one before it is. One question, where asking of each
        would be a round trip for each annotation.

        Every answer but the annotation fails the commit, and the asymmetry
        is deliberate. The record appends only the annotations it does not
        hold, so a job retried over a batch that had landed costs one more
        run of the batch's unit; a wrong "it is there" loses the batch
        silently, which is what the acknowledgement exists to prevent. A
        question nobody answered is neither yes nor no. It is said as its own
        observation, and it does not establish the commit.
        """
        try:
            await self._answered(BROWSE_ANNOTATION_REQUESTED, BrowseAnnotationRequest(resource_id=resource_id, annotation_id=annotation_id))
        except SemiontError as unconfirmed:
            # A failure reply (`bus.rejected`) means the question was answered
            # and the answer was not the annotation. That is not "the
            # annotation is absent": a read that failed for its own reasons
            # answers on the same channel. So the job says what was observed,
            # and its reader judges. Anything else (`bus.timeout`,
            # `bus.closed`) means nobody answered.
            return "probe-refused" if unconfirmed.code == "bus.rejected" else "probe-unreachable"
        return "probe-confirmed"

    async def _answered[Q: WireModel, R: WireModel, F: WireModel](self, operation: Operation[Q, R, F], payload: Q) -> None:
        """One of a commit's requests, awaited for the commit's wait: it returns once it is answered, and raises as a bus request does.

        What it is answered with is not read. That the record answered is
        what establishes a commit, so an acknowledgement, or an answer to the
        question, that this SDK cannot type is the answer it is all the same.
        """
        await request(
            self._holder.wire.transport,
            operation,
            operation.request.encode(payload),
            timeout_ms=self._holder.mark_commit_timeout_ms,
        )

    def _observe(self, evidence: DurabilityEvidence) -> None:
        """Remember `evidence` if it is weaker than what is remembered. Of two equally weak, the first seen is kept."""
        if self._durability is None or _weakness(evidence) > _weakness(self._durability):
            self._durability = evidence

    async def fail(
        self,
        error: str,
        *,
        failure_class: FailureClass | None = None,
        completed_units: Sequence[str] | None = None,
        unit_cursors: Mapping[str, UnitCursor] | None = None,
    ) -> None:
        """Settle: `job:fail`.

        It says whether the queue will retry, from the record's budget and
        the failure's class, and what a commit that was not established
        observed. `failure_class` is the failure's class, when the worker
        knows it; `completed_units` and `unit_cursors` the checkpoint, when
        there is one.
        """
        self._settling(JOB_FAIL.name)
        # Stated only when a commit was not established: what is weaker than
        # any observation that establishes one. Otherwise the failure says
        # nothing of the job's commits.
        observed = self._durability
        not_established = observed is not None and _weakness(observed) > _weakness("probe-confirmed")
        failed = JobFailCommand(
            resource_id=self.resource_id,
            job_id=self.job_id,
            job_type=self._type,
            attempt=self.attempt,
            annotation_id=self.annotation_id,
            error=error,
            completed_units=None if completed_units is None else list(completed_units),
            unit_cursors=None if unit_cursors is None else dict(unit_cursors),
            failure_class=failure_class,
            will_retry=will_retry_after(self.retry_count, self.max_retries, failure_class),
            durability=observed if not_established else None,
        )
        try:
            await self._holder.wire.emit(JOB_FAIL, failed)
        finally:
            self._holder.released(self, False)

    async def cancel(self, completed_units: Sequence[str] | None = None, unit_cursors: Mapping[str, UnitCursor] | None = None) -> None:
        """Settle: `job:cancel`, once the work has stopped for a cancellation.

        With the units it finished, and how far the others got. The message
        is the command's own fields and no more: it names no attempt.
        """
        self._settling(JOB_CANCEL.name)
        cancelled = JobCancelCommand(
            resource_id=self.resource_id,
            job_id=self.job_id,
            job_type=self._type,
            annotation_id=self.annotation_id,
            completed_units=None if completed_units is None else list(completed_units),
            unit_cursors=None if unit_cursors is None else dict(unit_cursors),
        )
        try:
            await self._holder.wire.emit(JOB_CANCEL, cancelled)
        finally:
            self._holder.released(self, False)

    def _settling(self, saying: str) -> None:
        """The job is settled from the moment it is asked to be, so a second settle is refused while the first is on its way."""
        self._unsettled(saying)
        self._settled = True

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        # Left without being settled: nobody will settle it now.
        await _fail_for(self, _LET_GO_UNSETTLED)


async def _fail_for(job: _Held, reason: str) -> None:
    """Fail `job` for a reason that is not the work's, unless it is settled already.

    The failure states no class, so the record's retry budget decides what
    becomes of the job. One that cannot be said is not said: the job is
    released, and the dispatcher's sweep concludes it.
    """
    if job.settled:
        return
    try:
        await job.fail(reason)
    except SemiontError:
        return


@final
class HeldMarkJob(_Held):
    """A `mark` job this worker holds, from its claim until it settles it.

    Each settle says the outcome and releases the job together; a second is
    refused. A settle the gateway did not take still releases the job, and
    raises.
    """

    job_type: Final[Literal["mark"]] = "mark"

    async def complete(self, result: MarkJobResult) -> None:
        """Settle: `job:complete`, with what a `mark` job reports, and how its commits were established."""
        self._settling(JOB_COMPLETE.name)
        completed = MarkJobCompleteCommand(
            resource_id=self.resource_id,
            job_id=self.job_id,
            job_type="mark",
            attempt=self.attempt,
            result=result,
            durability=self._durability,
        )
        try:
            await self._holder.wire.emit(JOB_COMPLETE, completed)
        finally:
            self._holder.released(self, True)


@final
class HeldYieldJob(_Held):
    """A `yield` job this worker holds, from its claim until it settles it.

    Each settle says the outcome and releases the job together; a second is
    refused. A settle the gateway did not take still releases the job, and
    raises.
    """

    job_type: Final[Literal["yield"]] = "yield"

    async def complete(self, result: YieldJobResult) -> None:
        """Settle: `job:complete`, with what a `yield` job reports, and how its commits were established."""
        self._settling(JOB_COMPLETE.name)
        completed = YieldJobCompleteCommand(
            resource_id=self.resource_id,
            job_id=self.job_id,
            job_type="yield",
            attempt=self.attempt,
            annotation_id=self.annotation_id,
            result=result,
            durability=self._durability,
        )
        try:
            await self._holder.wire.emit(JOB_COMPLETE, completed)
        finally:
            self._holder.released(self, True)


type HeldJob = HeldMarkJob | HeldYieldJob
"""A job this worker holds, as its verb's: a completion is its verb's, so `job_type` is read before `complete` is called."""


@final
class _Ended:
    """The claiming has ended: nothing more is handed out."""


_ENDED: Final = _Ended()


@final
class Claims:
    """A worker's claims, from `job.claim`: each job the worker comes to hold, one at a time, and each claim it was refused.

    Iterated (`async for`). The next job is claimed when the one held is
    settled, and a refusal does not end the iteration: the worker waits for
    its next idle moment, and what the refusal means is its host's to judge.
    Claiming begins when the claims are first read. It ends when `aclose` is
    called, which leaving `async with` does, or when the transport's stream
    ends; a job still held when it is stopped is failed first.
    """

    def __init__(
        self,
        wire: Bus,
        run: Callable[[Coroutine[object, object, None]], asyncio.Task[None]],
        accepts: Sequence[JobFilter],
        *,
        job_claim_timeout_ms: int = JOB_CLAIM_TIMEOUT_MS,
        held_job_stall_ms: int = HELD_JOB_STALL_MS,
        held_job_stall_check_ms: int = HELD_JOB_STALL_CHECK_MS,
        mark_commit_timeout_ms: int = MARK_COMMIT_TIMEOUT_MS,
    ) -> None:
        self._wire: Final = wire
        self._spawn: Final = run
        """Runs a task as the client's: one that has ended by the time the client has closed."""
        self._accepts: Final = tuple(accepts)
        self._filters: Final = tuple(_FILTER.dump_python(accepted, mode="json", by_alias=True, exclude_none=True) for accepted in accepts)
        """Each filter as the wire carries it, which is what an announcement is compared with."""
        self._job_claim_timeout_ms: Final = job_claim_timeout_ms
        self._held_job_stall_ms: Final = held_job_stall_ms
        self._held_job_stall_check_ms: Final = held_job_stall_check_ms
        self._holder: Final = _Holder(
            wire=wire, mark_commit_timeout_ms=mark_commit_timeout_ms, active=self._active, released=self._released
        )
        self._handed: Final[asyncio.Queue[HeldJob | ClaimRefusal | _Ended]] = asyncio.Queue()
        self._tasks: Final[set[asyncio.Task[None]]] = set()
        self._claim_in_flight: asyncio.Task[None] | None = None
        self._listening: Final[list[Events[Frame]]] = []
        self._stall: Final = Variable[HeldJobStall | None](None)
        self._begun = False
        self._stopped = False
        self._held: HeldJob | None = None
        self._cancelling: Variable[bool] | None = None
        """What tells the held job that a cancellation named it."""
        self._stall_reported = False
        # The loop's two bits: one claim in flight at a time, and a wake-up that
        # arrived during it, honoured with exactly one more claim.
        self._claiming = False
        self._wake_pending = False
        self._last_queued_event_at: datetime | None = None
        self._last_claim_at: datetime | None = None
        self._last_finished_at: datetime | None = None
        self._last_activity_at: datetime | None = None
        self._active_at: float | None = None
        """When the work was last active, by the loop's clock, which a silence is measured on."""
        self._held_since: datetime | None = None
        self._jobs_completed = 0

    # ── What a held job asks ────────────────────────────────────

    def _active(self) -> None:
        """The work showed it is alive."""
        self._last_activity_at = datetime.now(UTC)
        self._active_at = asyncio.get_running_loop().time()

    def _released(self, job: _Held, completed: bool) -> None:
        """`job` is settled, and no longer held."""
        if self._held is not job:
            return
        self._active()
        self._last_finished_at = self._last_activity_at
        self._held = None
        if self._cancelling is not None:
            # Settled: no cancellation will be signalled to it now, and whoever watches for one is told so.
            self._cancelling.end()
        self._cancelling = None
        self._held_since = None
        if completed:
            self._jobs_completed += 1
        self._pull()

    # ── The loop ────────────────────────────────────────────────

    def _run(self, work: Coroutine[object, object, None]) -> asyncio.Task[None]:
        task = self._spawn(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _begin(self) -> None:
        transport = self._wire.transport
        unnamed = [channel for channel in JOB_CLAIM_CHANNELS if not transport.is_subscribed(channel)]
        if unnamed:
            raise BusRequestError(
                "bus.unsubscribed",
                f"This transport's stream does not name {', '.join(unnamed)}: a worker on it would never be answered, "
                "woken or told of a cancellation. Give the transport JOB_CLAIM_CHANNELS.",
            )
        # Both broadcasts are read as they come, and not as this SDK types them:
        # the comparison of an announcement with a filter knows no field by
        # name, so a job this SDK cannot type still wakes a worker whose claim
        # it matches.
        announced, cancellations = transport.frames(JOB_QUEUED.name), transport.frames(JOB_CANCEL_REQUESTED.name)
        self._listening.extend((announced, cancellations))
        self._run(self._hear_announcements(announced))
        self._run(self._hear_cancellations(cancellations))
        self._run(self._watch_the_stream())
        self._run(self._look_for_stalls())

    async def _hear_announcements(self, announced: Events[Frame]) -> None:
        async for frame in announced:
            # Every announcement received is stamped, before any filtering.
            self._last_queued_event_at = datetime.now(UTC)
            if any(job_matches_filter(accepted, frame.payload) for accepted in self._filters):
                self._pull()
        # The stream has ended: nothing more can be claimed.
        self._end()

    async def _hear_cancellations(self, cancellations: Events[Frame]) -> None:
        async for frame in cancellations:
            # A cancellation is the held job's only when it names it, and one
            # that arrives after the settle signals nothing.
            held, cancelling = self._held, self._cancelling
            if held is not None and cancelling is not None and not held.settled and frame.payload.get("jobId") == held.job_id:
                cancelling.set(True)

    async def _watch_the_stream(self) -> None:
        # The stream opening again is a change to `open` after the first
        # observation. The first observation decides whether the first claim
        # is made now or waits for the stream to open: a claim on a closed
        # stream would only be refused here.
        state = self._wire.transport.state
        was_open = state.value == "open"
        if was_open:
            self._pull()
        async for now in state:
            is_open = now == "open"
            if is_open and not was_open:
                self._pull()
            was_open = is_open

    async def _look_for_stalls(self) -> None:
        while True:
            await asyncio.sleep(self._held_job_stall_check_ms / 1000)
            held = self._held
            if held is None or self._stall_reported or self._active_at is None:
                continue
            if self._last_activity_at is None or self._held_since is None:
                continue
            silent_for_ms = int((asyncio.get_running_loop().time() - self._active_at) * 1000)
            if silent_for_ms <= self._held_job_stall_ms:
                continue
            self._stall_reported = True
            self._stall.set(
                HeldJobStall(
                    job_id=held.job_id,
                    job_type=held.job_type,
                    held_since=self._held_since,
                    last_activity_at=self._last_activity_at,
                    silent_for_ms=silent_for_ms,
                    threshold_ms=self._held_job_stall_ms,
                )
            )

    def _pull(self) -> None:
        """One idle moment: ask once, or remember that we were asked to."""
        if self._stopped or self._held is not None:
            # Holding a job: the settle claims. Nothing to remember.
            return
        if self._claiming:
            self._wake_pending = True
            return
        self._claiming = True
        self._wake_pending = False
        self._claim_in_flight = self._run(self._claim())

    async def _claim(self) -> None:
        # In no trace: the claim, and the reading of its answer. The task
        # this runs in began in whatever span was current at the idle moment.
        with telemetry.untraced():
            handed = await self._claim_next()
            self._claiming = False
            if self._stopped:
                # Answered after the worker stopped: the job is this worker's at
                # the dispatcher, and nobody here will run it.
                if isinstance(handed, HeldMarkJob | HeldYieldJob):
                    await _fail_for(handed, _STOPPED_WHILE_HELD)
                return
            if isinstance(handed, HeldMarkJob | HeldYieldJob):
                self._active()
                self._last_claim_at = self._last_activity_at
                self._held_since = self._last_activity_at
                self._stall_reported = False
                # A wake-up that arrived during the claim is moot: the settle claims.
                self._wake_pending = False
                self._held = handed
                self._handed.put_nowait(handed)
                return
            if handed is not None:
                self._handed.put_nowait(handed)
            if self._wake_pending:
                self._wake_pending = False
                self._pull()

    async def _claim_next(self) -> HeldJob | ClaimRefusal | None:
        """Ask once: the job claimed, the refusal, or nothing when nothing is pending.

        A claim names fields of the job description, never a job id. A reply
        that does not read as a claimed job is refused here and never run
        (WORKER-CONTRACT C9): it names no job id, no job type or no
        parameters.
        """
        try:
            answer = await answer_of(
                self._wire.transport, JOB_CLAIM, JobClaimCommand(accepts=list(self._accepts)), self._job_claim_timeout_ms
            )
        except BusRequestError as refused:
            if refused.code == "bus.none-pending":
                return None
            return ClaimRefusal(code=refused.code, message=refused.message)
        except SemiontError as error:
            return ClaimRefusal(code=None, message=error.message)
        claimed = answer.payload.response
        self._cancelling = Variable[bool](False)
        if claimed.metadata.type == "mark":
            return HeldMarkJob(self._holder, claimed, self._cancelling, answer.trace)
        return HeldYieldJob(self._holder, claimed, self._cancelling, answer.trace)

    def _end(self) -> None:
        """Nothing more is claimed or handed out, and what watched for an idle moment stops watching."""
        if self._stopped:
            return
        self._stopped = True
        self._handed.put_nowait(_ENDED)
        current = asyncio.current_task()
        for task in self._tasks:
            # A claim in flight is left to be answered: a job it is answered
            # with is failed, and not left held by nobody.
            if task is not current and task is not self._claim_in_flight:
                task.cancel()

    # ── What its reader has ─────────────────────────────────────

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> HeldJob | ClaimRefusal:
        if not self._begun:
            self._begun = True
            self._begin()
        while True:
            handed = await self._handed.get()
            if isinstance(handed, _Ended):
                # Whoever reads next is told the same.
                self._handed.put_nowait(handed)
                raise StopAsyncIteration
            # Claimed, and failed by the worker's stop before anybody read it.
            if isinstance(handed, ClaimRefusal) or not handed.settled:
                return handed

    def vitals(self) -> WorkerVitals:
        """What this worker can say of itself now."""
        held = self._held
        return WorkerVitals(
            last_queued_event_at=self._last_queued_event_at,
            last_claim_at=self._last_claim_at,
            last_finished_at=self._last_finished_at,
            last_activity_at=self._last_activity_at,
            active_job=None
            if held is None or self._held_since is None
            else ActiveJob(job_id=held.job_id, job_type=held.job_type, since=self._held_since),
            jobs_completed=self._jobs_completed,
        )

    @property
    def stalled(self) -> Watched[HeldJobStall | None]:
        """The last stall found: a held job that has shown no activity for `held_job_stall_ms`, reported once.

        Nothing until there is one, and each one after is a change.
        """
        return self._stall

    async def aclose(self) -> None:
        """Stop claiming.

        A job still held is failed first, and this returns once that has been
        said, or could not be. A claim in flight is waited for, up to its
        timeout: a job it is answered with is failed too.
        """
        held = self._held
        self._end()
        if held is not None:
            await _fail_for(held, _STOPPED_WHILE_HELD)
        current = asyncio.current_task()
        await asyncio.gather(*(task for task in self._tasks if task is not current), return_exceptions=True)
        for listening in self._listening:
            await listening.aclose()
        self._listening.clear()
        self._stall.end()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.aclose()
