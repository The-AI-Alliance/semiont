"""The Smelter service as a process: what it is started with, how it refuses to start, the order it starts in, and how it stops.

It is started with the path of its configuration document (`--config`), its
own account at the issuer (`SEMIONT_OIDC_CLIENT_ID` and
`SEMIONT_OIDC_CLIENT_SECRET`), and the variable its document names for its
embedding provider's key, where the provider takes one. Beside those it reads
the variables that say where its telemetry goes, and no other. This is the
one module that reads the process's environment and its arguments:
everything else is handed what it needs.

Everything it is started with is read before anything is dialled, so a
service that cannot start says so while an operator is watching it boot: one
line on stderr that begins `[fatal] `, and status 1. Once it has started,
everything it writes is its log, on stdout.

It starts in the order `docs/protocol/SMELTER.md` § Boot states: it signs in
as the agent its embedding provider and its model name, reaches its vector
index, which asks its provider how wide a vector is where the index has to be
made, makes the index again where it was made by another model or cut another
way, follows the record, opens its health port, and then runs reconcile. A
reconcile that fails is said, in the log and at the health port, and does
not end the service: ending it would make the index no fresher, and would
take away the one thing still applying what arrives. Told to stop, it stops
applying, closes what it holds open, and exits with status 0.
"""

import asyncio
import os
import signal
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Final, final

from semiont.bus import reply_channels_for
from semiont.channels import SMELT_REBUILD_ANCHORS
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.types import SmelterConfig
from semiont_service.archivist import ArchivistContent
from semiont_service.config import Refused, config_path_of, service_account_of
from semiont_service.connect import connected
from semiont_service.health import Health, bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.factory import create_embedding_provider, create_vector_store
from semiont_vectors.store import VectorStore

from semiont_smelter.anchored_text_store import AnchoredTextStore
from semiont_smelter.chunking import Chunking
from semiont_smelter.config import SERVICE, embedding_key_of, read_smelter_config
from semiont_smelter.extraction import PdfExtractor
from semiont_smelter.index_stamp import hold_to, stamp_of
from semiont_smelter.log import LOG, words_of
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.record import READ
from semiont_smelter.recorded import FOLLOWED
from semiont_smelter.smelter import Smelter
from semiont_smelter.stamp import current_stamp
from semiont_smelter.telemetry import points_held
from semiont_smelter.tesseract import TesseractEngine

__all__ = ["CHANNELS", "boot", "main"]

CHANNELS: Final[tuple[str, ...]] = (*FOLLOWED, SMELT_REBUILD_ANCHORS.name, *reply_channels_for(*READ))
"""What the Smelter's stream names: the events it follows, the command it answers, and the replies of what it asks."""


@final
@dataclass(frozen=True, slots=True)
class _Started:
    """Everything the service is started with: its document, its account, its provider, and the store of its index, not yet connected."""

    config: SmelterConfig
    credential: Credential
    provider: EmbeddingProvider
    index: VectorStore


def boot(arguments: Sequence[str], environment: Mapping[str, str]) -> _Started:
    """Read everything the service is started with, and raise for what it cannot start on. Nothing is dialled."""
    config = read_smelter_config(config_path_of(SERVICE, arguments))
    # What is written from the document's level: the service's own code, the vector stores' and the SDK's.
    configure(SERVICE, config.log_level, config.log_format, own=(LOG.name, "semiont_vectors", "semiont"))
    credential = service_account_of(SERVICE, config.identity.issuer, environment)
    provider = create_embedding_provider(config.embedding, api_key=embedding_key_of(config, environment))
    # The index is as wide as the model's vectors, which the store asks the provider when it has to make the index.
    index = create_vector_store(config.vectors, dimensions=provider.dimensions)
    return _Started(config=config, credential=credential, provider=provider, index=index)


async def _listening(port: int, health: Health) -> asyncio.Server:
    """The health endpoint, holding its port and answering nothing yet. Refused where the port cannot be taken."""
    try:
        return await bind_health(port, health)
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {port}: {unheard}") from unheard


async def _reached(index: VectorStore, config: SmelterConfig) -> None:
    """Reach the index, and hold it to what this Smelter makes one by: one made by another model, or cut another way, is made again."""
    await index.connect()
    await hold_to(index, stamp_of(config))


async def _reconciled(smelter: Smelter) -> None:
    """Run the reconcile of this start. One that fails has said so, in the log and in what the health endpoint reports, and ends nothing."""
    try:
        await smelter.reconcile()
    except Exception as failure:
        LOG.error("Reconcile failed: continuing with an index that may be behind", extra={"error": words_of(failure)})


async def _serve(started: _Started, exporting: Exporting | None) -> None:
    """Follow the record until the process is told to stop. `exporting` is the process's telemetry, where it exports any."""
    config = started.config
    loop = asyncio.get_running_loop()
    told_to_stop = asyncio.Event()
    for told in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(told, told_to_stop.set)

    account = ServiceToken(started.credential)
    reader, engine = PdfiumReader(), TesseractEngine()
    # The stamp is read from what is installed. A Smelter with no OCR engine to ask says so here, before it follows anything.
    anchored = AnchoredTextStore(Path(config.anchored_text_dir), stamp=await current_stamp(reader, engine))

    # It works as the agent its embedding provider and its model name: two Smelters that embed with different models are two agents.
    async with AgentToken(config.gateway_url, provider=config.embedding.type, model=config.embedding.model, service=account) as agent:
        LOG.info("Agent ready", extra={"did": agent.did})
        await connected("vector index and the embedding provider", _reached(started.index, config))
        LOG.info("Vector index ready", extra={"type": config.vectors.type})
        try:
            async with (
                ArchivistContent(SERVICE, host=config.archivist.host, port=config.archivist.port, account=account) as content,
                HttpTransport(config.gateway_url, token=agent.token, refresher=agent.refresh, channels=CHANNELS) as transport,
                Smelter(
                    index=started.index,
                    provider=started.provider,
                    content=content,
                    extractor=PdfExtractor(reader=reader, engine=engine),
                    anchored=anchored,
                    transport=transport,
                    chunking=Chunking(chunk_size=config.chunking.chunk_size, overlap=config.chunking.overlap),
                ) as smelter,
            ):
                LOG.info("Following the record")
                health = await _listening(
                    config.port,
                    lambda: {"status": "ok", "eventsProcessed": smelter.events_processed, "reconcile": smelter.reconcile_state.said()},
                )
                try:
                    await health.start_serving()
                    LOG.info("Health endpoint ready", extra={"port": config.port})

                    # Run once it is following and its health answers: what was recorded while no Smelter ran is
                    # found, and what is recorded meanwhile is applied as it arrives.
                    running = [asyncio.ensure_future(_reconciled(smelter))]
                    if exporting is not None:
                        running.append(asyncio.ensure_future(exporting.sample_the_loop()))
                        size = exporting.sample(
                            "semiont.vector.index.size",
                            partial(points_held, started.index),
                            description="Points the vector index holds, of resources and of annotations together",
                        )
                        running.append(asyncio.ensure_future(size))
                    try:
                        await told_to_stop.wait()
                        LOG.info("Shutting down")
                    finally:
                        for task in running:
                            task.cancel()
                        await asyncio.gather(*running, return_exceptions=True)
                except Exception:
                    # A failure nothing caught, in a service that had started: it is counted, and the process exits for it.
                    if exporting is not None:
                        exporting.died()
                    raise
                finally:
                    health.close()
                    await health.wait_closed()
        finally:
            await started.index.disconnect()


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
