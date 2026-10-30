"""The service's one agent: its account, signed in once, and an engine for each entry of its document, each claiming and running jobs.

The service is one agent (`docs/protocol/WORKER-SERVICE.md` § The agent). It
signs in once, as its account at the issuer, and the DID the gateway answers
is who the agent is. It is used as answered and derived from nothing else:
derived from the address the service happens to dial, one agent would have
two.

An engine is a provider and a model. Each entry of the document's `engines`
names one, the jobs the agent does with it and where its provider is reached,
and the agent claims those jobs for it, one at a time, under the agent's
sign-in and over its one stream. What a job makes names the agent by its DID
and the engine that made it, and no name: what the agent is called is its
profile, which it states when it opens its stream, and readers name it from
that, as they name a person.

The agent's stream names what a worker reads and no more. The replies of
every operation a client can ask reach every stream that names them, and a
worker that named them all would be sent every other client's answers.
"""

import asyncio
import os
import sys
from collections.abc import Sequence
from contextlib import AsyncExitStack
from datetime import datetime
from types import TracebackType
from typing import Final, NoReturn, Self, final

from pydantic import JsonValue
from semiont.bus import reply_channels_for
from semiont.channels import PRINCIPAL_PROFILE
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, ClaimRefusal, Claims
from semiont.client import SemiontClient
from semiont.http import AgentToken, HttpTransport, ServiceToken
from semiont.identifiers import UserId
from semiont.model import written
from semiont.operations import BROWSE_RESOURCE_REQUESTED, JOB_LIMITS_REQUESTED
from semiont.transport import Transport
from semiont.types import Agent, AgentSoftware, JobFilter, PrincipalProfileCommand, WorkerEngineConfig
from semiont_inference.interface import InferenceClient
from semiont_inference.limits_report import answer_limits_requests

from semiont_worker.held_job import run_job
from semiont_worker.log import LOG

WORKER_CHANNELS: Final[tuple[str, ...]] = (
    *JOB_CLAIM_CHANNELS,
    # Every job that makes annotations commits them, and waits for the record to have them.
    *JOB_COMMIT_CHANNELS,
    # What this service itself awaits: a resource's description.
    *reply_channels_for(BROWSE_RESOURCE_REQUESTED),
    # What this service answers: the limits of its engines.
    JOB_LIMITS_REQUESTED.request.name,
)
"""What the agent's stream names: what the SDK's claiming and committing read, the replies of what it asks, and the request it answers."""


def exit_for_restart() -> NoReturn:
    """End the process at once, with status 1, for whatever supervises it to start it again.

    Nothing more is said on the bus: a job still held stays with the
    dispatcher, whose sweep concludes it.
    """
    sys.stdout.flush()
    os._exit(1)


def _instant(at: datetime | None) -> str | None:
    """A moment as the health endpoint says one: to the millisecond, in UTC."""
    return None if at is None else at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _as_claimed(accepts: Sequence[JobFilter]) -> list[JsonValue]:
    """Filters of jobs, as a claim states them."""
    return [written(accepted) for accepted in accepts]


def engine_of(entry: WorkerEngineConfig) -> dict[str, JsonValue]:
    """An engine as the log says one: its provider and model, and the jobs the agent does with it."""
    return {"provider": entry.engine.provider, "model": entry.engine.model, "jobs": _as_claimed(entry.jobs)}


async def run_what_is_claimed(
    client: SemiontClient[Transport], claims: Claims, *, inference: InferenceClient, generator: Agent, accepts: Sequence[JobFilter]
) -> None:
    """Run each job `claims` hands out, one at a time, until the claiming ends.

    A claim refused as unauthorized ends the process: it is a verdict about
    the service's account, which no later claim changes, and a service
    parked for good would have nothing in its log saying why. A claim
    refused for any other reason is said in the log, and the engine claims
    again at its next idle moment.
    """
    async for handed in claims:
        if isinstance(handed, ClaimRefusal):
            if handed.code == "bus.unauthorized":
                LOG.error(
                    "Claim refused: this worker is not authorized to claim jobs \N{EM DASH} exiting for restart",
                    extra={"code": handed.code, "refusal": handed.message, "accepts": _as_claimed(accepts)},
                )
                exit_for_restart()
            LOG.warning("Claim declined; parked until the next wake-up", extra={"code": handed.code, "refusal": handed.message})
            continue
        await run_job(handed, client=client, inference=inference, generator=generator, accepts=accepts)


async def watch_for_a_stall(claims: Claims, agent: UserId) -> None:
    """End the process when the job `claims` holds stalls.

    A held job that shows no activity is wedged: an engine that never settles
    never claims again. The dispatcher's sweep of running jobs concludes the
    job, and whatever supervises the service starts it again.
    """
    async for stall in claims.stalled:
        if stall is None:
            continue
        LOG.error(
            "Worker stalled \N{EM DASH} exiting for restart",
            extra={
                "agent": agent,
                "jobId": stall.job_id,
                "jobType": stall.job_type,
                "processingSince": _instant(stall.held_since),
                "lastActivityAt": _instant(stall.last_activity_at),
                "silentForMs": stall.silent_for_ms,
                "thresholdMs": stall.threshold_ms,
            },
        )
        exit_for_restart()


@final
class EngineAtWork:
    """One engine at work: its entry of the configuration document, the client of its provider and model, and its claims.

    It claims with its entry's `jobs` and no other filter, and runs each job
    it is handed with its engine, one at a time.
    """

    def __init__(self, entry: WorkerEngineConfig, inference: InferenceClient, claims: Claims) -> None:
        self._entry: Final = entry
        self.inference: Final = inference
        self._claims: Final = claims
        self._stopping = False

    def vitals(self) -> dict[str, JsonValue]:
        """What the engine says of itself to the health endpoint: which it is, the jobs it does, and what its claims say of themselves."""
        said = self._claims.vitals()
        active = said.active_job
        return {
            "provider": self._entry.engine.provider,
            "model": self._entry.engine.model,
            "jobs": _as_claimed(self._entry.jobs),
            "lastQueuedEventAt": _instant(said.last_queued_event_at),
            "lastClaimAt": _instant(said.last_claim_at),
            "lastFinishedAt": _instant(said.last_finished_at),
            "lastActivityAt": _instant(said.last_activity_at),
            "activeJob": None if active is None else {"jobId": active.job_id, "type": active.job_type, "since": _instant(active.since)},
            "jobsCompleted": said.jobs_completed,
        }

    async def work(self, client: SemiontClient[Transport], agent: UserId) -> None:
        """Claim the engine's jobs and run each, one at a time, until it is stopped.

        It returns once `stop` has ended the claiming. Anything else that
        ends it is raised: an engine that cannot claim does not stay up.
        """
        engine = self._entry.engine
        # What everything the engine makes says made it: the agent, by the DID the gateway named it with, and the engine.
        generator: Agent = AgentSoftware(type="Software", id=agent, provider=engine.provider, model=engine.model)
        try:
            async with asyncio.TaskGroup() as working:
                watching = working.create_task(watch_for_a_stall(self._claims, agent))
                await run_what_is_claimed(client, self._claims, inference=self.inference, generator=generator, accepts=self._entry.jobs)
                watching.cancel()
        except* Exception as failed:
            # What ended the engine's work, as itself: the watching ended because it did.
            raise failed.exceptions[0] from None
        if not self._stopping:
            raise RuntimeError("the agent's stream ended: nothing more can be claimed")

    async def stop(self) -> None:
        """Stop claiming. A job still held is failed first, so the queue retries it now and does not wait for its sweep."""
        self._stopping = True
        await self._claims.aclose()


@final
class AgentWorker:
    """The service's agent at work. Held with `async with`: signed in inside, and signed out on the way out.

    `engines` are the entries of the configuration document, each with the
    client of its provider and model, in the document's order. `service` is
    the service's account, which the agent signs in as, and `name` what the
    agent says it is called, which it states when it opens its stream.

    Signing in opens no stream. `open` does, once the service has everything
    else it needs to start: the stream, the client over it and each engine's
    claims are then the agent's until the way out.
    """

    def __init__(
        self, engines: Sequence[tuple[WorkerEngineConfig, InferenceClient]], *, gateway_url: str, service: ServiceToken, name: str
    ) -> None:
        self._engines: Final = tuple(engines)
        self._name: Final = name
        self._gateway_url: Final = gateway_url
        self._service: Final = service
        self._held: Final = AsyncExitStack()
        self._token: AgentToken | None = None
        self._opened: tuple[SemiontClient[HttpTransport], tuple[EngineAtWork, ...]] | None = None

    async def __aenter__(self) -> Self:
        self._token = await self._held.enter_async_context(AgentToken(self._gateway_url, service=self._service))
        LOG.info("Agent ready", extra={"did": self._token.did, "engines": [engine_of(entry) for entry, _ in self._engines]})
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self._held.aclose()

    def _signed_in(self) -> AgentToken:
        if self._token is None:
            raise RuntimeError("the agent is not signed in: hold it with `async with`")
        return self._token

    async def open(self) -> None:
        """Open the agent's stream and its client over it, and say what the agent is called.

        Each engine's claiming begins when the agent is put to work.
        """
        token = self._signed_in()
        transport = await self._held.enter_async_context(
            HttpTransport(self._gateway_url, token=token.token, refresher=token.refresh, channels=WORKER_CHANNELS)
        )
        client = await self._held.enter_async_context(SemiontClient(transport, transport.content, transport))
        await client.wire.emit(PRINCIPAL_PROFILE, PrincipalProfileCommand(name=self._name))
        self._opened = (client, tuple(EngineAtWork(entry, inference, client.job.claim(entry.jobs)) for entry, inference in self._engines))

    def _at_work(self) -> tuple[UserId, SemiontClient[HttpTransport], tuple[EngineAtWork, ...]]:
        if self._opened is None:
            raise RuntimeError("the agent's stream is not open: `open` it")
        client, engines = self._opened
        return self._signed_in().did, client, engines

    def vitals(self) -> dict[str, JsonValue]:
        """What the agent says of itself to the health endpoint: who it is, and what each engine says of itself."""
        did, _, engines = self._at_work()
        return {"did": did, "engines": [engine.vitals() for engine in engines]}

    async def work(self) -> None:
        """Answer for the limits of every engine, and claim for each engine and run what it is handed, until the agent is stopped.

        It returns once `stop` has ended every engine's claiming. Anything
        else that ends one engine's is raised, and ends the others'.
        """
        did, client, engines = self._at_work()
        try:
            async with asyncio.TaskGroup() as working:
                answering = working.create_task(
                    answer_limits_requests(client.wire, JOB_LIMITS_REQUESTED, [engine.inference for engine in engines])
                )
                await asyncio.gather(*(working.create_task(engine.work(client, did)) for engine in engines))
                answering.cancel()
        except* Exception as failed:
            # What ended the agent's work, as itself: the others ended because it did.
            raise failed.exceptions[0] from None

    async def stop(self) -> None:
        """Stop every engine's claiming. A job still held is failed first, so the queue retries it now."""
        _, _, engines = self._at_work()
        await asyncio.gather(*(engine.stop() for engine in engines))
