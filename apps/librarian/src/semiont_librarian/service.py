"""The Librarian service as a process: what it is started with, how it refuses to start, the order it starts in, and how it stops.

It is started with the path of its configuration document (`--config`), its
own account at the issuer (`SEMIONT_OIDC_CLIENT_ID` and
`SEMIONT_OIDC_CLIENT_SECRET`), and the variables its document names: for the
graph database's password, for its embedding provider's key, and for the key
of each actor's model, where one is taken. Beside those it reads the
variables that say where its telemetry goes, and no other. This is the one
module that reads the process's environment and its arguments: everything
else is handed what it needs.

Everything it is started with is read before anything is dialled, so a
service that cannot start says so while an operator is watching it boot: one
line on stderr that begins `[fatal] `, and status 1. Once it has started,
everything it writes is its log, on stdout.

It starts in the order `docs/protocol/LIBRARIAN.md` § Boot states: it signs
in as the agent `(semiont, librarian)`, reaches the graph database and the
vector index, begins to take requests from the bus, and opens its health
port last, so a Librarian whose health answers is answering. It loads
nothing and makes nothing: it reads what other services write. Told to stop,
it stops taking requests, closes what it holds open, and exits with status 0.
"""

import asyncio
import os
import signal
import sys
import time
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, final, override

from pydantic import JsonValue
from semiont.channels import SMELT_SETTLED, WEAVE_APPLIED
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.identifiers import ResourceId
from semiont.operations import (
    GATHER_LIMITS_REQUESTED,
    GATHER_REFERENCED_BY_REQUESTED,
    GATHER_REQUESTED,
    GATHER_RESOURCE_REQUESTED,
    GATHER_SUMMARY_REQUESTED,
    MATCH_LIMITS_REQUESTED,
    MATCH_RESOURCES_REQUESTED,
    MATCH_SEARCH_REQUESTED,
)
from semiont.transport import ContentTransport
from semiont.types import AnchoredTextAnswer, LibrarianConfig
from semiont_graph.factory import create_graph_reader
from semiont_graph.interface import GraphReader
from semiont_inference.factory import create_inference_client
from semiont_inference.interface import InferenceClient
from semiont_service.archivist import ArchivistContent
from semiont_service.config import Refused, config_path_of, service_account_of
from semiont_service.health import bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.factory import create_embedding_provider, create_vector_reader
from semiont_vectors.store import VectorReader

from semiont_librarian.config import SERVICE, api_key_of, embedding_key_of, graph_password_of, read_librarian_config
from semiont_librarian.librarian import Librarian, words_of
from semiont_librarian.log import LOG
from semiont_librarian.progress import SmeltProgress, WeaveProgress
from semiont_librarian.reads import AnchoredText
from semiont_librarian.record import FilePeople, FileViews
from semiont_librarian.telemetry import GatherDegraded

__all__ = ["CHANNELS", "boot", "health", "main"]

CHANNELS: Final[tuple[str, ...]] = (
    MATCH_SEARCH_REQUESTED.request.name,
    MATCH_RESOURCES_REQUESTED.request.name,
    MATCH_LIMITS_REQUESTED.request.name,
    GATHER_REQUESTED.request.name,
    GATHER_RESOURCE_REQUESTED.request.name,
    GATHER_SUMMARY_REQUESTED.request.name,
    GATHER_REFERENCED_BY_REQUESTED.request.name,
    GATHER_LIMITS_REQUESTED.request.name,
    WEAVE_APPLIED.name,
    SMELT_SETTLED.name,
)
"""What the Librarian's stream names: the eight requests it answers and the two signals it follows.

No reply channel is among them: it asks nothing over the bus.
"""

_PROVIDER: Final = "semiont"
_MODEL: Final = "librarian"
"""Who the Librarian works as: one agent, `(semiont, librarian)`, whatever models its two actors ask."""

_CONNECT_SECONDS: Final = 60.0
"""How long the graph database and the vector index are each given to answer when the service starts.

Past it the service exits, to be started again.
"""


def health() -> JsonValue:
    """What `GET /health` answers: that the service is up, and the two actors it runs."""
    actors: list[JsonValue] = ["matcher", "gatherer"]
    return {"status": "ok", "actors": actors}


@final
class _AskedOfTheGateway(AnchoredText):
    """A resource's anchored text, asked of the gateway's content routes, over the address and the token the bus is reached by."""

    def __init__(self, content: ContentTransport) -> None:
        self._content: Final = content

    @override
    async def ask(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        return await self._content.get_anchored_text(resource_id)


def _now() -> datetime:
    """The moment it is, in UTC: what a reference search counts recency from."""
    return datetime.now(UTC)


@final
@dataclass(frozen=True, slots=True)
class _Started:
    """Everything the service is started with: its document, its account, the stores it reads, not yet connected, and its providers."""

    config: LibrarianConfig
    credential: Credential
    graph: GraphReader
    vectors: VectorReader
    embedding: EmbeddingProvider
    matcher: InferenceClient
    gatherer: InferenceClient


def boot(arguments: Sequence[str], environment: Mapping[str, str]) -> _Started:
    """Read everything the service is started with, and raise for what it cannot start on. Nothing is dialled."""
    config = read_librarian_config(config_path_of(SERVICE, arguments))
    # What is written from the document's level: the service's own code, the stores', the drivers' and the SDK's.
    own = (LOG.name, "semiont_graph", "semiont_vectors", "semiont_inference", "semiont")
    configure(SERVICE, config.log_level, config.log_format, own=own)
    credential = service_account_of(SERVICE, config.identity.issuer, environment)
    # A reader of the graph: connecting it makes no constraint and no index there.
    graph = create_graph_reader(config.graph, password=graph_password_of(config, environment))
    embedding = create_embedding_provider(config.embedding, api_key=embedding_key_of(config, environment))
    # A reader of the index: it is told no width, because it makes nothing there.
    vectors = create_vector_reader(config.vectors)
    matcher = create_inference_client(
        provider=config.matcher.agent.provider,
        model=config.matcher.agent.model,
        base_url=config.matcher.base_url,
        api_key=api_key_of("matcher", config.matcher, environment),
    )
    gatherer = create_inference_client(
        provider=config.gatherer.agent.provider,
        model=config.gatherer.agent.model,
        base_url=config.gatherer.base_url,
        api_key=api_key_of("gatherer", config.gatherer, environment),
    )
    return _Started(
        config=config, credential=credential, graph=graph, vectors=vectors, embedding=embedding, matcher=matcher, gatherer=gatherer
    )


async def _reached(what: str, connecting: Awaitable[None]) -> None:
    """Wait for a store to answer as the service starts. Refused, saying which store, where it does not within the bound."""
    try:
        async with asyncio.timeout(_CONNECT_SECONDS):
            await connecting
    except TimeoutError:
        raise Refused(f"The {what} did not answer within {_CONNECT_SECONDS:.0f} seconds") from None


async def _listening(port: int) -> asyncio.Server:
    """The health endpoint, holding its port and answering nothing yet. Refused where the port cannot be taken."""
    try:
        return await bind_health(port, health)
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {port}: {unheard}") from unheard


async def _serve(started: _Started, exporting: Exporting | None) -> None:
    """Answer what the bus asks until the process is told to stop. `exporting` is the process's telemetry, where it exports any."""
    config = started.config
    loop = asyncio.get_running_loop()
    told_to_stop = asyncio.Event()
    for told in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(told, told_to_stop.set)

    account = ServiceToken(started.credential)
    # Where the Archivist keeps the knowledge base's views and its people projection, in the state volume.
    state_dir = Path(config.state_home) / "semiont" / config.kb_name

    async with AgentToken(config.gateway_url, provider=_PROVIDER, model=_MODEL, service=account) as agent:
        LOG.info("Agent ready", extra={"did": agent.did})
        try:
            await _reached("graph database", started.graph.connect())
            LOG.info("Graph database ready", extra={"type": config.graph.type})
            await _reached("vector index", started.vectors.connect())
            LOG.info("Vector index ready", extra={"type": config.vectors.type})
            async with (
                ArchivistContent(SERVICE, host=config.archivist.host, port=config.archivist.port, account=account) as content,
                HttpTransport(config.gateway_url, token=agent.token, refresher=agent.refresh, channels=CHANNELS) as transport,
                Librarian(
                    views=FileViews(state_dir),
                    people=FilePeople(state_dir),
                    graph=started.graph,
                    vectors=started.vectors,
                    embedding=started.embedding,
                    matcher=started.matcher,
                    gatherer=started.gatherer,
                    content=content,
                    anchored=_AskedOfTheGateway(transport.content),
                    # How old what a fold keeps is, is told by a clock that only goes forward.
                    weave=WeaveProgress(time.monotonic),
                    smelt=SmeltProgress(time.monotonic),
                    degraded=GatherDegraded(),
                    now=_now,
                    # The document states milliseconds, and they are divided here, once.
                    settle_within=config.gather.settle_timeout_ms / 1000,
                    semantic_floor=config.search.semantic_floor,
                    transport=transport,
                ),
            ):
                LOG.info("Taking requests", extra={"channels": len(CHANNELS)})
                # The port is taken once the Librarian takes frames, and not before: whatever waits on its health waits
                # on a Librarian that is answering.
                listening = await _listening(config.port)
                try:
                    await listening.start_serving()
                    LOG.info("Health endpoint ready", extra={"port": config.port})

                    sampling = None if exporting is None else asyncio.ensure_future(exporting.sample_the_loop())
                    try:
                        await told_to_stop.wait()
                        LOG.info("Shutting down")
                    finally:
                        if sampling is not None:
                            sampling.cancel()
                            await asyncio.gather(sampling, return_exceptions=True)
                except Exception:
                    # A failure nothing caught, in a service that had started: it is counted, and the process exits for it.
                    if exporting is not None:
                        exporting.died()
                    raise
                finally:
                    listening.close()
                    await listening.wait_closed()
        finally:
            await started.vectors.disconnect()
            await started.graph.disconnect()


def main() -> int:
    """Run the service, and answer the status the process exits with."""
    exporting: Exporting | None = None
    try:
        started = boot(sys.argv[1:], os.environ)
        exporting = install(SERVICE, os.environ)
        asyncio.run(_serve(started, exporting))
    except Exception as failure:
        # Whatever ends the service that was not its being told to stop is said once, as every service says it.
        sys.stderr.write(f"[fatal] {failure if isinstance(failure, Refused) else words_of(failure)}\n")
        return 1
    finally:
        if exporting is not None:
            exporting.shutdown()
    return 0
