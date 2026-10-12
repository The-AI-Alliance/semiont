"""How wide a provider's vectors are: measured by asking it for one, once, and asked of a provider that may not be ready yet.

The model says how wide its vectors are, and nothing else does. No table of
models is kept: one would be wrong for the first model it does not list, and
an index made at the wrong width fails far from where the width was written.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Final, final

from semiont_vectors._retry import EMBEDDING_PROVIDER_RETRY, asked_again
from semiont_vectors.embedding import EmbeddingProviderError

PROBE: Final = "dimension probe"
"""The text a provider is asked to embed when its vectors are measured."""


@final
class Width:
    """How wide one provider's vectors are, measured at the first call and kept.

    It is measured by `embed`, the provider's own, so the measuring is a
    request like any other: it waits its turn, and has a request's time.

    Callers that ask while it is being measured share the one measuring. A
    failure is not kept: the next call measures again, so a provider that
    was not ready does not go on failing every later call.

    The measuring is no caller's own. A caller cancelled while it waits
    leaves at once, with its cancellation as it is, and the measuring goes
    on for the others and for the next call.
    """

    def __init__(self, embed: Callable[[str], Awaitable[list[float]]]) -> None:
        self._embed: Final = embed
        self._measured: int | None = None
        self._measuring: asyncio.Task[int] | None = None

    async def get(self) -> int:
        if self._measured is not None:
            return self._measured
        if self._measuring is None:
            self._measuring = asyncio.get_running_loop().create_task(self._measure())
            self._measuring.add_done_callback(self._settled)
        # The shield is around the measuring, which every caller shares. It is not around this
        # caller's wait, which ends when the caller is cancelled.
        return await asyncio.shield(self._measuring)

    async def _measure(self) -> int:
        return len(await self._embed(PROBE))

    def _settled(self, measuring: asyncio.Task[int]) -> None:
        self._measuring = None
        # Reading the failure is also what tells the loop it was seen: a caller that left is not there to see it.
        if not measuring.cancelled() and measuring.exception() is None:
            self._measured = measuring.result()


def _not_ready(failed: EmbeddingProviderError) -> bool:
    """Whether a failure is one that passes by itself: the model is on its way, or the provider is still starting."""
    return failed.status == 404 or not failed.reached


async def resolve_dimensions(dimensions: Callable[[], Awaitable[int]]) -> int:
    """What `dimensions` answers, asked of a provider that may not be ready yet.

    A provider is not ready when it answers 404, which is taken to mean its
    model is still being fetched, and when no connection to it could be made
    at all, which is taken to mean it is still starting. Either is asked
    again, as `EMBEDDING_PROVIDER_RETRY` says. Any other failure is raised
    at once, as it is: a key that was refused is not accepted for waiting.

    When the attempts are spent on a provider that could not be reached, its
    `EmbeddingProviderError` is raised as it is. When they are spent on a
    404, raises `RuntimeError`, with the provider's failure as its cause. It
    names the model and both things a 404 can mean, which the provider does
    not tell apart: the model is not fetched yet, or its name is wrong.

    It is stopped by cancelling it. A caller with a deadline puts
    `asyncio.timeout` around what calls this.
    """
    try:
        return await asked_again(EMBEDDING_PROVIDER_RETRY, dimensions, again=_not_ready)
    except EmbeddingProviderError as failed:
        if failed.status != 404:
            raise
        spent = EMBEDDING_PROVIDER_RETRY.attempts
        raise RuntimeError(
            f"Embedding model '{failed.model}' is still unavailable on {failed.provider} after {spent} attempts. "
            "Either it has not been fetched yet, or the configured model name is wrong: the provider answers 404 for both."
        ) from failed
