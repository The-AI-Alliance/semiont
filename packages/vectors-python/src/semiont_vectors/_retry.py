"""Asking an embedding provider again: how long a start waits for one to be ready, and the loop that waits.

The SDK's loop (`semiont.retry.retry_with_backoff`) asks again after the
SDK's own failures alone, and a provider's failure is none of them. What a
budget is, and how each wait is spread, are the SDK's.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Final

from semiont.retry import RetryPolicy, equal_jitter

from semiont_vectors.embedding import EmbeddingProviderError

EMBEDDING_PROVIDER_RETRY: Final = RetryPolicy(attempts=12, initial_delay_ms=1_000, max_delay_ms=15_000)
"""How long a start waits for an embedding provider to be ready.

Twelve attempts, with waits between them of at most 1, 2, 4 and 8 seconds
and then 15. Each wait is at least half of its most, so the eleven of them
come to between 60 and 120 seconds, beside what the attempts themselves
take. It is sized for a model that is being fetched, which has been measured
at under a minute, and not for a peer that is seconds from listening.
"""


async def asked_again[T](policy: RetryPolicy, attempt: Callable[[], Awaitable[T]], *, again: Callable[[EmbeddingProviderError], bool]) -> T:
    """What `attempt` answers, asked again after each failure `again` accepts, until `policy`'s attempts are spent.

    The wait before each further attempt is the policy's, spread by
    `equal_jitter`. The failure of the last attempt is raised as it is, and
    so is the first failure `again` does not accept.

    Nothing but a provider's failure is caught. Whoever cancels this stops
    it at once, in an attempt or in a wait.
    """
    cap_ms = policy.initial_delay_ms
    for _ in range(policy.attempts - 1):
        try:
            return await attempt()
        except EmbeddingProviderError as failed:
            if not again(failed):
                raise
        await asyncio.sleep(equal_jitter(cap_ms) / 1000)
        cap_ms = min(cap_ms * 2, policy.max_delay_ms)
    return await attempt()
