"""A shared task's failure, taken as heard: each of its waiters was told, and there may be none."""

import asyncio

__all__ = ["heard"]


def heard(task: asyncio.Task[object]) -> None:
    """Retrieve `task`'s failure, which asyncio logs when nobody retrieved it."""
    if not task.cancelled():
        task.exception()
