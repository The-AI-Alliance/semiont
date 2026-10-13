"""The limit of a search: the fewest answers a request may ask for.

A reference search and a text search each carry a `limit`
(`docs/protocol/LIBRARIAN.md` § Reference search, § Text search). One that
asks for fewer than one answer is refused before anything is read. This is
the one place that says what the bound is, and in what words.
"""

from typing import Final, final

__all__ = ["LEAST_LIMIT", "LimitRefused", "refuse_limit_below_least"]

LEAST_LIMIT: Final = 1
"""The fewest answers a search may be limited to."""


@final
class LimitRefused(Exception):
    """A search's limit is less than `LEAST_LIMIT`: nothing is read."""


def refuse_limit_below_least(limit: int | None) -> None:
    """Refuse a limit that is stated and is less than `LEAST_LIMIT`. A request that states none is not refused.

    Raises `LimitRefused`, whose words are what the failure channel carries.
    """
    if limit is not None and limit < LEAST_LIMIT:
        raise LimitRefused(f"limit must be at least {LEAST_LIMIT}")
