"""What a service connects to as it starts: what answers within the minute is answered, what does not is refused by name and given up."""

import asyncio

import pytest
from aio import pass_time, run, under_way

from semiont_service.config import Refused
from semiont_service.connect import connected


def test_what_answers_within_the_minute_is_answered() -> None:
    async def scenario() -> None:
        answering = asyncio.Event()

        async def connecting() -> str:
            await answering.wait()
            return "connected"

        waited = await under_way(connected("graph database", connecting()))
        # Short of the minute it is still waited for, and what it then answers is answered.
        await pass_time(59, step=1)
        assert not waited.done()
        answering.set()
        assert await waited == "connected"

    run(scenario())


def test_what_does_not_answer_within_the_minute_is_refused_by_name_and_given_up() -> None:
    async def scenario() -> None:
        given_up: list[str] = []

        async def connecting() -> None:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                given_up.append("cancelled")
                raise

        waited = await under_way(connected("graph database", connecting()))
        await pass_time(59, step=1)
        assert not waited.done()
        assert given_up == []
        await pass_time(2, step=1)
        assert waited.done()
        with pytest.raises(Refused) as refused:
            await waited
        assert str(refused.value) == "The graph database did not answer within 60 seconds"
        # What was waited for was cancelled where it waited: nothing of it is left running.
        assert given_up == ["cancelled"]

    run(scenario())
