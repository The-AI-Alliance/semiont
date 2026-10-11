"""Running a test that waits: a scenario is a coroutine, a test runs it to its end, and the clock it waits by is the test's to move."""

import asyncio
import signal
from collections.abc import Awaitable, Coroutine
from types import FrameType
from typing import Final, final, override

_REAL_SECONDS_A_SCENARIO_IS_GIVEN: Final = 30


@final
class SteppedLoop(asyncio.SelectorEventLoop):
    """A loop whose clock a test can move ahead: what is due in ten minutes is due once the test says ten minutes have passed."""

    def __init__(self) -> None:
        super().__init__()
        self.ahead = 0.0

    @override
    def time(self) -> float:
        return super().time() + self.ahead


def run[T](scenario: Coroutine[None, None, T]) -> T:
    """Run `scenario` on a loop of its own, and fail if it left a task behind.

    A scenario waits by the loop's clock, which the test moves. One that
    waits out real time instead has lost its way: what it waits for is due by
    a clock nobody is moving. After thirty real seconds it is ended where it
    waits, and its test fails.
    """

    async def held() -> T:
        result = await scenario
        left = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        assert left == [], f"tasks left running: {left}"
        return result

    def lost(signal_number: int, frame: FrameType | None) -> None:
        raise AssertionError(
            f"the scenario waited out {_REAL_SECONDS_A_SCENARIO_IS_GIVEN} real seconds: "
            "what it waits for is not due by the clock the test moves"
        )

    handled_before = signal.signal(signal.SIGALRM, lost)
    signal.setitimer(signal.ITIMER_REAL, _REAL_SECONDS_A_SCENARIO_IS_GIVEN)
    try:
        return asyncio.run(held(), loop_factory=SteppedLoop)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handled_before)


async def turns() -> None:
    """Give the loop turns enough for what is due, and whatever that wakes, to run."""
    for _ in range(10):
        await asyncio.sleep(0)


async def under_way[T](work: Awaitable[T]) -> asyncio.Future[T]:
    """`work`, begun, and run as far as its first wait: what it then waits for, it waits for by the clock as it stands now."""
    begun = asyncio.ensure_future(work)
    await turns()
    return begun


async def pass_time(seconds: float, *, step: float) -> None:
    """Move the loop's clock `seconds` ahead, a `step` at a time. What came due at a step runs before the next. No real time is waited."""
    loop = asyncio.get_running_loop()
    assert isinstance(loop, SteppedLoop), "the scenario is not run by `run`"
    passed = 0.0
    while passed < seconds:
        ahead = min(step, seconds - passed)
        loop.ahead += ahead
        passed += ahead
        await turns()
