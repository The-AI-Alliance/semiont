from semiont.claims import JOB_CLAIM_CHANNELS, ClaimRefusal, HeldMarkJob, HeldYieldJob
from semiont.client import SemiontClient
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.types import JobDetectionResult, JobProgress, MarkJobFilter, MarkJobFilterParams


async def highlight(job: HeldMarkJob) -> JobDetectionResult:
    """Your work: read the resource, find the passages, commit them."""
    await job.progress(JobProgress(percentage=50))
    return JobDetectionResult(found=0, persisted=0)


async def work(gateway: str, issuer: str, client_id: str, secret: str) -> None:
    # The process proves who it is at the issuer, and is given the agent its work is attributed to.
    service = ServiceToken(Credential(issuer=issuer, client_id=client_id, client_secret=secret))
    accepts = [MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="highlighting"))]
    async with (
        AgentToken(gateway, provider="ollama", model="gemma3:4b", service=service) as agent,
        # Its stream names what claiming reads. This worker awaits nothing else, so it names nothing else.
        HttpTransport(gateway, token=agent.token, refresher=agent.refresh, channels=JOB_CLAIM_CHANNELS) as transport,
        SemiontClient(transport, transport.content, transport) as client,
        # Leaving this block stops the worker: a job it still holds is failed first, and the queue retries it.
        client.job.claim(accepts) as claims,
    ):
        # Each job the worker comes to hold, one at a time. The next is claimed when this one settles.
        async for handed in claims:
            match handed:
                case ClaimRefusal(code="bus.unauthorized"):
                    # This credential can never claim. Stop, so that whoever runs the worker sees it.
                    raise PermissionError(handed.message)
                case ClaimRefusal():
                    print(f"claim refused: {handed.message}")
                case HeldYieldJob():
                    await handed.fail("this worker runs no yield job", failure_class="deterministic")
                case HeldMarkJob():
                    # A job left unsettled at the end of this block is failed.
                    async with handed as job:
                        await job.start()
                        try:
                            result = await highlight(job)
                        except Exception as error:
                            await job.fail(str(error))
                        else:
                            await job.complete(result)
