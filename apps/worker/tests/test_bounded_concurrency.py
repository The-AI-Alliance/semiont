"""Work run a bounded number at a time. The bound is why it exists: with none, calls made at once are refused by a provider's rate limit."""

import asyncio

import pytest
from aio import run, turns

from semiont_worker.detection.bounded_concurrency import run_bounded


class Tracked:
    """A worker that keeps the most that were ever in flight at once, and what it was handed."""

    def __init__(self) -> None:
        self.in_flight = 0
        self.most_in_flight = 0
        self.handed: list[tuple[int, int]] = []

    async def __call__(self, item: int, index: int) -> int:
        self.handed.append((item, index))
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        await turns()
        self.in_flight -= 1
        return item * 2


def test_no_more_than_the_limit_are_in_flight_however_many_items_there_are() -> None:
    worker = Tracked()
    run(run_bounded(list(range(10)), 3, worker))
    assert worker.most_in_flight == 3


def test_a_limit_at_or_over_the_number_of_items_runs_them_all_at_once() -> None:
    worker = Tracked()
    run(run_bounded([1, 2, 3], 10, worker))
    assert worker.most_in_flight == 3


def test_a_limit_under_one_runs_one_at_a_time() -> None:
    worker = Tracked()
    assert run(run_bounded([1, 2, 3], 0, worker)) == [2, 4, 6]
    assert worker.most_in_flight == 1


def test_every_item_is_handed_over_once_with_its_place_and_the_results_are_in_the_items_order() -> None:
    async def worker(item: int, index: int) -> tuple[int, int]:
        # The later an item, the sooner it is done: the order they finish in is the reverse of the order they were given in.
        for _ in range(10 - index):
            await asyncio.sleep(0)
        return (item, index)

    assert run(run_bounded([10, 20, 30, 40], 4, worker)) == [(10, 0), (20, 1), (30, 2), (40, 3)]

    tracked = Tracked()
    assert run(run_bounded([5, 6, 7, 8, 9], 2, tracked)) == [10, 12, 14, 16, 18]
    assert sorted(tracked.handed) == [(5, 0), (6, 1), (7, 2), (8, 3), (9, 4)]


def test_no_items_is_no_work() -> None:
    worker = Tracked()
    assert run(run_bounded([], 4, worker)) == []
    assert worker.handed == []


def test_a_failure_is_raised_as_it_was_and_ends_the_run_no_item_is_begun_after_it_and_those_in_flight_are_cancelled() -> None:
    broke = RuntimeError("boom")
    begun: list[int] = []
    cancelled: list[int] = []

    async def worker(item: int, _index: int) -> int:
        begun.append(item)
        if item == 2:
            await asyncio.sleep(0)
            raise broke
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(item)
            raise
        return item

    async def scenario() -> None:
        with pytest.raises(RuntimeError) as raised:
            await run_bounded([1, 2, 3, 4, 5, 6], 3, worker)
        assert raised.value is broke

    run(scenario())
    assert begun == [1, 2, 3]
    assert sorted(cancelled) == [1, 3]


def test_a_run_its_caller_cancels_is_cancelled_with_everything_in_flight() -> None:
    cancelled: list[int] = []

    async def worker(item: int, _index: int) -> int:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(item)
            raise
        return item

    async def scenario() -> None:
        running = asyncio.ensure_future(run_bounded([1, 2, 3, 4], 2, worker))
        await turns()
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running

    run(scenario())
    assert sorted(cancelled) == [1, 2]
