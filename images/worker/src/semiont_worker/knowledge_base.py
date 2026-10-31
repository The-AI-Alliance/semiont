"""Each knowledge base the service serves, apart from every other: started, confirmed, worked at, and started again or left refused.

`docs/protocol/WORKER-SERVICE.md` § Knowledge bases states it. What happens at
one knowledge base happens there alone. The service starts every one at once,
and each is, at any moment, `starting` (signing in, opening its stream,
confirming it, or waiting to start again), `working` (confirmed, its engines
claiming), or `refused`.

The agent at a knowledge base (`semiont_worker.agent`) says what ended its
work there. A refusal is said once in the log, at `error`, and the knowledge
base stays refused until the service is started again. Trouble is said at
`warning`, with the wait before the knowledge base is started again, signed
in afresh: the SDK's `reconnectMs`, twice the wait before it each further
time, up to `maxReconnectMs`, and `reconnectMs` again once it has been
confirmed again. Every other knowledge base keeps its stream and its jobs
throughout. A service every knowledge base of which has refused it has
nothing left to do, and ends.
"""

import asyncio
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final, Literal, final

from semiont.http import KeyCredential, ServiceToken
from semiont.timing import MAX_RECONNECT_MS, RECONNECT_MS
from semiont.types import WorkerHealth, WorkerKnowledgeBaseConfig, WorkerKnowledgeBaseHealth, WorkerKnowledgeBaseHealthState
from semiont_inference.interface import InferenceClient
from semiont_service.config import Refused

from semiont_worker.agent import AgentWorker, KnowledgeBaseRefused, KnowledgeBaseTrouble, engine_of
from semiont_worker.log import LOG

NO_KNOWLEDGE_BASE_ADMITS: Final = "No knowledge base admits this worker: each of its knowledgeBases refused it"
"""Why a service every knowledge base of which refused it, none of them confirmed first, did not start (R5)."""


@final
@dataclass(frozen=True, slots=True)
class Served:
    """A knowledge base of the document, as the service is started for it.

    Its entry; the account the service signs in as there; and a client of
    each of its engines' providers and models, in its entry's order.
    """

    entry: WorkerKnowledgeBaseConfig
    credential: KeyCredential
    clients: tuple[InferenceClient, ...]


@final
class KnowledgeBase:
    """One knowledge base the service serves, supervised: its state, what it says of itself, and its work, life after life.

    `confirmed` is told each time the knowledge base is confirmed.
    """

    def __init__(self, served: Served, *, confirmed: Callable[[], None]) -> None:
        self._served: Final = served
        self._confirmed: Final = confirmed
        self._state: WorkerKnowledgeBaseHealthState = "starting"
        self._agent: AgentWorker | None = None
        """The agent at work there, once it is confirmed and for as long as it works."""

    @property
    def state(self) -> WorkerKnowledgeBaseHealthState:
        return self._state

    def health(self) -> WorkerKnowledgeBaseHealth:
        """What the health endpoint says of it: its domain and state, and, while it is working, the agent's DID there and its engines."""
        if self._agent is not None:
            return self._agent.health()
        return WorkerKnowledgeBaseHealth(domain=self._served.entry.domain, state=self._state)

    async def run(self) -> None:
        """Work at the knowledge base until it refuses the service, or is stopped: trouble ends a life, and another begins after a wait.

        A failure nothing classifies is raised.
        """
        entry = self._served.entry
        wait_ms = RECONNECT_MS
        while True:
            LOG.info(
                "Starting the agent",
                extra={"domain": entry.domain, "baseUrl": entry.gateway_url, "engines": [engine_of(engine) for engine in entry.engines]},
            )
            # Each life signs in afresh: nothing of the last one's account is kept.
            agent = AgentWorker(entry, self._served.clients, service=ServiceToken(self._served.credential))
            try:
                async with agent:
                    await agent.open()
                    LOG.info("Knowledge base confirmed", extra={"domain": entry.domain, "did": agent.did})
                    self._agent, self._state = agent, "working"
                    wait_ms = RECONNECT_MS
                    self._confirmed()
                    await agent.work()
                # Its work returns only when it was stopped.
                return
            except KnowledgeBaseRefused as refused:
                self._agent, self._state = None, "refused"
                LOG.error("Knowledge base refused the worker", extra={"domain": entry.domain, "reason": str(refused)})
                return
            except KnowledgeBaseTrouble as trouble:
                self._agent, self._state = None, "starting"
                LOG.warning(
                    "Knowledge base in trouble \N{EM DASH} starting it again",
                    extra={"domain": entry.domain, "error": str(trouble), "waitMs": wait_ms},
                )
            await asyncio.sleep(wait_ms / 1000)
            wait_ms = min(wait_ms * 2, MAX_RECONNECT_MS)

    async def stop(self) -> None:
        """Stop its engines' claiming: a job held there is failed first, and no other claimed. Its `run` returns, or ends where it waits."""
        agent = self._agent
        if agent is not None:
            await agent.stop()


@final
class KnowledgeBases:
    """Every knowledge base of the document, at work at once, in its order."""

    def __init__(self, served: Sequence[Served]) -> None:
        self._first_confirmed: Final = asyncio.Event()
        self._each: Final = tuple(KnowledgeBase(one, confirmed=self._first_confirmed.set) for one in served)

    @property
    def each(self) -> tuple[KnowledgeBase, ...]:
        return self._each

    async def confirmed(self) -> None:
        """Return once a knowledge base has been confirmed, the first time any is."""
        await self._first_confirmed.wait()

    def health(self) -> WorkerHealth:
        """What the health endpoint answers: each knowledge base, in the document's order."""
        return WorkerHealth(status="ok", knowledge_bases=[knowledge_base.health() for knowledge_base in self._each])

    async def work(self, told_to_stop: asyncio.Event) -> int:
        """Work at every knowledge base until the service is told to stop, or every one has refused it: the status the process exits with.

        Told to stop, each stops, failing a job still held there first, and
        the status is 0. Every one refused, it is 1, for whatever supervises
        the service to start it again with a document or a grant that has
        changed. Where none was confirmed first, it raises `Refused` instead,
        for the service to say as it says every refusal to start. A failure
        nothing classifies, at any of them, is raised.
        """
        stopping = asyncio.ensure_future(told_to_stop.wait())
        running = [asyncio.ensure_future(knowledge_base.run()) for knowledge_base in self._each]
        waiting: set[asyncio.Task[None] | asyncio.Task[Literal[True]]] = {stopping, *running}
        try:
            while waiting != {stopping}:
                ended, waiting = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
                if stopping in ended:
                    LOG.info("Shutting down")
                    await asyncio.gather(*(knowledge_base.stop() for knowledge_base in self._each))
                    return 0
                for refused in ended:
                    # A knowledge base whose work returned unstopped refused the service; one whose work raised, raises.
                    refused.result()
        finally:
            for task in (stopping, *running):
                task.cancel()
            await asyncio.gather(stopping, *running, return_exceptions=True)
        if not self._first_confirmed.is_set():
            raise Refused(NO_KNOWLEDGE_BASE_ADMITS)
        return 1
