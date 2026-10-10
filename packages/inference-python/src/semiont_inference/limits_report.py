"""The limits report: how a service that holds inference clients tells everyone else what its models can take.

A service with a provider's key is the only one that can ask the provider
about a model. It answers a request for limits with the discovered limits of
its own providers and models, and a client reads them beside the
knowledge base's list of who works in it.

Nothing is kept here. A client keeps the limits it learned, shares one asking
among the callers that ask at once, and forgets a failure, so a provider that
was down for a moment is asked again at the next report. A report never fails
and never waits on a provider: a pair whose limits could not be learned, or
were not learned in time, is left out of it.
"""

import asyncio
from collections.abc import Sequence
from typing import Final

from semiont.model import stated
from semiont.types import InferenceLimits, InferencePairLimits

from semiont_inference._log import LOG
from semiont_inference.interface import InferenceClient

__all__ = ["report_limits"]

# How long one client is waited on, in seconds. A discovery states no bound of
# its own that is this short, and without one a provider that hangs would hold
# every report. Nothing is lost by not waiting: the client's asking goes on, and
# the next report has what it learned.
_BUDGET: Final = 1.5


async def _consult(client: InferenceClient) -> InferenceLimits | None:
    """One client's limits as the wire carries them (the SDK's `InferenceLimits`), or None where they were not learned in time."""
    pair = f"{client.provider} {client.model_id}"
    budget = asyncio.timeout(_BUDGET)
    try:
        async with budget:
            discovered = await client.limits()
    except Exception as failed:
        if budget.expired():
            LOG.debug("Limits report: consult exceeded budget — pair left out", extra={"pair": pair, "budgetMs": round(_BUDGET * 1000)})
        else:
            LOG.debug("Limits report: consult failed — pair left out", extra={"pair": pair, "reason": str(failed)})
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


async def report_limits(clients: Sequence[InferenceClient]) -> list[InferencePairLimits]:
    """The discovered limits of each distinct provider and model among `clients`, in the order given.

    A pair whose limits could not be learned, or were not learned in time, is left out.
    """
    distinct: dict[tuple[str, str], InferenceClient] = {}
    for client in clients:
        distinct.setdefault((client.provider, client.model_id), client)
    consulted = await asyncio.gather(*(_consult(client) for client in distinct.values()))
    return [
        InferencePairLimits(provider=provider, model=model, limits=limits)
        for (provider, model), limits in zip(distinct, consulted, strict=True)
        if limits is not None
    ]
