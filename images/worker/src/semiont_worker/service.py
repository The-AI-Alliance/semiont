"""The Worker service as a process: what it is started with, how it refuses to start, and how it stops.

It is started with the path of its configuration document (`--config`), the
key it signs in with at every knowledge base (`SEMIONT_OIDC_CLIENT_KEY`), and
the variable each engine's `apiKeyEnv` names. Beside those it reads the
variables `docs/protocol/WORKER-SERVICE.md` § Environment lists, and no other.
This is the one module that reads the process's environment and its
arguments: everything else is handed what it needs.

Everything it is started with is read before anything is dialled: the
document, the key, the account the service signs in as at each knowledge
base, which is the client that knowledge base's `identity` names holding the
key's public half, and a client of each engine's provider and model, one for
each distinct engine, which every knowledge base that names it shares. So a
service that cannot start says so while an operator is watching it boot: one
line on stderr that begins `[fatal] `, and status 1. Once it has started,
everything it writes is its log, on stdout.

It is an agent at each knowledge base of its document, and works at every
one at once, apart from every other (`semiont_worker.knowledge_base`). It
answers `GET /health` once a knowledge base is confirmed. Told to stop, each
engine at each knowledge base fails the job it holds, and the process exits
with status 0. Every knowledge base refused, it exits with status 1: with a
`[fatal] ` line where none was confirmed first, and with only the refusals in
its log where one was.
"""

import asyncio
import os
import signal
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import final

from semiont.model import written
from semiont.types import WorkerConfig, WorkerEngineConfig
from semiont_inference.factory import CatalogueRequired, KeyRequired, create_inference_client
from semiont_inference.interface import InferenceClient
from semiont_service.config import Refused, config_path_of, key_account_of, read_config
from semiont_service.health import bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install

from semiont_worker.config import SERVICE, api_key_of, served_once
from semiont_worker.failure_class import words_of
from semiont_worker.knowledge_base import KnowledgeBases, Served
from semiont_worker.log import LOG


@final
@dataclass(frozen=True, slots=True)
class _Started:
    """Everything the service is started with: its document, and each knowledge base as the service is started for it, in its order."""

    config: WorkerConfig
    knowledge_bases: tuple[Served, ...]


def _client_of(config: WorkerConfig, knowledge_base: int, index: int, environment: Mapping[str, str]) -> InferenceClient:
    """A client of one engine's provider and model, as the document states them.

    Refused, by the member, for a provider that takes a key where the entry
    names no variable for one, and for a provider whose facts are read from
    the model catalogue where the file the document names cannot be read or
    lacks the model.
    """
    entry = config.knowledge_bases[knowledge_base].engines[index]
    member = f"knowledgeBases[{knowledge_base}].engines[{index}]"
    try:
        return create_inference_client(
            provider=entry.engine.provider,
            model=entry.engine.model,
            base_url=entry.base_url,
            api_key=api_key_of(config, knowledge_base, index, environment),
            catalogue=Path(config.model_catalogue),
        )
    except KeyRequired as keyless:
        raise Refused(f"{member}.apiKeyEnv is not stated, and {member}.engine.provider is {entry.engine.provider}: {keyless}") from keyless
    except CatalogueRequired as lacking:
        raise Refused(f"modelCatalogue names {config.model_catalogue}, which does not serve {member}: {lacking}") from lacking


def _which_engine(entry: WorkerEngineConfig) -> str:
    """What makes two entries one engine: everything an entry states but the jobs it is used for."""
    return entry.model_dump_json(by_alias=True, exclude={"jobs"})


def _clients_of(config: WorkerConfig, environment: Mapping[str, str]) -> list[tuple[InferenceClient, ...]]:
    """For each knowledge base, in the document's order, a client of each of its engines: one of each distinct engine, shared.

    An engine is refused by the first member that names it.
    """
    made: dict[str, InferenceClient] = {}
    of_each: list[tuple[InferenceClient, ...]] = []
    for at, knowledge_base in enumerate(config.knowledge_bases):
        clients: list[InferenceClient] = []
        for index, entry in enumerate(knowledge_base.engines):
            engine = _which_engine(entry)
            if engine not in made:
                made[engine] = _client_of(config, at, index, environment)
            clients.append(made[engine])
        of_each.append(tuple(clients))
    return of_each


def boot(arguments: Sequence[str], environment: Mapping[str, str]) -> _Started:
    """Read everything the service is started with, and raise for what it cannot start on. Nothing is dialled."""
    config = read_config(SERVICE, WorkerConfig, config_path_of(SERVICE, arguments))
    # What is written from the document's level: the service's own code, the inference drivers' and the SDK's.
    configure(SERVICE, config.log_level, config.log_format, own=(LOG.name, "semiont_inference", "semiont"))
    served_once(config)
    credentials = tuple(
        key_account_of(SERVICE, knowledge_base.identity.issuer, knowledge_base.identity.client_id, environment)
        for knowledge_base in config.knowledge_bases
    )
    clients = _clients_of(config, environment)
    return _Started(
        config=config,
        knowledge_bases=tuple(
            Served(entry=knowledge_base, credential=credential, clients=clients_there)
            for knowledge_base, credential, clients_there in zip(config.knowledge_bases, credentials, clients, strict=True)
        ),
    )


async def _answer_once_confirmed(health: asyncio.Server, knowledge_bases: KnowledgeBases, port: int) -> None:
    """Have the health endpoint answer from when a knowledge base is first confirmed."""
    await knowledge_bases.confirmed()
    try:
        await health.start_serving()
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {port}: {unheard}") from unheard
    LOG.info("Health endpoint ready", extra={"port": port})


async def _serve(started: _Started, exporting: Exporting | None) -> int:
    """Work at every knowledge base of the document until the process is told to stop, or every one refused it: the status it exits with."""
    config = started.config
    loop = asyncio.get_running_loop()
    told_to_stop = asyncio.Event()
    for told in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(told, told_to_stop.set)

    knowledge_bases = KnowledgeBases(started.knowledge_bases)
    # The port is taken before anything is dialled, and answers nothing yet: a service that cannot listen on it has
    # signed in nowhere and opened no stream.
    try:
        health = await bind_health(config.port, lambda: written(knowledge_bases.health()))
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {config.port}: {unheard}") from unheard

    sampling = None if exporting is None else asyncio.ensure_future(exporting.sample_the_loop())
    answering = asyncio.ensure_future(_answer_once_confirmed(health, knowledge_bases, config.port))
    working = asyncio.ensure_future(knowledge_bases.work(told_to_stop))
    try:
        ended, _ = await asyncio.wait([answering, working], return_when=asyncio.FIRST_COMPLETED)
        unanswered = answering.exception() if answering in ended else None
        if unanswered is not None:
            # The knowledge bases are stopped as for a signal, each failing the job it holds, before the service says why it ends.
            told_to_stop.set()
            await asyncio.gather(working, return_exceptions=True)
            raise unanswered
        return await working
    except Refused:
        raise
    except Exception:
        # A failure nothing caught, in a service that had started: it is counted, and the process exits for it.
        if exporting is not None:
            exporting.died()
        raise
    finally:
        tasks = (answering, working, *(() if sampling is None else (sampling,)))
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        health.close()
        await health.wait_closed()


def main() -> int:
    """Run the service, and answer the status the process exits with."""
    exporting: Exporting | None = None
    try:
        started = boot(sys.argv[1:], os.environ)
        # It serves several knowledge bases, so its resource names none.
        exporting = install(SERVICE, os.environ, kb=None)
        return asyncio.run(_serve(started, exporting))
    except Exception as failure:
        # Whatever ends the service that was not its being told to stop, or its every knowledge base refusing it once
        # one had admitted it, is said once, as every service says it.
        sys.stderr.write(f"[fatal] {words_of(failure)}\n")
        return 1
    finally:
        if exporting is not None:
            exporting.shutdown()
