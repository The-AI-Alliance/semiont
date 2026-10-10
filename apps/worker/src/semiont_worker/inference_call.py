"""The bound on one call to a model: no call waits forever.

A call to a model is the one thing a job awaits that has no bound of its own.
Unbounded, a request that never settles would hold its agent for good, since
an agent that holds a job claims no other. The bound turns that into an
ordinary failure of the job, and ends the request: the call is cancelled, so
its driver tears the request down, and no answer nobody will use is paid for.
"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Final, final

from semiont_inference.interface import ElementSchema, InferenceClient, InferenceResponse, StructuredResponse

from semiont_worker.log import LOG
from semiont_worker.telemetry import GenerationKind, generating

INFERENCE_TIMEOUT_SECONDS: Final = 10 * 60
"""How long one call to a model is given. A slow local model on a large prompt runs for minutes, and not for tens of them."""

INFERENCE_HEARTBEAT_SECONDS: Final = 15
"""How often a call that is still awaited says so.

A text that is one piece crosses no boundary between pieces, so a job on it
would say nothing from its first call to its last, and whoever follows the job
would take minutes of silence for a job that died.
"""

type InferenceHeartbeat = Callable[[], None]
"""What is called while a call is still awaited. It says the job is alive, and nothing of how far the call has got: nobody knows that."""


@final
class InferenceTimeoutError(Exception):
    """The bound ran out before the model answered. It says nothing about the request."""


async def bounded_generate_text(
    client: InferenceClient, prompt: str, max_tokens: int, temperature: float, on_heartbeat: InferenceHeartbeat | None
) -> InferenceResponse:
    """`client.generate_text`, bounded: its answer, the failure it raised, or an `InferenceTimeoutError` after ten minutes.

    While the call is awaited `on_heartbeat` is called every fifteen seconds,
    where one is given. A failure it raises is not the call's: the call goes
    on, and so do the reports. The call is a span, `inference:text`, from the
    request to its answer or its bound.

    The caller's own cancellation is not the bound's: it ends the call, and
    reaches the caller as it is.
    """
    return await _bounded("text", client, max_tokens, lambda: client.generate_text(prompt, max_tokens, temperature), on_heartbeat)


async def bounded_generate_structured(
    client: InferenceClient,
    prompt: str,
    max_tokens: int,
    temperature: float,
    element_schema: ElementSchema,
    on_heartbeat: InferenceHeartbeat | None,
) -> StructuredResponse:
    """`client.generate_structured`, bounded as `bounded_generate_text` is. Its span is `inference:structured`."""
    return await _bounded(
        "structured", client, max_tokens, lambda: client.generate_structured(prompt, max_tokens, temperature, element_schema), on_heartbeat
    )


async def _beat(on_heartbeat: InferenceHeartbeat) -> None:
    """Call `on_heartbeat` every fifteen seconds, by the clock and not by how long the last report took, until this is cancelled."""
    loop = asyncio.get_running_loop()
    due = loop.time()
    while True:
        due += INFERENCE_HEARTBEAT_SECONDS
        await asyncio.sleep(due - loop.time())
        # What reports on a call is no part of it: a report that fails does not take the call down, and the next is still made.
        with contextlib.suppress(Exception):
            on_heartbeat()


async def _bounded[T](
    kind: GenerationKind, client: InferenceClient, max_tokens: int, ask: Callable[[], Awaitable[T]], on_heartbeat: InferenceHeartbeat | None
) -> T:
    """What `ask` answers, where it answers within the bound: in a span of its own, and reported on while it is awaited.

    The span is around the whole call, so that a failure, the bound's among
    them, is recorded on it.
    """
    with generating(kind, provider=client.provider, model=client.model_id, max_tokens=max_tokens):
        beating = None if on_heartbeat is None else asyncio.ensure_future(_beat(on_heartbeat))
        bound = asyncio.timeout(INFERENCE_TIMEOUT_SECONDS)
        try:
            async with bound:
                return await ask()
        except TimeoutError:
            # A provider's own timeout is the provider's failure, and is raised as it was. The bound's is the one
            # that came of its deadline: the call was cancelled there, which tore the request down.
            if not bound.expired():
                raise
            label = f"{client.provider}:{client.model_id}"
            # What was ended is said in the log: a request given up without a word is a cost nobody can find.
            LOG.warning(
                "Aborting in-flight inference call at the timeout bound",
                extra={"provider": client.provider, "model": client.model_id, "label": label, "boundMs": INFERENCE_TIMEOUT_SECONDS * 1000},
            )
            raise InferenceTimeoutError(
                f"Inference call timed out after {INFERENCE_TIMEOUT_SECONDS // 60} minutes ({label}) "
                "— failing the job to keep the claim loop live"
            ) from None
        finally:
            # However the call ended, the reports end with it: one left behind would report on a job long done.
            if beating is not None:
                beating.cancel()
                await asyncio.gather(beating, return_exceptions=True)
