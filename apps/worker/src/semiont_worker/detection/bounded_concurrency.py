"""Work run a bounded number at a time.

The units of a job that do not depend on one another may be asked about at
once, and the bound is the point of doing it here: with no bound, calls made
together are refused by a provider's rate limit, and with a bound of one, a
job of nine units waits nine times as long as a provider with room needs it
to. How many at once is the provider's to say (`max_concurrency`).
"""

import asyncio
from collections.abc import Awaitable, Callable, Sequence


async def run_bounded[T, R](items: Sequence[T], limit: int, worker: Callable[[T, int], Awaitable[R]]) -> list[R]:
    """Run `worker` over `items` with at most `limit` in flight at once, and answer what each gave, in the order of the items.

    `worker` is handed an item and its place among the items. The items are
    begun in their order, the next as soon as one in flight is done, so they
    finish in no order: what is to be done as each finishes is done inside
    `worker`. A `limit` under one runs one at a time.

    A failure `worker` raises ends the run, and is raised as it was: no item
    is begun after it, and those in flight are cancelled, so no call is left
    asking a model on behalf of work that has failed. The caller's own
    cancellation ends it the same way.
    """
    results: dict[int, R] = {}
    upcoming = iter(enumerate(items))

    async def pump() -> None:
        for index, item in upcoming:
            results[index] = await worker(item, index)

    pumps = [asyncio.create_task(pump()) for _ in range(max(1, min(limit, len(items))))]
    try:
        ended, _ = await asyncio.wait(pumps, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        # Whatever ended the wait, nothing is left in flight. A pump that is done takes no notice.
        for task in pumps:
            task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
    for task in pumps:
        if task in ended and (failure := task.exception()) is not None:
            raise failure
    return [results[index] for index in range(len(items))]
