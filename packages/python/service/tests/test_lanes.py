"""The lanes: a lane's work in its order, the lanes beside each other, work done alone, and what closing them gives up."""

import asyncio

import pytest
from aio import run

from semiont_service.lanes import Lanes


def test_a_lanes_work_is_done_one_at_a_time_in_order_and_lanes_work_beside_each_other() -> None:
    async def scenario() -> None:
        lanes = Lanes()
        done: list[str] = []
        inside: dict[str, int] = {"a": 0, "b": 0}
        gate = asyncio.Event()

        def work(lane: str, name: str) -> None:
            async def doing() -> None:
                inside[lane] += 1
                assert inside[lane] == 1, "two pieces of one lane's work at once"
                await gate.wait()
                done.append(name)
                inside[lane] -= 1

            lanes.put(lane, doing)

        for name in ("a1", "a2", "a3"):
            work("a", name)
        work("b", "b1")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        # Each lane is in the middle of its first piece: the two work beside each other.
        assert inside == {"a": 1, "b": 1}
        gate.set()
        await lanes.settled()
        assert [name for name in done if name.startswith("a")] == ["a1", "a2", "a3"]
        assert "b1" in done
        await lanes.aclose()

    run(scenario())


def test_work_run_in_a_lane_answers_what_it_answers_and_raises_what_it_raises() -> None:
    async def scenario() -> None:
        lanes = Lanes()

        async def answers() -> int:
            return 7

        async def raises() -> int:
            raise LookupError("not there")

        assert await lanes.run("a", answers) == 7
        with pytest.raises(LookupError, match="not there"):
            await lanes.run("a", raises)
        # The lane goes on after work that raised.
        assert await lanes.run("a", answers) == 7
        await lanes.aclose()

    run(scenario())


def test_work_done_alone_waits_for_every_lane_and_no_lane_starts_until_it_is_over() -> None:
    async def scenario() -> None:
        lanes = Lanes()
        said: list[str] = []
        first_may_end, alone_may_end = asyncio.Event(), asyncio.Event()

        async def first() -> None:
            said.append("first begins")
            await first_may_end.wait()
            said.append("first ends")

        async def second() -> None:
            said.append("second")

        async def whole() -> None:
            async with lanes.alone():
                said.append("alone begins")
                await alone_may_end.wait()
                said.append("alone ends")

        lanes.put("a", first)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        working_alone = asyncio.ensure_future(whole())
        await asyncio.sleep(0)
        lanes.put("b", second)
        for _ in range(5):
            await asyncio.sleep(0)
        assert said == ["first begins"]

        first_may_end.set()
        for _ in range(5):
            await asyncio.sleep(0)
        assert said == ["first begins", "first ends", "alone begins"]

        alone_may_end.set()
        await working_alone
        await lanes.settled()
        assert said == ["first begins", "first ends", "alone begins", "alone ends", "second"]
        await lanes.aclose()

    run(scenario())


def test_closed_lanes_give_up_what_they_were_doing_and_nobody_is_left_waiting() -> None:
    async def scenario() -> None:
        lanes = Lanes()
        never = asyncio.Event()

        async def waits() -> int:
            await never.wait()
            return 1

        waiting = asyncio.ensure_future(lanes.run("a", waits))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await lanes.aclose()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        with pytest.raises(RuntimeError, match="stopping"):
            await lanes.run("a", waits)

        async def nothing() -> None:
            raise AssertionError("work put on closed lanes was done")

        lanes.put("a", nothing)
        await lanes.settled()

    run(scenario())


def test_a_lane_with_no_work_left_is_gone() -> None:
    async def scenario() -> None:
        lanes = Lanes()

        async def nothing() -> None:
            return None

        for lane in range(100):
            await lanes.run(str(lane), nothing)
        await lanes.settled()
        assert vars(lanes)["_working"] == {}
        assert vars(lanes)["_waiting"] == {}
        await lanes.aclose()

    run(scenario())
