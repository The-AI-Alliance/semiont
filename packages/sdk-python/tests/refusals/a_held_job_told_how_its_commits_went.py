"""How a held job's commits were established is the job's own to say: no settle is told it."""

from semiont.claims import HeldMarkJob, HeldYieldJob
from semiont.types import MarkJobDone, YieldJobDone


async def a_mark_job_s_completion_told(job: HeldMarkJob, result: MarkJobDone) -> None:
    await job.complete(result, durability="acknowledged")  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]


async def a_yield_job_s_completion_told(job: HeldYieldJob, result: YieldJobDone) -> None:
    await job.complete(result, durability="probe-confirmed")  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]


async def a_failure_told(job: HeldMarkJob) -> None:
    await job.fail("the commit was not established", durability="probe-refused")  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]
