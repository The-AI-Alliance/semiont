"""The Worker service as a process: what it is started with, how it refuses to start, and how it stops.

It is started with the path of its configuration document (`--config`), its
own account at the issuer (`SEMIONT_OIDC_CLIENT_ID`, and the key it signs in
with, `SEMIONT_OIDC_CLIENT_KEY`), and the variable each agent's `apiKeyEnv`
names. Beside those it reads the variables
`docs/protocol/WORKER-SERVICE.md` § Environment lists, and no other. This is
the one module that reads the process's environment and its arguments:
everything else is handed what it needs.

Everything it is started with is read before anything is dialled, so a
service that cannot start says so while an operator is watching it boot: one
line on stderr that begins `[fatal] `, and status 1. Once it has started,
everything it writes is its log, on stdout.

It works as one agent for each entry of its document's `agents`
(`semiont_worker.agent`), and answers `GET /health` once every one of them
has signed in. Told to stop, each agent fails the job it holds, and the
process exits with status 0.
"""

import asyncio
import os
import signal
import sys
from collections.abc import Mapping, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import final

from semiont.http import KeyCredential, ServiceToken
from semiont.model import written
from semiont.types import WorkerConfig
from semiont_inference.factory import CatalogueRequired, KeyRequired, create_inference_client
from semiont_inference.interface import InferenceClient
from semiont_service.config import Refused, config_path_of, key_account_of, read_config
from semiont_service.health import bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install

from semiont_worker.agent import AgentWorker, exit_for_restart
from semiont_worker.config import SERVICE, api_key_of
from semiont_worker.failure_class import words_of
from semiont_worker.log import LOG


@final
@dataclass(frozen=True, slots=True)
class _Started:
    """Everything the service is started with: its document, its account, and a client of each agent's provider and model."""

    config: WorkerConfig
    credential: KeyCredential
    clients: list[InferenceClient]


def _client_of(config: WorkerConfig, index: int, environment: Mapping[str, str]) -> InferenceClient:
    """A client of one agent's provider and model, as the document states them.

    Refused, by the member, for a provider that takes a key where the agent
    names no variable for one, and for a provider whose facts are read from
    the model catalogue where the file the document names cannot be read or
    lacks the model.
    """
    entry = config.agents[index]
    agent = f"agents[{index}]"
    try:
        return create_inference_client(
            provider=entry.agent.provider,
            model=entry.agent.model,
            base_url=entry.base_url,
            api_key=api_key_of(config, index, environment),
            catalogue=Path(config.model_catalogue),
        )
    except KeyRequired as keyless:
        raise Refused(f"{agent}.apiKeyEnv is not stated, and {agent}.agent.provider is {entry.agent.provider}: {keyless}") from keyless
    except CatalogueRequired as lacking:
        raise Refused(f"modelCatalogue names {config.model_catalogue}, which does not serve {agent}: {lacking}") from lacking


def boot(arguments: Sequence[str], environment: Mapping[str, str]) -> _Started:
    """Read everything the service is started with, and raise for what it cannot start on. Nothing is dialled."""
    config = read_config(SERVICE, WorkerConfig, config_path_of(SERVICE, arguments))
    # What is written from the document's level: the service's own code, the inference drivers' and the SDK's.
    configure(SERVICE, config.log_level, config.log_format, own=(LOG.name, "semiont_inference", "semiont"))
    credential = key_account_of(SERVICE, config.identity.issuer, environment)
    clients = [_client_of(config, index, environment) for index in range(len(config.agents))]
    return _Started(config=config, credential=credential, clients=clients)


async def _serve(started: _Started, exporting: Exporting | None) -> None:
    """Work as every agent of the document until the process is told to stop."""
    config = started.config
    loop = asyncio.get_running_loop()
    told_to_stop = asyncio.Event()
    for told in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(told, told_to_stop.set)

    agents: list[AgentWorker] = []
    # The port is taken before anything is dialled, and answers nothing yet: a service that cannot listen on it has
    # signed in nowhere and opened no stream.
    try:
        health = await bind_health(
            config.port, lambda: {"status": "ok", "agents": len(agents), "workers": [agent.vitals() for agent in agents]}
        )
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {config.port}: {unheard}") from unheard

    try:
        LOG.info(
            "Starting agents",
            extra={
                "baseUrl": config.gateway_url,
                "agents": [
                    {
                        "provider": entry.agent.provider,
                        "model": entry.agent.model,
                        "serves": [written(accepted) for accepted in entry.accepts],
                    }
                    for entry in config.agents
                ],
            },
        )
        service = ServiceToken(started.credential)
        async with AsyncExitStack() as held:
            # Every agent signs in before any of them opens its stream: a sign-in the issuer or the gateway refuses
            # ends a service that has opened none.
            for index, (entry, client) in enumerate(zip(config.agents, started.clients, strict=True)):
                agents.append(
                    await held.enter_async_context(
                        AgentWorker(
                            entry,
                            client,
                            gateway_url=config.gateway_url,
                            service=service,
                            # The first agent answers for every agent's model: the gateway delivers the first reply to a request.
                            answers_limits_of=started.clients if index == 0 else (),
                        )
                    )
                )
            for agent in agents:
                await agent.open()

            try:
                await health.start_serving()
            except OSError as unheard:
                raise Refused(f"Cannot listen on port {config.port}: {unheard}") from unheard
            LOG.info("Health endpoint ready", extra={"port": config.port})

            sampling = None if exporting is None else asyncio.ensure_future(exporting.sample_the_loop())
            working = [asyncio.ensure_future(agent.work()) for agent in agents]
            stopping = asyncio.ensure_future(told_to_stop.wait())
            try:
                await asyncio.wait([stopping, *working], return_when=asyncio.FIRST_COMPLETED)
                for ended in working:
                    if ended.done():
                        # An agent that cannot claim, on a service that was not told to stop: nothing would wake it again.
                        failure = ended.exception()
                        LOG.error(
                            "Cannot claim jobs \N{EM DASH} exiting for restart",
                            extra={"error": "the agent stopped claiming" if failure is None else words_of(failure)},
                        )
                        exit_for_restart()

                LOG.info("Shutting down")
                # A job still held is failed before its agent's client goes, so the queue retries it now.
                await asyncio.gather(*(agent.stop() for agent in agents))
            except Exception:
                # A failure nothing caught, in a service that had started: it is counted, and the process exits for it.
                if exporting is not None:
                    exporting.died()
                raise
            finally:
                for task in (stopping, *working, *(() if sampling is None else (sampling,))):
                    task.cancel()
                await asyncio.gather(stopping, *working, *(() if sampling is None else (sampling,)), return_exceptions=True)
    finally:
        health.close()
        await health.wait_closed()


def main() -> int:
    """Run the service, and answer the status the process exits with."""
    exporting: Exporting | None = None
    try:
        started = boot(sys.argv[1:], os.environ)
        exporting = install(SERVICE, os.environ)
        asyncio.run(_serve(started, exporting))
    except Exception as failure:
        # Whatever ends the service that was not its being told to stop is said once, as every service says it.
        sys.stderr.write(f"[fatal] {words_of(failure)}\n")
        return 1
    finally:
        if exporting is not None:
            exporting.shutdown()
    return 0
