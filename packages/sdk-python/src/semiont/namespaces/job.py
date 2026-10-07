"""Job: a job's lifecycle as it is announced, its status, and its cancellation.

Creating a job is `mark.delegate` and `yield_.delegate`.
"""

import asyncio
from collections.abc import Callable
from typing import Final, final

from semiont.bus import Typed
from semiont.channels import JOB_COMPLETE, JOB_FAIL, JOB_QUEUED, JOB_REPORT_PROGRESS
from semiont.errors import BusRequestError
from semiont.identifiers import JobId
from semiont.namespaces.links import Links
from semiont.operations import JOB_CANCEL_REQUESTED, JOB_STATUS_REQUESTED
from semiont.types import (
    JobCancelRequest,
    JobCompleteCommand,
    JobFailCommand,
    JobQueuedEvent,
    JobReportProgressCommand,
    JobStatusRequest,
    JobStatusResponse,
    JobType,
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
        """Every `job:complete` from now on, of every job."""
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

    async def cancel_by_type(self, job_type: JobType) -> int:
        """Cancel every pending job of one type: how many were cancelled. Running jobs are their workers' to stop."""
        return await self._cancelled(JobCancelRequest(job_type=job_type))

    async def cancel(self, job_id: JobId) -> int:
        """Cancel one job: how many the queue acted on.

        A pending job is cancelled outright. A running one is left to its
        worker, so one means accepted, not stopped.
        """
        return await self._cancelled(JobCancelRequest(job_id=job_id))

    def cancel_request(self, job_type: JobType) -> None:
        """Signal: the cancellation of every pending job of one type is wanted."""
        self._links.signal(JOB_CANCEL_REQUESTED.request, JobCancelRequest(job_type=job_type))

    async def _cancelled(self, request: JobCancelRequest) -> int:
        return (await self._links.request(JOB_CANCEL_REQUESTED, request)).response.cancelled
