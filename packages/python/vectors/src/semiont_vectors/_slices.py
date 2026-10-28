"""Asking a provider for the vectors of many texts: the requests a batch is cut into, how many are made at once, and how long each may take.

Both providers ask this way. Each brings what is its own: its policy, and
how one request is made and read.

- **The vectors are in the order of the texts.** Whoever asked matches each
  vector to its text by its place, so an order changed would put a vector on
  the wrong text and nothing would say so.
- **A request's time is its own.** It is counted from when the request holds
  its turn, and for the whole of the request: one that waited behind others
  has all of it.
- **One request that fails fails the batch, and ends the others.** The
  failure says which request it was, for whoever reads it. Nothing is kept
  of the requests that were answered: a resource indexed in part would look
  whole to whoever compares only what its points say of it.
- **A provider that says it is busy is asked again for documents, within
  the request's own time.** A request for the vectors of documents that is
  answered 429 or 503 is made again after a wait: a second, then two, then
  four, with its turn kept through each. A wait that would end at or after
  the request's deadline is not begun, and nothing is asked a fifth time: the
  failure is then raised as it came. Any other failure is raised at once.
  So is a busy answer to a query: whoever searches is waiting, and is
  answered without the provider sooner than it is kept waiting on it.

No type of an HTTP client appears here. Whether a failure is one of a
provider that was not reached is decided where the request is made.
"""

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Sequence
from typing import Final, final

from semiont_vectors.embedding import EMBED_ROUND_TRIP_SECONDS, BatchPolicy, EmbeddingProviderError, ProviderName, SliceRef, TextKind

CONNECT_SECONDS: Final = 10.0
"""How long making the connection for one request may take.

Less than a request's whole time (`EMBED_ROUND_TRIP_SECONDS`), so that a
connection that cannot be made is known for that before the request's time
runs out. The two are told apart afterwards: a provider that was not reached
is asked again when a service starts, and one that was reached and did not
answer is not.
"""

BUSY_STATUSES: Final = frozenset({429, 503})
"""The statuses a provider says it is busy with: 429, too many requests, and 503, none served for now.

A request for documents so answered is made again, after the waits `BUSY_WAITS` states.
"""

BUSY_WAITS: Final = (1.0, 2.0, 4.0)
"""How many seconds a request for documents waits before it asks a busy provider again: before its second, third and fourth attempt.

Sized by a request's whole time (`EMBED_ROUND_TRIP_SECONDS`), which the
waits are within: the three come to 7 of a request's 15 seconds, and leave 8
for its four attempts.
"""

type Post = Callable[[Sequence[str], TextKind], Awaitable[list[list[float]]]]
"""Makes one request: the vector of each of these texts, in their order, told what the texts are for.

Raises `EmbeddingProviderError` where the provider gives none. The time of
the request as a whole is not its to keep, and neither is asking a busy
provider again: both are kept here.
"""


@final
class Batches:
    """The batches asked of one provider: one of these is made with each provider, and every call of that provider asks through it.

    So the most requests made at once holds across every caller. A bound
    kept by each call would be multiplied by the calls made at once, which
    is no bound. It holds for this process alone: two processes that ask
    one provider may each make that many.
    """

    def __init__(self, *, provider: ProviderName, model: str, policy: BatchPolicy, post: Post) -> None:
        self._provider: Final = provider
        self._model: Final = model
        self._slice_size: Final = policy.slice_size
        self._post: Final = post
        # A turn is given in the order it was waited for.
        self._turns: Final = asyncio.Semaphore(policy.concurrency)

    async def embed(self, texts: Sequence[str], kind: TextKind) -> list[list[float]]:
        """The vector of each text, in the order of the texts. Every request is told `kind`. No texts are no requests."""
        refs = [
            SliceRef(index=index, start=start, end=min(start + self._slice_size, len(texts)))
            for index, start in enumerate(range(0, len(texts), self._slice_size))
        ]
        requests: list[asyncio.Task[list[list[float]]]] = []
        # A request that fails ends the others: the group cancels them, and waits until every one has ended.
        # What it raises is a group of every failure there was, which is not what a caller is to be handed.
        with contextlib.suppress(ExceptionGroup):
            async with asyncio.TaskGroup() as group:
                requests.extend(group.create_task(self._request(ref, texts[ref.start : ref.end], kind)) for ref in refs)
        # The failure is read from the requests, which are in the order of the texts, and raised as it is:
        # where more than one failed, the one of the earliest texts.
        for request in requests:
            if not request.cancelled() and (failure := request.exception()) is not None:
                raise failure
        return [vector for request in requests for vector in request.result()]

    async def _request(self, ref: SliceRef, texts: Sequence[str], kind: TextKind) -> list[list[float]]:
        async with self._turns:
            loop = asyncio.get_running_loop()
            # Counted from here, where the request holds its turn, to wherever it has got to when the time is up:
            # one moment for the whole of the request, every attempt and every wait of it.
            until = loop.time() + EMBED_ROUND_TRIP_SECONDS
            try:
                async with asyncio.timeout_at(until):
                    for wait in BUSY_WAITS:
                        try:
                            return await self._post(texts, kind)
                        except EmbeddingProviderError as busy:
                            # A query is asked once, and any other failure is raised at once. So is a busy answer
                            # whose wait would not end before the deadline.
                            if kind != "document" or busy.status not in BUSY_STATUSES or loop.time() + wait >= until:
                                raise
                            # The turn is kept through the wait: a busy provider is not helped by another request in this one's place.
                            await asyncio.sleep(wait)
                    return await self._post(texts, kind)
            except TimeoutError as late:
                raise EmbeddingProviderError(
                    provider=self._provider,
                    status=None,
                    reached=True,
                    model=self._model,
                    body=f"no answer within {EMBED_ROUND_TRIP_SECONDS:g} seconds",
                    slice=ref,
                ) from late
            except EmbeddingProviderError as failed:
                # The same failure, and which request it was. Its cause is the cause it came with.
                raise EmbeddingProviderError(
                    provider=failed.provider,
                    status=failed.status,
                    reached=failed.reached,
                    model=failed.model,
                    body=failed.body,
                    slice=ref,
                ) from failed.__cause__
