"""Following a job from its creation to its end (`docs/protocol/JOBS.md` § Following a job).

A job's progress and its end reach the client that created it as passing
frames: a stream that is down when one is published does not carry it later.
So a follower that has heard nothing of its job for the client's
`job_silence_ms` asks for the job's status, and asks again every
`job_status_poll_ms` until the job says something or its status is an end.

The follower listens before it creates the job: a frame of the job can be
read from the stream beside the reply that names it. Frames that arrive before
the job's id is known are held, and the job's are then handled in the order
they came.

A failure the queue will retry is reported and followed past: the job is not
over. A failure it will not retry ends the follower with `job.failed`. A
follower given a stall deadline that hears nothing for that long asks for the
cancellation and ends with `job.stalled`.

A job completes as its verb's jobs do: a `mark` job with a
`MarkJobCompleteCommand`, a `yield` job with a `YieldJobCompleteCommand`. The
follower of a job is told which, and reads the completion as that one, whether
it heard it or learned it from the job's status. A completion that is another
verb's is not the job's failure: it is an answer that is not the protocol's,
and ends the follower with a `TransportError`.

What the caller holds is a `Delegation`: the job's events as it goes, and its
completion.
"""

import asyncio
from collections.abc import AsyncIterator, Callable, Generator
from dataclasses import dataclass, field
from typing import Final, Literal, final

from pydantic import TypeAdapter, ValidationError

from semiont.bus import decoded
from semiont.channels import JOB_COMPLETE, JOB_FAIL, JOB_REPORT_PROGRESS
from semiont.errors import BusRequestError, JobError, SemiontError, TransportError
from semiont.identifiers import JobId, ResourceId
from semiont.namespaces.links import Links
from semiont.operations import JOB_CANCEL_REQUESTED, JOB_CREATE, JOB_STATUS_REQUESTED
from semiont.running import Running
from semiont.transport import Frame
from semiont.types import (
    JobCancelRequest,
    JobCompleteCommand,
    JobCreateCommand,
    JobCreatedResult,
    JobFailCommand,
    JobProgress,
    JobReportProgressCommand,
    JobStatusRequest,
    JobStatusResponse,
    JobType,
)

__all__ = ["Delegation", "JobAttemptFailed", "JobCompleted", "JobEvent", "JobProgressed", "follow"]


@final
@dataclass(frozen=True, slots=True)
class JobProgressed:
    """The job's progress."""

    data: JobProgress
    kind: Literal["progress"] = field(default="progress", init=False)


@final
@dataclass(frozen=True, slots=True)
class JobAttemptFailed:
    """An attempt failed and the queue will try again. The job is not over."""

    data: JobFailCommand
    kind: Literal["failed"] = field(default="failed", init=False)


@final
@dataclass(frozen=True, slots=True)
class JobCompleted[C: JobCompleteCommand]:
    """The job completed, with the completion its verb's jobs give. A follower's last value."""

    data: C
    kind: Literal["complete"] = field(default="complete", init=False)


type JobEvent[C: JobCompleteCommand] = JobProgressed | JobAttemptFailed | JobCompleted[C]
"""What a followed job reports, and how it ends, `C` being the completion its
verb's jobs give. As JSON it is `{"kind": "progress", "data": …}`, the same
event in every SDK."""


@final
class Delegation[C: JobCompleteCommand]:
    """A job another party does (`mark.delegate`, `yield_.delegate`), consumed one of two ways, once.

    `C` is the completion its verb's jobs give: `MarkJobCompleteCommand`,
    whose `result` is a `mark` job's counts or a decline, or
    `YieldJobCompleteCommand`, whose `result` is the resource a `yield` job
    made or a decline.

    - Awaited, it gives the job's completion.
    - Iterated (`async for`), it gives every event of the job, the
      completion's the last of them, and ends.

    A job that does not complete is a failure, raised where the completion
    would have been given. Nothing is sent until it is first awaited or
    iterated, and its caller abandons it by cancelling the task that awaits it
    or reads it: the job goes on, and is followed no more.
    """

    def __init__(self, following: Running[JobEvent[C]]) -> None:
        self._following: Final = following

    async def _completion(self) -> C:
        last = await self._following
        match last:
            case JobCompleted(data=completion):
                return completion
            case JobProgressed() | JobAttemptFailed():
                raise RuntimeError(f"a delegated job ended on a {last.kind} event, not on its completion")

    def __await__(self) -> Generator[object, None, C]:
        return self._completion().__await__()

    def __aiter__(self) -> AsyncIterator[JobEvent[C]]:
        return aiter(self._following)


type _Heard = JobReportProgressCommand | JobCompleteCommand | JobFailCommand

_LIFECYCLE: Final = (JOB_REPORT_PROGRESS, JOB_COMPLETE, JOB_FAIL)


def _heard(frame: Frame) -> _Heard | None:
    """A frame of some job's lifecycle, read as its channel's. One that is not its channel's is nobody's to act on."""
    try:
        if frame.channel == JOB_REPORT_PROGRESS.name:
            return decoded(JOB_REPORT_PROGRESS, frame.payload)
        if frame.channel == JOB_COMPLETE.name:
            return decoded(JOB_COMPLETE, frame.payload)
        if frame.channel == JOB_FAIL.name:
            return decoded(JOB_FAIL, frame.payload)
    except ValidationError:
        return None
    return None


def _learned[C: JobCompleteCommand](
    completion: TypeAdapter[C], delegated: JobType, status: JobStatusResponse, resource_id: ResourceId
) -> C:
    """The completion a complete status stands for, read as the delegated verb's.

    A status states its job's type and a result of any verb's, and does not
    state the resource the job is about. What it states is given to the
    verb's own shape to read: nothing here says which result is which verb's.
    """
    stated: dict[str, object] = {"resourceId": resource_id, "jobId": status.job_id, "jobType": status.type}
    # A job completed without a result is stored with an empty one: an object that holds nothing.
    if not (status.result is None or isinstance(status.result, dict)):
        stated["result"] = status.result
    try:
        return completion.validate_python(stated)
    except ValidationError as error:
        raise TransportError("error", f"The status of job {status.job_id} is not a completed {delegated} job's: {error}") from error


def follow[C: JobCompleteCommand](
    links: Links, create: JobCreateCommand, completion: type[C], *, resource_id: ResourceId, stall_ms: int | None
) -> Delegation[C]:
    """Create a job and follow it to the completion its verb's jobs give.

    `completion` is that completion's shape. `resource_id` is the resource
    the job is about, for a completion learned from the job's status.
    `stall_ms` is how long the job may say nothing before its follower gives
    up on it, when it gives up at all.
    """
    reads = TypeAdapter(completion)
    return Delegation(Running(lambda report: links.run(_followed(links, create, reads, resource_id, stall_ms, report))))


async def _status(links: Links, job_id: JobId) -> JobStatusResponse:
    return (await links.request(JOB_STATUS_REQUESTED, JobStatusRequest(job_id=job_id))).response


async def _cancelled(links: Links, job_id: JobId) -> None:
    try:
        await links.request(JOB_CANCEL_REQUESTED, JobCancelRequest(job_id=job_id))
    except SemiontError:
        return


async def _followed[C: JobCompleteCommand](
    links: Links,
    create: JobCreateCommand,
    completion: TypeAdapter[C],
    resource_id: ResourceId,
    stall_ms: int | None,
    report: Callable[[JobEvent[C]], None],
) -> JobCompleted[C]:
    loop = asyncio.get_running_loop()
    silence, poll = links.job_silence_ms / 1000, links.job_status_poll_ms / 1000
    stall = None if stall_ms is None else stall_ms / 1000

    # One reader of the three channels, so the job's frames are heard in the order they were published.
    frames = links.own.frames_among([channel.name for channel in _LIFECYCLE])
    creating: asyncio.Task[JobCreatedResult] | None = asyncio.ensure_future(links.request(JOB_CREATE, create))
    hearing: asyncio.Task[Frame | None] = asyncio.ensure_future(anext(frames, None))
    asking: asyncio.Task[JobStatusResponse] | None = None
    job_id: JobId | None = None
    held: list[_Heard] = []
    ask_at: float | None = None
    stall_at = None if stall is None else loop.time() + stall
    try:
        while True:
            now = loop.time()
            if stall is not None and stall_at is not None and now >= stall_at:
                # That job and no other: a cancellation by type would end
                # every pending job of it, whoever asked for them. One whose
                # creation was never answered has no id, and there is nothing
                # to cancel. Asked for on a task of the client's: the follower
                # ends here, and the request must outlive it.
                if job_id is not None:
                    links.run(_cancelled(links, job_id))
                raise JobError("job.stalled", f"The job stalled: nothing was heard of it within {stall_ms}ms", job_id=job_id)

            waiting: set[asyncio.Task[object]] = {hearing}
            if creating is not None:
                waiting.add(creating)
            if asking is not None:
                waiting.add(asking)
            due = min((at for at in (ask_at, stall_at) if at is not None), default=None)
            done, _ = await asyncio.wait(waiting, timeout=None if due is None else max(due - now, 0), return_when=asyncio.FIRST_COMPLETED)
            now = loop.time()
            heard: list[_Heard] = []

            if creating is not None and creating in done:
                created = creating.result()
                creating = None
                job_id = created.response.job_id
                ask_at = now + silence
                heard, held = held, []

            if hearing in done:
                frame = hearing.result()
                if frame is None:
                    raise BusRequestError("bus.closed", "The client closed while it was following a job")
                hearing = asyncio.ensure_future(anext(frames, None))
                said = _heard(frame)
                if said is not None:
                    (held if job_id is None else heard).append(said)

            if asking is not None and asking in done:
                answered, asking = asking, None
                failure = answered.exception()
                # A status that could not be had is asked for again at the next poll.
                if failure is not None and not isinstance(failure, SemiontError):
                    raise failure
                if failure is None:
                    status = answered.result()
                    match status.status:
                        case "complete":
                            return JobCompleted(_learned(completion, create.job_type, status, resource_id))
                        case "failed":
                            raise JobError("job.failed", status.error or "Job failed", job_id=status.job_id)
                        case "cancelled":
                            # Nothing announces a cancellation: this is where its follower learns of one.
                            raise JobError("job.cancelled", "The job was cancelled", job_id=status.job_id)
                        case "pending" | "running":
                            pass

            if ask_at is not None and now >= ask_at:
                ask_at = now + poll
                if asking is None and job_id is not None:
                    asking = asyncio.ensure_future(_status(links, job_id))

            for said in heard:
                if said.job_id != job_id:
                    continue
                match said:
                    case JobReportProgressCommand():
                        if said.progress is not None:
                            report(JobProgressed(said.progress))
                        ask_at = now + silence
                        stall_at = None if stall is None else now + stall
                    case JobFailCommand():
                        # Absent reads as final: a follower that ends early is seen, one that never ends is not.
                        if said.will_retry is not True:
                            raise JobError("job.failed", said.error, job_id=said.job_id)
                        # The queue re-queues the job and another attempt
                        # continues it. The dead attempt's status is not asked
                        # for: the next attempt's first frame starts the
                        # silence again. The setback was heard, so the stall
                        # deadline starts again: one left running would cancel
                        # the attempt that is coming.
                        ask_at = None
                        stall_at = None if stall is None else now + stall
                        report(JobAttemptFailed(said))
                    case _:
                        # The third thing a job says: that it completed, read as the delegated verb's completion.
                        try:
                            return JobCompleted(completion.validate_python(said))
                        except ValidationError:
                            completed, delegated = said.job_type, create.job_type
                            raise TransportError(
                                "error",
                                f"The job:complete of job {said.job_id} is a {completed} job's, and the job delegated is a {delegated} job",
                            ) from None
    finally:
        left: list[asyncio.Task[object]] = [task for task in (creating, hearing, asking) if task is not None]
        for task in left:
            task.cancel()
        await asyncio.gather(*left, return_exceptions=True)
        await frames.aclose()
