"""Running a test that waits: a scenario is a coroutine, and a test runs it to its end."""

import asyncio
from collections.abc import Awaitable, Coroutine


def run[T](scenario: Coroutine[None, None, T]) -> T:
    """Run `scenario` on a loop of its own, and fail if it left a task behind."""

    async def held() -> T:
        result = await scenario
        left = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        assert left == [], f"tasks left running: {left}"
        return result

    return asyncio.run(held())


async def soon[T](wanted: Awaitable[T], within: float = 5.0) -> T:
    """`wanted`, which is to complete within `within` seconds."""
    async with asyncio.timeout(within):
        return await wanted
