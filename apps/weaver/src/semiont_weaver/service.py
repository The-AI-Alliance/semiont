"""The Weaver service as a process: what it is started with, how it refuses to start, the order it starts in, and how it stops.

It is started with the path of its configuration document (`--config`), its
own account at the issuer (`SEMIONT_OIDC_CLIENT_ID` and
`SEMIONT_OIDC_CLIENT_SECRET`), and the variable its document names for the
graph database's password. Beside those it reads the variables that say
where its telemetry goes (`docs/protocol/WEAVER.md` § Environment), and no
other. This is the one module that reads the process's environment and its
arguments: everything else is handed what it needs.

Everything it is started with is read before anything is dialled, so a
service that cannot start says so while an operator is watching it boot: one
line on stderr that begins `[fatal] `, and status 1. Once it has started,
everything it writes is its log, on stdout.

It starts in the order `docs/protocol/WEAVER.md` § Boot states: it signs in
as the agent `(semiont, weaver)`, connects to the graph database, follows the
record, opens its health port, and then runs its two boot passes, catch-up
and reconcile. A pass that fails is said, in the log and at the health port,
and does not end the service: ending it would make the graph no fresher, and
would take away the one thing still applying what arrives. Told to stop, it
stops applying, closes what it holds open, and exits with status 0.
"""

import asyncio
import os
import signal
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, final

from pydantic import JsonValue
from semiont.bus import reply_channels_for
from semiont.channels import WEAVE_REBUILD
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.types import WeaverConfig
from semiont_graph.factory import create_graph_database
from semiont_graph.interface import GraphDatabase
from semiont_service.config import Refused, config_path_of, service_account_of
from semiont_service.connect import connected
from semiont_service.health import Health, bind_health
from semiont_service.log import configure
from semiont_service.observability import Exporting, install

from semiont_weaver.checkpoint import Checkpoint
from semiont_weaver.config import SERVICE, graph_password_of, read_weaver_config
from semiont_weaver.history import READ
from semiont_weaver.log import LOG
from semiont_weaver.recorded import FOLLOWED
from semiont_weaver.weaver import CaughtUp, Reconciled, Weaver, words_of

CHANNELS: Final[tuple[str, ...]] = (*FOLLOWED, WEAVE_REBUILD.name, *reply_channels_for(*READ))
"""What the Weaver's stream names: the events it follows, the command it answers, and the replies of what it asks."""

_PROVIDER: Final = "semiont"
_MODEL: Final = "weaver"
"""Who the Weaver works as. It asks no model anything, so it is the same agent wherever it runs: `(semiont, weaver)`."""


@final
@dataclass(frozen=True, slots=True)
class _Started:
    """Everything the service is started with: its document, its account, and the store of its graph database, not yet connected."""

    config: WeaverConfig
    credential: Credential
    graph: GraphDatabase


def boot(arguments: Sequence[str], environment: Mapping[str, str]) -> _Started:
    """Read everything the service is started with, and raise for what it cannot start on. Nothing is dialled."""
    config = read_weaver_config(config_path_of(SERVICE, arguments))
    # What is written from the document's level: the service's own code, the graph stores' and the SDK's.
    configure(SERVICE, config.log_level, config.log_format, own=(LOG.name, "semiont_graph", "semiont"))
    credential = service_account_of(SERVICE, config.identity.issuer, environment)
    graph = create_graph_database(config.graph, password=graph_password_of(config, environment))
    return _Started(config=config, credential=credential, graph=graph)


type _Pass = dict[str, JsonValue]
"""One boot pass, as the health endpoint reports it: its `phase`, and its `summary` or its `error`."""


async def _run_pass(name: str, run: Callable[[], Awaitable[dict[str, JsonValue]]], state: _Pass) -> None:
    """Run one boot pass, and say in `state` how it went. It raises nothing but its being cancelled."""
    state["phase"] = "running"
    try:
        summary = await run()
    except Exception as failure:
        state["phase"], state["error"] = "failed", words_of(failure)
        # The one alarm that a pass failed: the health endpoint carries the failed phase and answers `ok` all the same.
        LOG.error("Boot pass failed: continuing with a graph that may be behind", extra={"pass": name, "error": words_of(failure)})
    else:
        state["phase"], state["summary"] = "done", summary


async def _listening(port: int, health: Health) -> asyncio.Server:
    """The health endpoint, holding its port and answering nothing yet. Refused where the port cannot be taken."""
    try:
        return await bind_health(port, health)
    except OSError as unheard:
        raise Refused(f"Cannot listen on port {port}: {unheard}") from unheard


async def _serve(started: _Started, exporting: Exporting | None) -> None:
    """Follow the record until the process is told to stop. `exporting` is the process's telemetry, where it exports any."""
    config = started.config
    loop = asyncio.get_running_loop()
    told_to_stop = asyncio.Event()
    for told in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(told, told_to_stop.set)

    catch_up: _Pass = {"phase": "pending"}
    reconcile: _Pass = {"phase": "pending"}

    async with AgentToken(config.gateway_url, provider=_PROVIDER, model=_MODEL, service=ServiceToken(started.credential)) as agent:
        LOG.info("Agent ready", extra={"did": agent.did})
        await connected("graph database", started.graph.connect())
        LOG.info("Graph database ready", extra={"type": config.graph.type})
        try:
            async with (
                HttpTransport(config.gateway_url, token=agent.token, refresher=agent.refresh, channels=CHANNELS) as transport,
                Weaver(started.graph, transport, transport.content, Checkpoint(Path(config.checkpoint_path))) as weaver,
            ):
                LOG.info("Following the record")
                health = await _listening(
                    config.port,
                    lambda: {"status": "ok", "applyFailures": weaver.apply_failures, "catchUp": catch_up, "reconcile": reconcile},
                )
                try:
                    await health.start_serving()
                    LOG.info("Health endpoint ready", extra={"port": config.port})

                    async def passes() -> None:
                        # Run once it is following, so that what changed while no Weaver ran is brought back in step,
                        # and then what the graph lost that no event will touch again.
                        await _run_pass("catch-up", lambda: _said(weaver.catch_up()), catch_up)
                        await _run_pass("reconcile", lambda: _said(weaver.reconcile()), reconcile)

                    passing = asyncio.ensure_future(passes())
                    sampling = None if exporting is None else asyncio.ensure_future(exporting.sample_the_loop())
                    running = (passing, *(() if sampling is None else (sampling,)))
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
            await started.graph.disconnect()


async def _said(passing: Awaitable[CaughtUp | Reconciled]) -> dict[str, JsonValue]:
    """What a pass did, as the health endpoint reports it."""
    return (await passing).said()


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
