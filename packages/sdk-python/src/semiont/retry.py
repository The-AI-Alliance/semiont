"""Trying again: which failures are worth another attempt, and how long to keep at it.

The two are separate questions. A `RetryRule` answers the first for one
context, as `specs/src/retry/cases.json` states it. A `RetryPolicy` answers
the second: a budget of attempts, and the backoff between them. The budgets a
client keeps are `specs/src/client/timing.json`'s (`semiont.timing`).
"""

import asyncio
import random
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final, final

from semiont.errors import SemiontError

__all__ = [
    "BOOT",
    "REFRESH",
    "RETRY_RULES",
    "TRANSPORT",
    "RetryFacts",
    "RetryPolicy",
    "RetryRule",
    "equal_jitter",
    "retry_after_ms",
    "retry_with_backoff",
]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class RetryPolicy:
    """A retry budget: how many attempts, and the backoff between them."""

    attempts: int
    """How many times it is tried in all, the first included."""
    initial_delay_ms: int
    """The wait before the second attempt; each later wait doubles it."""
    max_delay_ms: int
    """The longest any wait grows to."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class RetryFacts:
    """What is known of a failure when someone asks whether to try again. What is not stated is `None`."""

    status: int | None = None
    method: str | None = None


@final
@dataclass(frozen=True, slots=True)
class RetryRule:
    """Which failures one context tries again."""

    name: str
    retryable: Callable[[RetryFacts], bool]


def _boot(facts: RetryFacts) -> bool:
    return facts.status in (429, 503, 504)


BOOT: Final = RetryRule("boot", _boot)
"""A boot pass or a bus request, where the peer is usually seconds from ready:
the statuses that say "up, but not now". A `500` is not among them: replaying
it re-runs whatever broke it."""

# Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2).
_IDEMPOTENT_METHODS: Final = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"})


def _transport(facts: RetryFacts) -> bool:
    if facts.status is None:
        return False
    if facts.status == 401:
        return True
    repeatable = facts.method is not None and facts.method.upper() in _IDEMPOTENT_METHODS
    return repeatable and facts.status in (408, 413, 429, 500, 502, 503, 504)


TRANSPORT: Final = RetryRule("transport", _transport)
"""An HTTP client that can renew its token. A `401` is retried on any method:
the request was rejected, not processed, and a renewed token makes it valid.
Every other retryable status applies only to a method that cannot cause a
second effect, because a POST answered `502` may already have been processed."""


def _refresh(facts: RetryFacts) -> bool:
    return facts.status is None or facts.status in (408, 429) or facts.status >= 500


REFRESH: Final = RetryRule("refresh", _refresh)
"""Exchanging a refresh token at its issuer. The issuer's answer is the verdict
and its absence never is: no response at all, or one saying "not now", is
transient; a refused grant, and any fault this rule does not name, is
terminal, because trying again only delays a sign-in the person must perform
anyway."""

RETRY_RULES: Final[Mapping[str, RetryRule]] = MappingProxyType({rule.name: rule for rule in (BOOT, REFRESH, TRANSPORT)})
"""Every rule this SDK keeps, by its name in the table."""

_WHOLE_SECONDS: Final = re.compile(r"[0-9]+", re.ASCII)


def retry_after_ms(header: str | None) -> int | None:
    """The wait a `Retry-After` header states, when it gives whole seconds, the form the gateway sends."""
    if header is None:
        return None
    stated = header.strip()
    return int(stated) * 1000 if _WHOLE_SECONDS.fullmatch(stated) else None


def equal_jitter(cap_ms: float) -> float:
    """Half of `cap_ms`, and a random share of the other half.

    Callers that back off by one schedule against one gateway come back at the
    same instant and deliver again the burst that failed. The random half
    keeps them apart, and the wait never exceeds the cap.
    """
    return cap_ms / 2 + random.random() * (cap_ms / 2)


async def _set_within(event: asyncio.Event, wait_ms: float) -> bool:
    """Whether `event` was set by the end of the wait, which ends as soon as it is."""
    try:
        async with asyncio.timeout(wait_ms / 1000):
            await event.wait()
    except TimeoutError:
        return False
    return True


async def retry_with_backoff[T](
    policy: RetryPolicy,
    attempt: Callable[[], Awaitable[T]],
    *,
    retryable: Callable[[SemiontError], bool],
    give_up: asyncio.Event,
) -> T:
    """Run `attempt` until it succeeds, `policy`'s attempts are spent, or it fails in a way `retryable` does not accept.

    The wait before each further attempt is the policy's jittered backoff, and
    never less than the wait the failure itself stated (a refusal's
    `Retry-After`). Once `give_up` is set no further attempt is made, and a
    wait in progress ends. The last failure is raised as it was.
    """
    cap_ms = policy.initial_delay_ms
    made = 1
    while True:
        try:
            return await attempt()
        except SemiontError as error:
            if made >= policy.attempts or give_up.is_set() or not retryable(error):
                raise
            wait_ms = max(equal_jitter(cap_ms), error.retry_after_ms or 0)
            if await _set_within(give_up, wait_ms):
                raise
        cap_ms = min(cap_ms * 2, policy.max_delay_ms)
        made += 1
