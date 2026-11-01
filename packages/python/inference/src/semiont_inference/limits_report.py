"""The limits report: how a service that holds inference clients tells everyone else what its engines can take.

A service with a provider's key is the only one that can ask the provider
about a model. It answers a request for limits with the discovered limits of
its own engines, and a client reads them beside the knowledge base's
engines.

Nothing is kept here. A client keeps the limits it learned, shares one asking
among the callers that ask at once, and forgets a failure, so a provider that
was down for a moment is asked again at the next report. A report never fails
and never waits on a provider: an engine whose limits could not be learned,
or were not learned in time, is left out of it.

The request is one of the bus's limits operations, one for each service that
holds a key: the Worker answers `job:limits-requested`, and the Librarian
`gather:limits-requested` and `match:limits-requested`.
"""

import asyncio
from collections.abc import Sequence
from typing import Final

from semiont import telemetry
from semiont.bus import Bus, Delivered, FrameRefusal
from semiont.channel import Operation
from semiont.errors import SemiontError
from semiont.model import stated
from semiont.types import (
    CommandError,
    Engine,
    EngineLimits,
    InferenceLimits,
    InferenceLimitsRequest,
    InferenceLimitsResult,
    InferenceLimitsResultResponse,
)

from semiont_inference._log import LOG
from semiont_inference.interface import InferenceClient

__all__ = ["answer_limits_requests", "report_limits"]

# How long one client is waited on, in seconds. A discovery states no bound of
# its own that is this short, and without one a provider that hangs would hold
# every report. Nothing is lost by not waiting: the client's asking goes on, and
# the next report has what it learned.
_BUDGET: Final = 1.5


async def _consult(client: InferenceClient) -> InferenceLimits | None:
    """One client's limits as the wire carries them (the SDK's `InferenceLimits`), or None where they were not learned in time."""
    engine = f"{client.provider} {client.model_id}"
    budget = asyncio.timeout(_BUDGET)
    try:
        async with budget:
            discovered = await client.limits()
    except Exception as failed:
        if budget.expired():
            LOG.debug(
                "Limits report: consult exceeded budget — engine left out", extra={"engine": engine, "budgetMs": round(_BUDGET * 1000)}
            )
        else:
            LOG.debug("Limits report: consult failed — engine left out", extra={"engine": engine, "reason": str(failed)})
        return None
    # What the wire's schema declares, and no more: a driver's limits also carry the provider's
    # rate, which is for a worker's own budget and has no reader on the wire. Whether the model
    # takes a temperature may be left out on the wire, and is when the driver makes no claim.
    return stated(
        InferenceLimits(
            context_tokens=discovered.context_tokens,
            max_output_tokens=discovered.max_output_tokens,
            accepts_temperature=discovered.accepts_temperature,
        )
    )


async def report_limits(clients: Sequence[InferenceClient]) -> list[EngineLimits]:
    """The discovered limits of each distinct engine among `clients`, in the order given.

    An engine whose limits could not be learned, or were not learned in time, is left out.
    """
    distinct: dict[Engine, InferenceClient] = {}
    for client in clients:
        distinct.setdefault(Engine(provider=client.provider, model=client.model_id), client)
    consulted = await asyncio.gather(*(_consult(client) for client in distinct.values()))
    return [EngineLimits(engine=engine, limits=limits) for engine, limits in zip(distinct, consulted, strict=True) if limits is not None]


async def _answer(
    bus: Bus,
    operation: Operation[InferenceLimitsRequest, InferenceLimitsResult, CommandError],
    clients: Sequence[InferenceClient],
    request: Delivered[InferenceLimitsRequest],
) -> None:
    """Answer one request: a report on the operation's result channel, or, where that could not be sent, why on its failure channel."""
    with telemetry.continuing(request.trace):
        try:
            limits = await report_limits(clients)
            await bus.emit(
                operation.result,
                InferenceLimitsResult(response=InferenceLimitsResultResponse(limits=limits)),
                correlation_id=request.correlation_id,
            )
        except Exception as failed:
            LOG.error("Limits report failed", extra={"operation": operation.request.name, "error": str(failed)})
            try:
                await bus.emit(operation.failure, CommandError(message=str(failed)), correlation_id=request.correlation_id)
            except SemiontError:
                # A failure that cannot be sent either is told where every emit that could not be sent is: by the transport.
                return


async def answer_limits_requests(
    bus: Bus, operation: Operation[InferenceLimitsRequest, InferenceLimitsResult, CommandError], clients: Sequence[InferenceClient]
) -> None:
    """Answer every request of `operation` that `bus` delivers with the limits of `clients`, for as long as this is awaited.

    Each request is answered once, on the operation's result channel, with
    the request's correlation id, in the trace it was sent under. Each is
    answered as its own report is made, so a provider that is slow to one
    request holds up no other. The bus's stream must name the operation's
    request channel.

    It returns when the bus's frames end, once the answers under way are
    sent. Cancelled, it stops listening and ends the reports it was making.
    """
    async with bus.frames(operation.request) as requests, asyncio.TaskGroup() as answering:
        async for request in requests:
            match request:
                case Delivered():
                    answering.create_task(_answer(bus, operation, clients, request))
                case FrameRefusal():
                    # A request that is not the operation's asks for nothing this can answer.
                    pass
