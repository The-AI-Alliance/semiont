"""A long-running operation: what awaiting it gives, what reading it gives, and that it is done once."""

import asyncio
from collections.abc import Callable

import pytest
from aio import run, soon

from semiont.errors import BusRequestError
from semiont.running import Running


def counting_to(last: int, started: list[int] | None = None) -> Running[int]:
    async def work(report: Callable[[int], None]) -> int:
        if started is not None:
            started.append(1)
        for n in range(1, last):
            report(n)
            await asyncio.sleep(0)
        return last

    return Running(lambda report: asyncio.ensure_future(work(report)))


def failing_after(reports: int) -> Running[int]:
    async def work(report: Callable[[int], None]) -> int:
        for n in range(1, reports + 1):
            report(n)
        raise BusRequestError("bus.rejected", "refused")

    return Running(lambda report: asyncio.ensure_future(work(report)))


def test_awaited_it_gives_the_final_value() -> None:
    async def scenario() -> int:
        return await soon(counting_to(3))

    assert run(scenario()) == 3


def test_read_it_gives_every_report_then_the_final_value_then_ends() -> None:
    async def scenario() -> list[int]:
        reader = aiter(counting_to(3))
        seen = [item async for item in reader]
        # It has ended, and stays ended.
        assert await anext(reader, None) is None
        return seen

    assert run(scenario()) == [1, 2, 3]


def test_a_failure_is_raised_where_the_final_value_would_have_been_given() -> None:
    async def awaited() -> None:
        with pytest.raises(BusRequestError, match="refused"):
            await soon(failing_after(2))

    async def read() -> list[int]:
        seen: list[int] = []

        async def reading() -> None:
            async for item in failing_after(2):
                seen.append(item)

        with pytest.raises(BusRequestError, match="refused"):
            await reading()
        return seen

    run(awaited())
    assert run(read()) == [1, 2]


def test_nothing_is_begun_until_it_is_awaited_or_read() -> None:
    async def scenario() -> None:
        started: list[int] = []
        running = counting_to(2, started)
        await asyncio.sleep(0.01)
        assert started == []
        assert await soon(running) == 2
        assert started == [1]

    run(scenario())


def test_it_is_awaited_or_read_once() -> None:
    async def scenario() -> None:
        awaited = counting_to(2)
        assert await soon(awaited) == 2
        with pytest.raises(RuntimeError, match="awaited or read once"):
            await awaited
        with pytest.raises(RuntimeError, match="awaited or read once"):
            aiter(awaited)

        read = counting_to(2)
        assert [item async for item in read] == [1, 2]
        with pytest.raises(RuntimeError, match="awaited or read once"):
            await read

    run(scenario())


def test_cancelling_whoever_awaits_or_reads_it_abandons_the_work() -> None:
    async def scenario() -> None:
        for consume in ("await", "read"):
            working = asyncio.Event()
            abandoned = asyncio.Event()

            async def work(report: Callable[[int], None], working: asyncio.Event = working, abandoned: asyncio.Event = abandoned) -> int:
                working.set()
                try:
                    await asyncio.sleep(3600)
                except asyncio.CancelledError:
                    abandoned.set()
                    raise
                return 1

            running = Running[int](lambda report: asyncio.ensure_future(work(report)))

            async def awaiting(running: Running[int] = running) -> int:
                return await running

            async def reading(running: Running[int] = running) -> list[int]:
                return [item async for item in running]

            consumer: asyncio.Task[object] = asyncio.ensure_future(awaiting() if consume == "await" else reading())
            await soon(working.wait())
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
            assert consumer.cancelled()
            await soon(abandoned.wait())

    run(scenario())


def test_work_that_was_ended_under_its_consumer_is_a_failure_to_hear_and_not_a_cancellation() -> None:
    async def scenario() -> None:
        tasks: list[asyncio.Task[int]] = []

        async def work(report: Callable[[int], None]) -> int:
            report(1)
            await asyncio.sleep(3600)
            return 2

        def start(report: Callable[[int], None]) -> asyncio.Task[int]:
            tasks.append(asyncio.ensure_future(work(report)))
            return tasks[0]

        async def read(running: Running[int]) -> list[int]:
            seen: list[int] = []

            async def reading() -> None:
                async for item in running:
                    seen.append(item)
                    tasks[0].cancel()

            with pytest.raises(BusRequestError) as closed:
                await reading()
            assert closed.value.code == "bus.closed"
            return seen

        # As a client that closes ends the work it started.
        assert await soon(read(Running(start))) == [1]

    run(scenario())
