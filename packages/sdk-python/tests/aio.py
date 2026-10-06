"""Running a test that waits: a scenario is a coroutine, and a test runs it to its end."""

import asyncio
from collections.abc import Awaitable, Coroutine
from typing import final, override


@final
class SteppedLoop(asyncio.SelectorEventLoop):
    """A loop whose clock a test can move ahead: what is due in an hour is due once the test says an hour has passed."""

    def __init__(self) -> None:
        super().__init__()
        self.ahead = 0.0

    @override
    def time(self) -> float:
        return super().time() + self.ahead


def run[T](scenario: Coroutine[None, None, T]) -> T:
    """Run `scenario` on a loop of its own, and fail if it left a task behind."""

    async def held() -> T:
        result = await scenario
        # What the loop had already been handed gets its turn: the HTTP library
        # ends a stream that was left early a turn or two after it was left.
        left: list[asyncio.Task[object]] = []
        for _ in range(20):
            left = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
            if not left:
                break
            await asyncio.sleep(0)
        assert left == [], f"tasks left running: {left}"
        return result

    return asyncio.run(held(), loop_factory=SteppedLoop)


async def soon[T](wanted: Awaitable[T], within: float = 5.0) -> T:
    """`wanted`, which is to complete within `within` seconds."""
    async with asyncio.timeout(within):
        return await wanted


async def turns(count: int = 10) -> None:
    """Let what is ready to run, run: `count` turns of the loop."""
    for _ in range(count):
        await asyncio.sleep(0)


async def pass_time(seconds: float, *, step: float = 1.0) -> None:
    """Move the loop's clock `seconds` ahead, a `step` at a time, and let what came due at each step run.

    Nothing real is waited for: what a step sets going is given turns of the
    loop, which is all that work held in memory needs.
    """
    loop = asyncio.get_running_loop()
    assert isinstance(loop, SteppedLoop), "the scenario is not run by `run`"
    passed = 0.0
    while passed < seconds:
        ahead = min(step, seconds - passed)
        loop.ahead += ahead
        passed += ahead
        await turns()


async def settle() -> None:
    """Wait a moment of real time: long enough for what is on a socket of this machine to be read."""
    await asyncio.sleep(0.03)


async def hurried[T](wanted: Awaitable[T]) -> T:
    """`wanted`, with the loop's clock moved ahead for as long as it is awaited: what it would wait out, it waits out at once.

    A quarter of a second of the loop's clock passes in a few thousandths of
    a real one, which is still time enough for a request of this machine to
    be answered before its deadline.
    """
    task = asyncio.ensure_future(wanted)
    try:
        while not task.done():
            await pass_time(0.25, step=0.25)
            await asyncio.sleep(0.002)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    return task.result()
