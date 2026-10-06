"""How often, and how long apart, something is tried again."""

from dataclasses import dataclass
from typing import final

__all__ = ["RetryPolicy"]


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
