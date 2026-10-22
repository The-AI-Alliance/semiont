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
way, follows the record, opens its health port, and then runs reconcile,
which it runs again each time its stream of the record opens after a drop. A
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
from typing import Final, final

from pydantic import JsonValue
from semiont.bus import reply_channels_for
from semiont.channels import SMELT_REBUILD_ANCHORS
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.types import SmelterConfig
from semiont_service.archivist import Archivist
from semiont_service.config import Refused, config_path_of, service_account_of
from semiont_service.connect import connected
from semiont_service.health import Health, bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.factory import create_embedding_provider, create_vector_store
from semiont_vectors.store import IndexStamp, VectorStore

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


async def _reached(index: VectorStore, stamp: IndexStamp) -> bool:
    """Reach the index, and hold it to the stamp this Smelter makes one by. Answers whether it was made again for that."""
    await index.connect()
    return await hold_to(index, stamp)


def _health_of(smelter: Smelter, transport: HttpTransport, *, stamp: IndexStamp, made_anew: bool) -> dict[str, JsonValue]:
    """What the health endpoint answers (`docs/protocol/SMELTER.md` § Health).

    It answers for this Smelter alone, from what the Smelter holds: nothing
    is asked of the gateway, of the embedding provider or of the index's
    store to answer it. Whether each of those is up is its own to say.
    """
    index: dict[str, JsonValue] = {"stamp": dict(stamp), "madeAnew": made_anew}
    return {
        "status": "ok",
        "stream": transport.state.value,
        "streamDrops": smelter.stream_drops,
        "eventsProcessed": smelter.events_processed,
        "eventsFailed": smelter.events_failed,
        "eventsWaiting": smelter.events_waiting,
        "reconcile": smelter.reconcile_state.said(),
        "index": index,
    }


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
    anchored_stamp = await current_stamp(reader, engine)

    # It works as the agent its embedding provider and its model name: two Smelters that embed with different models are two agents.
    async with AgentToken(config.gateway_url, provider=config.embedding.type, model=config.embedding.model, service=account) as agent:
        LOG.info("Agent ready", extra={"did": agent.did})
        stamp = stamp_of(config)
        made_anew = await connected("vector index and the embedding provider", _reached(started.index, stamp))
        LOG.info("Vector index ready", extra={"type": config.vectors.type})
        try:
            async with (
                Archivist(SERVICE, host=config.archivist.host, port=config.archivist.port, account=account) as content,
                AnchoredTextStore(
                    SERVICE, host=config.archivist.host, port=config.archivist.port, account=account, stamp=anchored_stamp
                ) as anchored,
                HttpTransport(config.gateway_url, token=agent.token, refresher=agent.refresh, channels=CHANNELS) as transport,
                Smelter(
                    index=started.index,
                    provider=started.provider,
                    content=content,
                    annotations=content,
                    extractor=PdfExtractor(reader=reader, engine=engine),
                    anchored=anchored,
                    transport=transport,
                    chunking=Chunking(chunk_size=config.chunking.chunk_size, overlap=config.chunking.overlap),
                    pdfs_at_once=config.pdfs_at_once,
                ) as smelter,
            ):
                LOG.info("Following the record")
                health = await _listening(config.port, partial(_health_of, smelter, transport, stamp=stamp, made_anew=made_anew))
                try:
                    await health.start_serving()
                    LOG.info("Health endpoint ready", extra={"port": config.port})

                    # Begun once it is following and its health answers: what was recorded while no Smelter ran is
                    # found, and what is recorded meanwhile is applied as it arrives. It reconciles again each time its
                    # stream opens after a drop, since what was recorded meanwhile was never delivered.
                    running = [asyncio.ensure_future(smelter.keep_reconciled())]
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
