"""Job: a job's lifecycle as it is announced, its status, its cancellation, and, for a worker, the claiming of jobs.

Creating a job is `mark.delegate` and `yield_.delegate`.
"""

import asyncio
from collections.abc import Callable, Sequence
from typing import Final, final

from semiont.bus import Typed
from semiont.channels import JOB_COMPLETE, JOB_FAIL, JOB_QUEUED, JOB_REPORT_PROGRESS
from semiont.claims import Claims
from semiont.errors import BusRequestError
from semiont.identifiers import JobId
from semiont.namespaces.links import Links
from semiont.operations import JOB_CANCEL_REQUESTED, JOB_STATUS_REQUESTED
from semiont.timing import HELD_JOB_STALL_CHECK_MS, HELD_JOB_STALL_MS, JOB_CLAIM_TIMEOUT_MS, MARK_COMMIT_TIMEOUT_MS
from semiont.types import (
    JobCancelRequest,
    JobCompleteCommand,
    JobFailCommand,
    JobFilter,
    JobQueuedEvent,
    JobReportProgressCommand,
    JobStatusRequest,
    JobStatusResponse,
)

__all__ = ["JobNamespace"]


@final
class JobNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    def queued(self) -> Typed[JobQueuedEvent]:
        """Every `job:queued` from now on: each a `mark` job's announcement or a `yield` job's, as its `job_type` says."""
        return self._links.own.frames(JOB_QUEUED)

    def progress(self) -> Typed[JobReportProgressCommand]:
        """Every `job:report-progress` from now on, of every job."""
        return self._links.own.frames(JOB_REPORT_PROGRESS)

    def complete(self) -> Typed[JobCompleteCommand]:
        """Every `job:complete` from now on, of every job: each a `mark` job's completion or a `yield` job's, as its `job_type` says."""
        return self._links.own.frames(JOB_COMPLETE)

    def fail(self) -> Typed[JobFailCommand]:
        """Every `job:fail` from now on, of every job."""
        return self._links.own.frames(JOB_FAIL)

    async def status(self, job_id: JobId) -> JobStatusResponse:
        """A job's status, as the queue holds it."""
        return (await self._links.request(JOB_STATUS_REQUESTED, JobStatusRequest(job_id=job_id))).response

    async def poll_until_complete(
        self, job_id: JobId, *, every_ms: int, within_ms: int, on_status: Callable[[JobStatusResponse], None] | None = None
    ) -> JobStatusResponse:
        """Ask for a job's status every `every_ms` until it has ended, giving each answer to `on_status`.

        The status it ended with. One that has not ended `within_ms` fails as
        a timeout.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + within_ms / 1000
        while True:
            status = await self.status(job_id)
            if on_status is not None:
                on_status(status)
            if status.status in ("complete", "failed", "cancelled"):
                return status
            if loop.time() > deadline:
                raise BusRequestError("bus.timeout", f"Job polling timeout after {within_ms}ms")
            await asyncio.sleep(every_ms / 1000)

    async def cancel(self, job_id: JobId) -> int:
        """Cancel one job: how many the queue acted on.

        A pending job is cancelled outright. A running one is left to its
        worker, so one means accepted, not stopped.
        """
        return (await self._links.request(JOB_CANCEL_REQUESTED, JobCancelRequest(job_id=job_id))).response.cancelled

    def claim(
        self,
        accepts: Sequence[JobFilter],
        *,
        job_claim_timeout_ms: int = JOB_CLAIM_TIMEOUT_MS,
        held_job_stall_ms: int = HELD_JOB_STALL_MS,
        held_job_stall_check_ms: int = HELD_JOB_STALL_CHECK_MS,
        mark_commit_timeout_ms: int = MARK_COMMIT_TIMEOUT_MS,
    ) -> Claims:
        """A worker's side: claim the jobs `accepts` describes, and hold one at a time.

        Claiming begins when the claims are first read, and each job they
        hand out says its own lifecycle, commits its own annotations and
        settles once (docs/protocol/WORKER-CONTRACT.md). The transport's
        stream must name `semiont.claims.JOB_CLAIM_CHANNELS`, and
        `semiont.claims.JOB_COMMIT_CHANNELS` for a worker that commits. The
        four waits are the values of specs/src/client/timing.json unless a
        caller that must not wait them out states others.
        """
        return Claims(
            self._links.wire,
            self._links.run,
            accepts,
            job_claim_timeout_ms=job_claim_timeout_ms,
            held_job_stall_ms=held_job_stall_ms,
            held_job_stall_check_ms=held_job_stall_check_ms,
            mark_commit_timeout_ms=mark_commit_timeout_ms,
        )
