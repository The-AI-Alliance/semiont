"""The service's agent at one knowledge base: its account there, signed in, and an engine for each of its `engines`, claiming jobs.

The service is an agent at each knowledge base its document names
(`docs/protocol/WORKER-SERVICE.md` § The agent). At each it signs in as the
client that knowledge base's `identity` names, and the DID that knowledge
base's gateway answers is who the agent is there. It is used as answered and
derived from nothing else: derived from the address the service happens to
dial, one agent would have two.

Once its stream is open, the agent asks the knowledge base which it is, and
goes on only at the one its entry names: there it says what it is called,
which is that knowledge base's client id, and readers name it from that, as
they name a person. Then it answers for its engines' limits, and claims for
each engine.

An engine is a provider and a model. Each entry of the knowledge base's
`engines` names one, the jobs the agent does with it there and where its
provider is reached, and the agent claims those jobs for it, one at a time,
under the agent's sign-in there and over its one stream there. What a job
makes names the agent by its DID at the knowledge base the job came from, and
the engine that made it, and no name.

What ends the agent's work at a knowledge base, but its being stopped, is one
of two things (§ Knowledge bases): the knowledge base refused it
(`KnowledgeBaseRefused`), or there was trouble there (`KnowledgeBaseTrouble`).
Either is raised to whatever supervises the knowledge base, which acts on it
(`semiont_worker.knowledge_base`). Whatever ends it, a job still held there is
failed first and nothing more is claimed.

The agent's stream names what a worker reads and no more. The replies of
every operation a client can ask reach every stream that names them, and a
worker that named them all would be sent every other client's answers.
"""

import asyncio
from collections.abc import Sequence
from contextlib import AsyncExitStack
from datetime import datetime
from types import TracebackType
from typing import Final, Self, final, overload

from pydantic import JsonValue
from semiont.bus import reply_channels_for
from semiont.channels import PRINCIPAL_PROFILE
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, ClaimRefusal, Claims
from semiont.client import SemiontClient
from semiont.errors import BusRequestError, SemiontError
from semiont.http import AgentToken, HttpTransport, ServiceToken
from semiont.identifiers import UserId
from semiont.model import written
from semiont.operations import BROWSE_KB_REQUESTED, BROWSE_RESOURCE_REQUESTED, JOB_LIMITS_REQUESTED
from semiont.retry import REFRESH, RetryFacts
from semiont.transport import Transport
from semiont.types import (
    Agent,
    AgentSoftware,
    JobFilter,
    PrincipalProfileCommand,
    WorkerEngineConfig,
    WorkerEngineHealth,
    WorkerEngineHealthActiveJob,
    WorkerKnowledgeBaseConfig,
    WorkerKnowledgeBaseHealth,
)
from semiont_inference.interface import InferenceClient
from semiont_inference.limits_report import answer_limits_requests

from semiont_worker.failure_class import words_of
from semiont_worker.held_job import run_job
from semiont_worker.log import LOG

WORKER_CHANNELS: Final[tuple[str, ...]] = (
    *JOB_CLAIM_CHANNELS,
    # Every job that makes annotations commits them, and waits for the record to have them.
    *JOB_COMMIT_CHANNELS,
    # What this service itself awaits: which knowledge base it reached, and a resource's description.
    *reply_channels_for(BROWSE_KB_REQUESTED, BROWSE_RESOURCE_REQUESTED),
    # What this service answers: the limits of its engines.
    JOB_LIMITS_REQUESTED.request.name,
)
"""What the agent's stream names: what the SDK's claiming and committing read, the replies of what it asks, and the request it answers."""


class KnowledgeBaseRefused(Exception):
    """The knowledge base refused the agent, and stays refused until the service is started again (R2).

    Its words are why, and carry nothing of the key or of a token, and no body
    an issuer or a gateway answered with.
    """


class KnowledgeBaseTrouble(Exception):
    """Trouble at the knowledge base, which ends the agent's work there until it is started again (R3). Its words are why."""


def _signing_in_failed(failure: SemiontError) -> KnowledgeBaseRefused | KnowledgeBaseTrouble:
    """A sign-in there, or the gateway's naming of the agent, that failed: refused or trouble, as the SDK's sign-in would take it.

    An answer the `refresh` rule does not try again is a verdict: the same
    account gets the same answer. No answer, and one it tries again, is
    trouble (`semiont.retry.REFRESH`).
    """
    said = words_of(failure)
    if REFRESH.retryable(RetryFacts(status=failure.status)):
        return KnowledgeBaseTrouble(said)
    return KnowledgeBaseRefused(said)


@overload
def _instant(at: datetime) -> str: ...
@overload
def _instant(at: None) -> None: ...
def _instant(at: datetime | None) -> str | None:
    """A moment as the health endpoint says one: to the millisecond, in UTC."""
    return None if at is None else at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def engine_of(entry: WorkerEngineConfig) -> dict[str, JsonValue]:
    """An engine as the log says one: its provider and model, and the jobs the agent does with it, as a claim states them."""
    return {"provider": entry.engine.provider, "model": entry.engine.model, "jobs": [written(accepted) for accepted in entry.jobs]}


async def run_what_is_claimed(
    client: SemiontClient[Transport],
    claims: Claims,
    *,
    inference: InferenceClient,
    generator: Agent,
    accepts: Sequence[JobFilter],
    domain: str,
) -> None:
    """Run each job `claims` hands out, one at a time, until the claiming ends.

    A claim refused as unauthorized refuses the knowledge base (P3): the grant
    is gone, and no later claim there changes that. A claim refused for any
    other reason is said in the log, and the engine claims again at its next
    idle moment.
    """
    async for handed in claims:
        if isinstance(handed, ClaimRefusal):
            if handed.code == "bus.unauthorized":
                raise KnowledgeBaseRefused("a claim there was refused as unauthorized: this worker's grant there is gone")
            LOG.warning(
                "Claim declined; parked until the next wake-up", extra={"domain": domain, "code": handed.code, "refusal": handed.message}
            )
            continue
        await run_job(handed, client=client, inference=inference, generator=generator, accepts=accepts)


async def watch_for_a_stall(claims: Claims) -> None:
    """Raise `KnowledgeBaseTrouble` when the job `claims` holds stalls (P4).

    A held job that shows no activity is wedged: an engine that never settles
    never claims again. Its knowledge base's work ends, and is started again.
    """
    async for stall in claims.stalled:
        if stall is None:
            continue
        raise KnowledgeBaseTrouble(
            f"the job {stall.job_id} ({stall.job_type}), held since {_instant(stall.held_since)}, has shown no activity "
            f"since {_instant(stall.last_activity_at)}: {stall.silent_for_ms} ms, past {stall.threshold_ms} ms"
        )


@final
class EngineAtWork:
    """One engine at work at a knowledge base: its entry of the knowledge base's `engines`, its model's client, and its claims there.

    It claims with its entry's `jobs` and no other filter, and runs each job
    it is handed with its engine, one at a time.
    """

    def __init__(self, entry: WorkerEngineConfig, inference: InferenceClient, claims: Claims, *, domain: str) -> None:
        self._entry: Final = entry
        self.inference: Final = inference
        self._claims: Final = claims
        self._domain: Final = domain
        self._stopping = False

    def health(self) -> WorkerEngineHealth:
        """What the engine says of itself to the health endpoint: which it is, the jobs it does, and what its claims say of themselves."""
        said = self._claims.vitals()
        active = said.active_job
        return WorkerEngineHealth(
            engine=self._entry.engine,
            jobs=self._entry.jobs,
            last_queued_event_at=_instant(said.last_queued_event_at),
            last_claim_at=_instant(said.last_claim_at),
            last_finished_at=_instant(said.last_finished_at),
            last_activity_at=_instant(said.last_activity_at),
            active_job=None
            if active is None
            else WorkerEngineHealthActiveJob(job_id=active.job_id, type=active.job_type, since=_instant(active.since)),
            jobs_completed=said.jobs_completed,
        )

    async def work(self, client: SemiontClient[Transport], agent: UserId) -> None:
        """Claim the engine's jobs and run each, one at a time, until it is stopped.

        It returns once `stop` has ended the claiming. A claim refused as
        unauthorized raises `KnowledgeBaseRefused`; a held job that stalls, and
        a claiming that ends unstopped, which is the stream ending,
        `KnowledgeBaseTrouble`. However it ends, a job still held is failed
        before its work is torn down, and no other is claimed.
        """
        engine = self._entry.engine
        # What everything the engine makes says made it: the agent, by the DID the gateway named it with, and the engine.
        generator: Agent = AgentSoftware(type="Software", id=agent, provider=engine.provider, model=engine.model)
        watching = asyncio.ensure_future(watch_for_a_stall(self._claims))
        running = asyncio.ensure_future(
            run_what_is_claimed(
                client, self._claims, inference=self.inference, generator=generator, accepts=self._entry.jobs, domain=self._domain
            )
        )
        try:
            await asyncio.wait([watching, running], return_when=asyncio.FIRST_COMPLETED)
        finally:
            await self._claims.aclose()
            for task in (watching, running):
                task.cancel()
            await asyncio.gather(watching, running, return_exceptions=True)
        for ended in (running, watching):
            failure = None if ended.cancelled() else ended.exception()
            if failure is not None:
                raise failure
        if not self._stopping:
            raise KnowledgeBaseTrouble("the stream there ended: nothing more can be claimed")

    async def stop(self) -> None:
        """Stop claiming. A job still held is failed first, so the queue retries it now and does not wait for its sweep."""
        self._stopping = True
        await self._claims.aclose()


@final
class AgentWorker:
    """The service's agent at one knowledge base. Held with `async with`: signed in there inside, and signed out on the way out.

    `knowledge_base` is its entry of the document, and `clients` the client of
    each of its engines' providers and models, in the entry's order. `service`
    is the account the agent signs in as there.

    Signing in opens no stream. `open` does, confirms the knowledge base and
    says what the agent is called there: the stream, the client over it and
    each engine's claims are then the agent's until the way out, which ends
    each engine's claiming first and so fails a job still held.
    """

    def __init__(self, knowledge_base: WorkerKnowledgeBaseConfig, clients: Sequence[InferenceClient], *, service: ServiceToken) -> None:
        self._knowledge_base: Final = knowledge_base
        self._engines: Final = tuple(zip(knowledge_base.engines, clients, strict=True))
        self._service: Final = service
        self._held: Final = AsyncExitStack()
        self._token: AgentToken | None = None
        self._opened: tuple[SemiontClient[HttpTransport], tuple[EngineAtWork, ...]] | None = None

    async def __aenter__(self) -> Self:
        """Sign in. Raises `KnowledgeBaseRefused` or `KnowledgeBaseTrouble` where the issuer or the gateway did not have it so."""
        try:
            self._token = await self._held.enter_async_context(AgentToken(self._knowledge_base.gateway_url, service=self._service))
        except SemiontError as unsigned:
            raise _signing_in_failed(unsigned) from None
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self._held.aclose()

    def _signed_in(self) -> AgentToken:
        if self._token is None:
            raise RuntimeError("the agent is not signed in: hold it with `async with`")
        return self._token

    @property
    def did(self) -> UserId:
        """The agent's DID at the knowledge base, as its gateway answered it."""
        return self._signed_in().did

    async def open(self) -> None:
        """Open the agent's stream and its client over it, confirm the knowledge base (R1), and say what the agent is called there (G5).

        A knowledge base that answers another domain than its entry's, or that
        answers that it cannot say which it is, raises `KnowledgeBaseRefused`,
        and nothing more is said there. Anything else that keeps it from being
        confirmed or told raises `KnowledgeBaseTrouble`. Each engine's claiming
        begins when the agent is put to work.
        """
        token = self._signed_in()
        knowledge_base = self._knowledge_base
        transport = await self._held.enter_async_context(
            HttpTransport(knowledge_base.gateway_url, token=token.token, refresher=token.refresh, channels=WORKER_CHANNELS)
        )
        client = await self._held.enter_async_context(SemiontClient(transport, transport.content, transport))
        await self._confirm(client)
        try:
            await client.wire.emit(PRINCIPAL_PROFILE, PrincipalProfileCommand(name=knowledge_base.identity.client_id))
        except SemiontError as unsaid:
            raise KnowledgeBaseTrouble(f"what the agent is called could not be said there: {words_of(unsaid)}") from None
        engines: list[EngineAtWork] = []
        for entry, inference in self._engines:
            claims = await self._held.enter_async_context(client.job.claim(entry.jobs))
            engines.append(EngineAtWork(entry, inference, claims, domain=knowledge_base.domain))
        self._opened = (client, tuple(engines))

    async def _confirm(self, client: SemiontClient[HttpTransport]) -> None:
        """Ask the knowledge base which it is, and go on only where it is the one the entry names."""
        try:
            answered = await client.browse.kb()
        except SemiontError as unconfirmed:
            if isinstance(unconfirmed, BusRequestError) and unconfirmed.failure is not None:
                raise KnowledgeBaseRefused(f"it answered browse:kb-requested with browse:kb-failed ({unconfirmed.code})") from None
            raise KnowledgeBaseTrouble(f"it did not say which knowledge base it is: {words_of(unconfirmed)}") from None
        if answered.domain != self._knowledge_base.domain:
            raise KnowledgeBaseRefused(f"it answered browse:kb-requested as {answered.domain}")

    def _at_work(self) -> tuple[UserId, SemiontClient[HttpTransport], tuple[EngineAtWork, ...]]:
        if self._opened is None:
            raise RuntimeError("the agent's stream is not open: `open` it")
        client, engines = self._opened
        return self._signed_in().did, client, engines

    def health(self) -> WorkerKnowledgeBaseHealth:
        """What the health endpoint says of the knowledge base while the agent works there: its DID, and what each engine says of itself."""
        did, _, engines = self._at_work()
        return WorkerKnowledgeBaseHealth(
            domain=self._knowledge_base.domain, state="working", did=did, engines=[engine.health() for engine in engines]
        )

    async def work(self) -> None:
        """Answer for the limits of the knowledge base's engines, and claim for each and run what it is handed, until the agent is stopped.

        It returns once `stop` has ended every engine's claiming. Whatever
        else ends one engine's work ends the others', each failing the job it
        holds first, and is raised: `KnowledgeBaseRefused`,
        `KnowledgeBaseTrouble`, or a failure nothing classifies.
        """
        did, client, engines = self._at_work()
        answering = asyncio.ensure_future(
            answer_limits_requests(client.wire, JOB_LIMITS_REQUESTED, [engine.inference for engine in engines])
        )
        working = [asyncio.ensure_future(engine.work(client, did)) for engine in engines]
        ended: set[asyncio.Task[None]] = set()
        try:
            ended, _ = await asyncio.wait(working, return_when=asyncio.FIRST_EXCEPTION)
        finally:
            await self.stop()
            for task in (answering, *working):
                task.cancel()
            await asyncio.gather(answering, *working, return_exceptions=True)
        for engine_work in working:
            failure = None if engine_work not in ended or engine_work.cancelled() else engine_work.exception()
            if failure is not None:
                raise failure

    async def stop(self) -> None:
        """Stop every engine's claiming. A job still held is failed first, so the queue retries it now. An agent not yet open holds none."""
        if self._opened is None:
            return
        _, engines = self._opened
        await asyncio.gather(*(engine.stop() for engine in engines))
