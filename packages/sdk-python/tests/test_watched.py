"""A watched value: a reader holds what it is now, and is given what it becomes."""

import asyncio

import pytest
from aio import run, soon

from semiont.watched import NeverReached, Variable, reached


def test_a_reader_is_given_the_value_as_it_is_then_each_change() -> None:
    async def scenario() -> list[str]:
        value = Variable("a")
        seen: list[str] = []

        async def read() -> None:
            async for now in value:
                seen.append(now)

        reader = asyncio.create_task(read())
        await asyncio.sleep(0)
        value.set("b")
        await asyncio.sleep(0)
        value.set("c")
        value.end()
        await soon(reader)
        return seen

    assert run(scenario()) == ["a", "b", "c"]


def test_a_reader_that_is_slow_is_given_the_latest_not_each_step() -> None:
    async def scenario() -> list[int]:
        value = Variable(0)
        changes = aiter(value)
        first = await anext(changes)
        for step in range(1, 100):
            value.set(step)
        return [first, await anext(changes)]

    assert run(scenario()) == [0, 99]


def test_setting_the_value_it_has_is_no_change() -> None:
    async def scenario() -> bool:
        value = Variable("a")
        changes = aiter(value)
        await anext(changes)
        value.set("a")
        waiting = asyncio.ensure_future(anext(changes))
        await asyncio.sleep(0.01)
        still_waiting = not waiting.done()
        value.set("b")
        assert await soon(waiting) == "b"
        return still_waiting

    assert run(scenario())


def test_a_value_that_has_ended_ends_its_readers_and_changes_no_more() -> None:
    async def scenario() -> tuple[list[str], str]:
        value = Variable("a")
        value.set("b")
        value.end()
        value.set("c")
        return [now async for now in value], value.value

    assert run(scenario()) == (["b"], "b")


def test_reached_waits_for_a_value_that_holds_and_says_so_when_there_will_be_none() -> None:
    def at_least_three(now: int) -> bool:
        return now >= 3

    def more_than_three(now: int) -> bool:
        return now > 3

    async def scenario() -> int:
        value: Variable[int] = Variable(1)
        waiting = asyncio.ensure_future(reached(value, at_least_three))
        value.set(2)
        await asyncio.sleep(0)
        value.set(3)
        found = await soon(waiting)
        value.end()
        with pytest.raises(NeverReached):
            await soon(reached(value, more_than_three))
        return found

    assert run(scenario()) == 3
