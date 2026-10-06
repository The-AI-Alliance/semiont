"""A sequence of events: every reader is given every one, in order, whatever the others do."""

import asyncio
import gc

from aio import run, soon

from semiont.events import Broadcast


def test_a_reader_that_falls_behind_loses_nothing_and_delays_nobody() -> None:
    async def scenario() -> tuple[list[int], list[int]]:
        broadcast: Broadcast[int] = Broadcast()
        slow, prompt = broadcast.listen(), broadcast.listen()
        kept_up: list[int] = []

        async def read() -> None:
            async for item in prompt:
                kept_up.append(item)

        reader = asyncio.create_task(read())
        for item in range(10_000):
            assert broadcast.deliver(item) == 2
            if item % 100 == 0:
                await asyncio.sleep(0)
        await asyncio.sleep(0)
        # The prompt reader has everything while the slow one has read nothing.
        assert kept_up == list(range(10_000))
        broadcast.close()
        await soon(reader)
        return kept_up, [item async for item in slow]

    kept_up, behind = run(scenario())
    assert kept_up == behind == list(range(10_000))


def test_a_reader_begins_where_it_began_to_listen() -> None:
    async def scenario() -> list[str]:
        broadcast: Broadcast[str] = Broadcast()
        broadcast.deliver("before")
        events = broadcast.listen()
        broadcast.deliver("after")
        broadcast.close()
        return [item async for item in events]

    assert run(scenario()) == ["after"]


def test_a_reader_that_stops_listening_is_kept_nothing_and_one_that_is_dropped_is_forgotten() -> None:
    async def scenario() -> tuple[int, int, int]:
        broadcast: Broadcast[int] = Broadcast()
        async with broadcast.listen() as left:
            listening = broadcast.deliver(1)
        after_leaving = broadcast.deliver(2)
        assert [item async for item in left] == []
        dropped = broadcast.listen()
        assert broadcast.deliver(3) == 1
        del dropped
        gc.collect()
        return listening, after_leaving, broadcast.deliver(4)

    assert run(scenario()) == (1, 0, 0)


def test_a_closed_broadcast_ends_its_readers_after_what_they_were_given_and_every_later_one_at_once() -> None:
    async def scenario() -> tuple[list[int], list[int]]:
        broadcast: Broadcast[int] = Broadcast()
        events = broadcast.listen()
        broadcast.deliver(1)
        broadcast.close()
        assert broadcast.deliver(2) == 0
        return [item async for item in events], [item async for item in broadcast.listen()]

    assert run(scenario()) == ([1], [])
