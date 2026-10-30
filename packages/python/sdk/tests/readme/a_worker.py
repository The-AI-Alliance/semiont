from semiont.annotations import QuotedText, annotation_of_span, reconcile
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, ClaimRefusal, HeldMarkJob, HeldYieldJob
from semiont.client import SemiontClient
from semiont.http import AgentToken, HttpTransport, SecretCredential, ServiceToken
from semiont.identifiers import AnnotationId
from semiont.identity import engine_name
from semiont.types import Agent, AgentSoftware, Annotation, JobProgress, MarkJobDone, MarkJobFilter, MarkJobFilterParams

PROVIDER, MODEL = "ollama", "gemma3:4b"


async def passages(text: str) -> list[QuotedText]:
    """Your model: the passages of a text it would highlight, each as the words it quoted. This one quotes the first line."""
    return [QuotedText(exact=text.partition("\n")[0])]


async def highlight(client: SemiontClient[HttpTransport], job: HeldMarkJob, generator: Agent) -> MarkJobDone:
    """Your work: read the resource, have its passages quoted, and commit a highlight of each one the text has."""
    text = await client.browse.resource_content(job.resource_id)
    quoted = await passages(text)
    await job.progress(JobProgress(percentage=50))
    highlights: dict[AnnotationId, Annotation] = {}
    for quote in quoted:
        # What a model quotes is not trusted: it is found in the text, as the text has it, or it is dropped.
        span = reconcile(text, quote)
        if span is not None:
            built = annotation_of_span(text, span, resource_id=job.resource_id, motivation="highlighting", generator=generator)
            # An annotation's id is worked out from what it is, so a passage quoted twice is one annotation.
            highlights[built.id] = built
    await job.commit(job.resource_id, list(highlights.values()))
    return MarkJobDone(found=len(quoted), persisted=len(highlights))


async def work(gateway: str, issuer: str, client_id: str, secret: str) -> None:
    # The process signs in at its issuer as its account: the agent its work is attributed to.
    service = ServiceToken(SecretCredential(issuer=issuer, client_id=client_id, client_secret=secret))
    accepts = [MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="highlighting"))]
    async with (
        AgentToken(gateway, service=service) as agent,
        # Its stream names what claiming and committing read. This worker awaits nothing else, so it names nothing else.
        HttpTransport(
            gateway, token=agent.token, refresher=agent.refresh, channels=(*JOB_CLAIM_CHANNELS, *JOB_COMMIT_CHANNELS)
        ) as transport,
        SemiontClient(transport, transport.content, transport) as client,
        # Leaving this block stops the worker: a job it still holds is failed first, and the queue retries it.
        client.job.claim(accepts) as claims,
    ):
        print(f"working as {agent.did}")
        # What made the annotations it commits: the agent, as the gateway names it, and the engine it ran.
        generator = AgentSoftware(type="Software", id=agent.did, name=engine_name(PROVIDER, MODEL), provider=PROVIDER, model=MODEL)
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
                            result = await highlight(client, job, generator)
                        except Exception as error:
                            await job.fail(str(error))
                        else:
                            await job.complete(result)
