"""A task several callers wait on: whoever stops waiting does not stop it, and one its owner ended gives nothing."""

import asyncio

__all__ = ["answer", "heard"]


def heard(task: asyncio.Task[object]) -> None:
    """Retrieve `task`'s failure, which asyncio logs when nobody retrieved it: each of its waiters was told, and there may be none."""
    if not task.cancelled():
        task.exception()


async def answer[T](task: asyncio.Task[T]) -> T | None:
    """What `task` gives, or raises; nothing when its owner ended it.

    A waiter that is cancelled is cancelled alone: `task` goes on for the
    others. One its owner ended, as a close ends what nobody is left to give
    it to, gives its waiters nothing rather than a cancellation none of them
    had.
    """
    await asyncio.wait([task])
    if task.cancelled():
        return None
    return task.result()
