"""A task several callers wait on: whoever stops waiting does not stop it, and once its owner is closing it gives them nothing."""

import asyncio

__all__ = ["answer", "heard"]


def heard(task: asyncio.Task[object]) -> None:
    """Retrieve `task`'s failure, which asyncio logs when nobody retrieved it: each of its waiters was told, and there may be none."""
    if not task.cancelled():
        task.exception()


async def answer[T](task: asyncio.Task[T], closing: asyncio.Event) -> T | None:
    """What `task` gives, or raises; nothing once `closing` is set, whether `task` has ended or not.

    A waiter that is cancelled is cancelled alone: `task` goes on for the
    others. Its owner sets `closing` as it closes, and each waiter is given
    nothing at once, rather than a cancellation none of them had, whether the
    owner then ends `task` or waits for it to end.
    """
    closed = asyncio.create_task(closing.wait())
    try:
        await asyncio.wait([task, closed], return_when=asyncio.FIRST_COMPLETED)
    finally:
        closed.cancel()
    return None if closing.is_set() else task.result()
