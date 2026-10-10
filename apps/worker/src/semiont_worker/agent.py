"""One agent of the service: a provider and a model, signed in as itself, claiming the jobs it serves and running each.

The service works as one agent for each entry of its configuration document
(`docs/protocol/WORKER-SERVICE.md` § Agents). Each signs in for itself: the
service's account is exchanged at the gateway for the agent's token, and the
DID the gateway answers is who the agent is. It is used as answered and
derived from nothing else: derived from the address the service happens to
dial, one agent would have two.

Each agent has a stream of its own, which names what a worker reads and no
more. The replies of every operation a client can ask reach every stream that
names them, and a worker that named them all would be sent every other
client's answers.
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
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS, ClaimRefusal, Claims
from semiont.client import SemiontClient
from semiont.http import AgentToken, HttpTransport, ServiceToken
from semiont.identifiers import UserId
from semiont.identity import agent_name
from semiont.model import written
from semiont.operations import BROWSE_ANCHORED_TEXT_REQUESTED, BROWSE_RESOURCE_REQUESTED, JOB_LIMITS_REQUESTED
from semiont.transport import Transport
from semiont.types import Agent, AgentSoftware, JobFilter, WorkerAgentConfig
from semiont_inference.interface import InferenceClient
from semiont_inference.limits_report import answer_limits_requests

from semiont_worker.held_job import run_job
from semiont_worker.log import LOG

WORKER_CHANNELS: Final[tuple[str, ...]] = (
    *JOB_CLAIM_CHANNELS,
    # Every job that makes annotations commits them, and waits for the record to have them.
    *JOB_COMMIT_CHANNELS,
    # What this service itself awaits: a resource's description, and the Smelter's text of a PDF.
    *reply_channels_for(BROWSE_RESOURCE_REQUESTED, BROWSE_ANCHORED_TEXT_REQUESTED),
)
"""What every agent's stream names: what the SDK's claiming and committing read, and the replies of what this service asks."""


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
    """The jobs an agent serves, as a claim states them."""
    return [written(accepted) for accepted in accepts]


async def run_what_is_claimed(
    client: SemiontClient[Transport], claims: Claims, *, inference: InferenceClient, generator: Agent, accepts: Sequence[JobFilter]
) -> None:
    """Run each job `claims` hands out, one at a time, until the claiming ends.

    A claim refused as unauthorized ends the process: it is a verdict about
    the service's account, which no later claim changes, and a service
    parked for good would have nothing in its log saying why. A claim
    refused for any other reason is said in the log, and the agent claims
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

    A held job that shows no activity is wedged: an agent that never settles
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
class AgentWorker:
    """One agent at work. Held with `async with`: signed in and on its stream inside, and signed out on the way out.

    `entry` is its entry of the configuration document and `inference` the
    client of its provider and model. `answers_limits_of` are the clients
    whose limits this agent answers a request for: every agent's, for the one
    agent that answers for the service, and none for the rest. The gateway
    delivers the first reply to a request, so one agent answers.
    """

    def __init__(
        self,
        entry: WorkerAgentConfig,
        inference: InferenceClient,
        *,
        gateway_url: str,
        service: ServiceToken,
        answers_limits_of: Sequence[InferenceClient],
    ) -> None:
        self._entry: Final = entry
        self._inference: Final = inference
        self._gateway_url: Final = gateway_url
        self._service: Final = service
        self._answers_limits_of: Final = tuple(answers_limits_of)
        self._held: Final = AsyncExitStack()
        self._signed_in: tuple[UserId, SemiontClient[HttpTransport], Claims] | None = None
        self._stopping = False

    async def __aenter__(self) -> Self:
        engine = self._entry.agent
        token = await self._held.enter_async_context(
            AgentToken(self._gateway_url, provider=engine.provider, model=engine.model, service=self._service)
        )
        channels = (*WORKER_CHANNELS, JOB_LIMITS_REQUESTED.request.name) if self._answers_limits_of else WORKER_CHANNELS
        transport = await self._held.enter_async_context(
            HttpTransport(self._gateway_url, token=token.token, refresher=token.refresh, channels=channels)
        )
        client = await self._held.enter_async_context(SemiontClient(transport, transport.content, transport))
        self._signed_in = (token.did, client, client.job.claim(self._entry.accepts))
        LOG.info(
            "Agent ready",
            extra={"did": token.did, "provider": engine.provider, "model": engine.model, "serves": _as_claimed(self._entry.accepts)},
        )
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self._held.aclose()

    def _at_work(self) -> tuple[UserId, SemiontClient[HttpTransport], Claims]:
        if self._signed_in is None:
            raise RuntimeError("the agent is not signed in: hold it with `async with`")
        return self._signed_in

    def vitals(self) -> dict[str, JsonValue]:
        """What the agent says of itself to the health endpoint: who it is, what it serves, and what its claims say of themselves."""
        did, _, claims = self._at_work()
        said = claims.vitals()
        active = said.active_job
        return {
            "provider": self._entry.agent.provider,
            "model": self._entry.agent.model,
            "did": did,
            "serves": _as_claimed(self._entry.accepts),
            "lastQueuedEventAt": _instant(said.last_queued_event_at),
            "lastClaimAt": _instant(said.last_claim_at),
            "lastFinishedAt": _instant(said.last_finished_at),
            "lastActivityAt": _instant(said.last_activity_at),
            "activeJob": None if active is None else {"jobId": active.job_id, "type": active.job_type, "since": _instant(active.since)},
            "jobsCompleted": said.jobs_completed,
        }

    async def work(self) -> None:
        """Claim the jobs the agent serves and run each, one at a time, until it is stopped.

        It returns once `stop` has ended the claiming. Anything else that
        ends it is raised: an agent that cannot claim does not stay up.
        """
        did, client, claims = self._at_work()
        engine = self._entry.agent
        # What everything the agent makes says made it: the agent, by the DID the gateway named it with.
        generator: Agent = AgentSoftware(
            type="Software", id=did, name=agent_name(engine.provider, engine.model), provider=engine.provider, model=engine.model
        )
        try:
            async with asyncio.TaskGroup() as working:
                watching = working.create_task(watch_for_a_stall(claims, did))
                answering = (
                    working.create_task(answer_limits_requests(client.wire, JOB_LIMITS_REQUESTED, self._answers_limits_of))
                    if self._answers_limits_of
                    else None
                )
                await run_what_is_claimed(client, claims, inference=self._inference, generator=generator, accepts=self._entry.accepts)
                watching.cancel()
                if answering is not None:
                    answering.cancel()
        except* Exception as failed:
            # What ended the agent's work, as itself: the others ended because it did.
            raise failed.exceptions[0] from None
        if not self._stopping:
            raise RuntimeError("the agent's stream ended: nothing more can be claimed")

    async def stop(self) -> None:
        """Stop claiming. A job still held is failed first, so the queue retries it now and does not wait for its sweep."""
        _, _, claims = self._at_work()
        self._stopping = True
        await claims.aclose()
