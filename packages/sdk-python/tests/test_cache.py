"""The cache a client's live queries answer from, held to `docs/protocol/CACHE-SEMANTICS.md` clause by clause.

Each test names the clause it holds. The service is one a test answers for,
so every request waits until the test says how it ends.
"""

import asyncio
import gc
import logging
from collections.abc import AsyncIterator, Coroutine, Mapping
from typing import final, override

import pytest
from aio import pass_time, run, soon, turns

from semiont.cache import SAVE_DEBOUNCE_MS, Cache, CachePersister, CacheState, Failed, Pending, Ready, Runs
from semiont.errors import BusRequestError, SemiontError

KEY = "k"


@final
class Tasks(Runs):
    """What runs a cache's fetches, as a client does: each is ended when the test closes it."""

    def __init__(self) -> None:
        self.running: set[asyncio.Task[object]] = set()

    @override
    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        task = asyncio.ensure_future(work)
        self.running.add(task)
        task.add_done_callback(self.running.discard)
        return task

    async def close(self) -> None:
        tasks = list(self.running)
        for task in tasks:
            task.cancel()
        # Each ends when it is told to: one that goes on is a fault, not a wait.
        await soon(asyncio.gather(*tasks, return_exceptions=True))


@final
class Service:
    """A service a test answers for: each request waits until the test says what it is answered."""

    def __init__(self) -> None:
        self.asked: list[str] = []
        """The key of each request, in the order they were made."""
        self._waiting: list[asyncio.Future[int]] = []

    async def fetch(self, key: str) -> int:
        self.asked.append(key)
        answer: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self._waiting.append(answer)
        return await answer

    def answer(self, request: int, value: int) -> None:
        self._waiting[request].set_result(value)

    def fail(self, request: int, why: str = "the service is down") -> BusRequestError:
        error = BusRequestError("bus.timeout", why)
        self._waiting[request].set_exception(error)
        return error


@final
class Kept(CachePersister[str, int]):
    """A persister that holds what it was given, and counts the saves."""

    def __init__(self, kept: Mapping[str, int] | None = None) -> None:
        self.kept = kept
        self.saves: list[dict[str, int]] = []

    @override
    def load(self) -> Mapping[str, int] | None:
        return self.kept

    @override
    def save(self, entries: Mapping[str, int]) -> None:
        self.saves.append(dict(entries))


def world(persister: Kept | None = None) -> tuple[Cache[str, int], Service, Tasks]:
    service, tasks = Service(), Tasks()
    return Cache(service.fetch, tasks=tasks, persister=persister), service, tasks


def owing(cache: Cache[str, int]) -> bool:
    """Whether the cache has not yet kept what it knows, read now."""
    return cache.persistence_pending


async def now(observing: AsyncIterator[CacheState[int]]) -> CacheState[int]:
    """The state an observer is given next, which is to be there already or soon."""
    state = await soon(anext(observing))
    await turns()
    return state


async def nothing_more(observing: AsyncIterator[CacheState[int]]) -> asyncio.Task[CacheState[int]]:
    """A read of the observer's next state, which is not to have come."""
    reading = asyncio.ensure_future(anext(observing))
    await turns()
    assert not reading.done(), f"the observer was given {reading.result()}"
    return reading


async def ready(cache: Cache[str, int], service: Service, value: int) -> AsyncIterator[CacheState[int]]:
    """An observer of `KEY`, which the first request of `service` has answered `value`."""
    observing = cache.observe(KEY)
    assert await now(observing) == Pending()
    service.answer(0, value)
    assert await now(observing) == Ready(value)
    return observing


def test_b1_the_first_observer_of_a_key_sees_it_pending_costs_one_request_and_sees_its_answer() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        assert cache.get(KEY) is None
        assert not cache.known(KEY)
        observing = cache.observe(KEY)
        assert await now(observing) == Pending()
        assert service.asked == [KEY]
        assert cache.known(KEY)
        assert cache.keys() == [KEY]
        service.answer(0, 7)
        assert await now(observing) == Ready(7)
        assert cache.get(KEY) == 7
        assert service.asked == [KEY]
        await tasks.close()

    run(scenario())


def test_b2_a_later_observer_is_given_the_value_and_costs_no_request() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        await ready(cache, service, 7)
        later = cache.observe(KEY)
        assert await now(later) == Ready(7)
        assert service.asked == [KEY]
        await tasks.close()

    run(scenario())


def test_b3_observers_that_arrive_before_the_value_share_one_request_and_see_the_same_value() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        one, other = cache.observe(KEY), cache.observe(KEY)
        assert (await now(one), await now(other)) == (Pending(), Pending())
        assert service.asked == [KEY]
        # A one-shot read while it is in flight joins it too.
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        assert service.asked == [KEY]
        service.answer(0, 7)
        assert (await now(one), await now(other), await soon(read)) == (Ready(7), Ready(7), 7)
        await tasks.close()

    run(scenario())


def test_b6_a_refetch_that_fails_and_fails_again_leaves_the_value_it_was_to_replace() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = await ready(cache, service, 1)
        cache.invalidate(KEY)
        waiting = await nothing_more(observing)
        service.fail(1)
        await turns()
        service.fail(2)
        await turns()
        # The value stays, and the key is never failed: stale beats an error.
        assert service.asked == [KEY, KEY, KEY]
        assert cache.get(KEY) == 1
        assert not waiting.done()
        assert await now(cache.observe(KEY)) == Ready(1)
        waiting.cancel()
        await tasks.close()

    run(scenario())


def test_b7_invalidating_asks_again_and_shows_the_value_until_the_new_one_arrives() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = await ready(cache, service, 1)
        cache.invalidate(KEY)
        waiting = await nothing_more(observing)
        assert service.asked == [KEY, KEY]
        assert cache.get(KEY) == 1
        service.answer(1, 2)
        assert await soon(waiting) == Ready(2)
        await tasks.close()

    run(scenario())


def test_b8_invalidating_a_key_nobody_asked_for_asks_for_it() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        cache.invalidate(KEY)
        await turns()
        assert service.asked == [KEY]
        assert cache.known(KEY)
        service.answer(0, 4)
        await turns()
        assert cache.get(KEY) == 4
        # And one whose only request failed twice is pending again when it is invalidated.
        other = cache.observe("other")
        assert await now(other) == Pending()
        service.fail(1)
        await turns()
        failure = service.fail(2)
        assert await now(other) == Failed(failure)
        cache.invalidate("other")
        assert await now(other) == Pending()
        service.answer(3, 9)
        assert await now(other) == Ready(9)
        await tasks.close()

    run(scenario())


def test_b9_invalidating_while_a_fetch_is_in_flight_starts_another_and_the_last_answer_is_the_value() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = cache.observe(KEY)
        assert await now(observing) == Pending()
        cache.invalidate(KEY)
        await turns()
        # Not joined: the one in flight may never be answered.
        assert service.asked == [KEY, KEY]
        service.answer(1, 5)
        assert await now(observing) == Ready(5)
        # And when it is answered after all, it is as new as what was there.
        service.answer(0, 3)
        assert await now(observing) == Ready(3)
        # The newer fetch's end did not clear the way for a third: nothing is in flight, and the next observer asks nothing.
        assert await now(cache.observe(KEY)) == Ready(3)
        assert service.asked == [KEY, KEY]
        await tasks.close()

    run(scenario())


def test_b9_a_fetch_that_was_let_go_of_does_not_take_the_place_of_the_one_after_it() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        cache.observe(KEY)
        await turns()
        cache.invalidate(KEY)
        await turns()
        # The older ends first, while the newer is still in flight: a read now joins the newer.
        service.answer(0, 3)
        await turns()
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        assert service.asked == [KEY, KEY]
        service.answer(1, 5)
        assert await soon(read) == 5
        await tasks.close()

    run(scenario())


def test_b10_keys_are_independent() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        one, other = cache.observe("a"), cache.observe("b")
        assert (await now(one), await now(other)) == (Pending(), Pending())
        assert service.asked == ["a", "b"]
        service.answer(1, 2)
        assert await now(other) == Ready(2)
        waiting = await nothing_more(one)
        cache.invalidate("b")
        await turns()
        assert service.asked == ["a", "b", "b"]
        assert sorted(cache.keys()) == ["a", "b"]
        cache.invalidate_all()
        await turns()
        assert sorted(service.asked[3:]) == ["a", "b"]
        waiting.cancel()
        await tasks.close()

    run(scenario())


def test_b14_a_fetch_for_an_observer_that_fails_is_made_once_more_and_no_more() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = cache.observe(KEY)
        assert await now(observing) == Pending()
        service.fail(0)
        waiting = await nothing_more(observing)
        assert service.asked == [KEY, KEY]
        service.answer(1, 7)
        assert await soon(waiting) == Ready(7)
        await turns()
        assert service.asked == [KEY, KEY]
        await tasks.close()

    run(scenario())


def test_b14_a_one_shot_read_is_never_retried_and_its_failure_is_its_callers_alone() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        failure = service.fail(0)
        with pytest.raises(BusRequestError) as raised:
            await soon(read)
        assert raised.value is failure
        await turns()
        assert service.asked == [KEY]
        # A failure writes nothing: the key is as it was, and its first observer asks.
        assert cache.get(KEY) is None
        observing = cache.observe(KEY)
        assert await now(observing) == Pending()
        assert service.asked == [KEY, KEY]
        await tasks.close()

    run(scenario())


def test_b14_the_retry_joins_a_fetch_another_caller_started_meanwhile() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = cache.observe(KEY)
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        assert service.asked == [KEY]
        failure = service.fail(0)
        with pytest.raises(BusRequestError) as raised:
            await soon(read)
        assert raised.value is failure
        # The observer's retry is one request, and a read made while it is in flight is the same one.
        again = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        assert service.asked == [KEY, KEY]
        service.answer(1, 7)
        assert await soon(again) == 7
        assert await now(observing) == Ready(7)
        await tasks.close()

    run(scenario())


def test_b15_a_key_with_no_value_whose_retry_fails_too_is_failed_for_every_observer_who_live_on() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        one, other = cache.observe(KEY), cache.observe(KEY)
        assert (await now(one), await now(other)) == (Pending(), Pending())
        service.fail(0, "the first")
        await turns()
        failure = service.fail(1, "the retry")
        # The retry's failure, not the first's.
        assert await now(one) == Failed(failure)
        assert await now(other) == Failed(failure)
        assert cache.known(KEY)
        assert cache.get(KEY) is None
        assert service.asked == [KEY, KEY]

        # An observer arriving starts over, for everyone: all three are pending, and then ready.
        arriving = cache.observe(KEY)
        assert await now(arriving) == Pending()
        assert (await now(one), await now(other)) == (Pending(), Pending())
        assert service.asked == [KEY, KEY, KEY]
        service.answer(2, 7)
        assert (await now(one), await now(other), await now(arriving)) == (Ready(7), Ready(7), Ready(7))
        await tasks.close()

    run(scenario())


def test_b15_a_failed_key_is_made_ready_by_a_value_however_it_comes_with_no_pending_between() -> None:
    async def scenario() -> None:
        async def failed() -> tuple[Cache[str, int], Service, Tasks, AsyncIterator[CacheState[int]]]:
            cache, service, tasks = world()
            observing = cache.observe(KEY)
            assert await now(observing) == Pending()
            service.fail(0)
            await turns()
            failure = service.fail(1)
            assert await now(observing) == Failed(failure)
            return cache, service, tasks, observing

        # A value that is known.
        cache, service, tasks, observing = await failed()
        cache.set(KEY, 3)
        assert await now(observing) == Ready(3)
        assert service.asked == [KEY, KEY]
        await tasks.close()

        # A one-shot read's answer.
        cache, service, tasks, observing = await failed()
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        service.answer(2, 4)
        assert await soon(read) == 4
        assert await now(observing) == Ready(4)
        await tasks.close()

    run(scenario())


def test_b13a_a_removed_key_is_failed_as_it_was_told_at_once_and_nothing_is_asked_for() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = await ready(cache, service, 1)
        gone = BusRequestError("bus.not-found", "it was removed")
        cache.remove(KEY, gone)
        assert await now(observing) == Failed(gone)
        assert cache.get(KEY) is None
        assert cache.known(KEY)
        assert service.asked == [KEY]
        # An observer arriving asks the service, which is who knows.
        arriving = cache.observe(KEY)
        assert await now(arriving) == Pending()
        assert service.asked == [KEY, KEY]
        # A fetch in flight when the key is removed is let go of: a read after it does not join it.
        cache.remove(KEY, gone)
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        assert service.asked == [KEY, KEY, KEY]
        read.cancel()
        await tasks.close()

    run(scenario())


def test_a_value_that_is_known_is_written_and_nothing_is_asked_for() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        cache.set(KEY, 3)
        assert cache.get(KEY) == 3
        observing = cache.observe(KEY)
        assert await now(observing) == Ready(3)
        cache.set(KEY, 4)
        assert await now(observing) == Ready(4)
        assert service.asked == []
        await tasks.close()

    run(scenario())


def test_an_observer_that_falls_behind_is_given_the_latest_state_not_each_it_missed() -> None:
    async def scenario() -> None:
        cache, _, tasks = world()
        cache.set(KEY, 1)
        observing = cache.observe(KEY)
        assert await now(observing) == Ready(1)
        cache.set(KEY, 2)
        cache.set(KEY, 3)
        assert await now(observing) == Ready(3)
        (await nothing_more(observing)).cancel()
        await tasks.close()

    run(scenario())


def test_b16_disposing_ends_every_observer_and_nothing_is_asked_or_written_after() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = await ready(cache, service, 1)
        waiting = cache.observe("waiting")
        assert await now(waiting) == Pending()
        cache.dispose()
        cache.dispose()
        assert await soon(anext(observing, None)) is None
        assert await soon(anext(waiting, None)) is None

        # An observer arriving is given nothing, and costs nothing.
        assert await soon(anext(cache.observe(KEY), None)) is None
        assert await soon(anext(cache.observe("new"), None)) is None
        with pytest.raises(BusRequestError) as raised:
            await soon(cache.fetch(KEY))
        assert raised.value.code == "bus.closed"
        cache.invalidate(KEY)
        cache.invalidate_all()
        cache.set(KEY, 9)
        cache.remove(KEY, BusRequestError("bus.not-found", "gone"))
        await turns()
        assert service.asked == [KEY, "waiting"]
        assert (cache.get(KEY), cache.known(KEY), cache.keys()) == (None, False, [])

        # What was in flight is answered into nothing.
        service.answer(1, 5)
        await turns()
        assert cache.get("waiting") is None
        await tasks.close()

    run(scenario())


def test_b16_a_retry_that_straddles_the_disposal_is_never_made() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        observing = cache.observe(KEY)
        assert await now(observing) == Pending()
        cache.dispose()
        service.fail(0)
        await turns()
        assert service.asked == [KEY]
        assert tasks.running == set()

    run(scenario())


def test_a_read_whose_fetch_its_clients_closing_ended_fails_as_closed_and_one_that_is_abandoned_is_only_abandoned() -> None:
    async def scenario() -> None:
        cache, service, tasks = world()
        abandoned = asyncio.ensure_future(cache.fetch(KEY))
        read = asyncio.ensure_future(cache.fetch(KEY))
        await turns()
        # Its caller stops waiting: the fetch goes on for the other.
        abandoned.cancel()
        await turns()
        assert abandoned.cancelled()
        assert not read.done()
        assert service.asked == [KEY]
        await tasks.close()
        with pytest.raises(BusRequestError) as raised:
            await soon(read)
        assert raised.value.code == "bus.closed"

    run(scenario())


def test_b17_a_cache_begins_with_what_was_kept_and_b18_asks_for_it_anew_the_first_time_it_is_observed() -> None:
    async def scenario() -> None:
        persister = Kept({KEY: 1, "unobserved": 2})
        cache, service, tasks = world(persister)
        assert cache.get(KEY) == 1
        assert sorted(cache.keys()) == [KEY, "unobserved"]
        assert service.asked == []

        # Shown at once, with no pending before it, and asked for again: nothing says it is still true.
        observing = cache.observe(KEY)
        assert await now(observing) == Ready(1)
        assert service.asked == [KEY]
        # Once: a second observer, while that is in flight and after, asks nothing.
        assert await now(cache.observe(KEY)) == Ready(1)
        service.answer(0, 5)
        assert await now(observing) == Ready(5)
        assert await now(cache.observe(KEY)) == Ready(5)
        assert service.asked == [KEY]
        # Only what is observed: the other kept key cost nothing.
        assert cache.get("unobserved") == 2
        await tasks.close()

    run(scenario())


def test_b18_a_kept_value_whose_revalidation_fails_twice_stays_and_is_not_asked_for_a_third_time() -> None:
    async def scenario() -> None:
        cache, service, tasks = world(Kept({KEY: 1}))
        observing = cache.observe(KEY)
        assert await now(observing) == Ready(1)
        service.fail(0)
        await turns()
        service.fail(1)
        await turns()
        assert cache.get(KEY) == 1
        assert await now(cache.observe(KEY)) == Ready(1)
        assert service.asked == [KEY, KEY]
        await tasks.close()

    run(scenario())


@pytest.mark.parametrize("first", ["a read", "an invalidation", "a value that is known", "its removal"])
def test_b18_a_kept_value_is_no_longer_one_once_anything_has_asked_for_it_or_written_it(first: str) -> None:
    async def scenario() -> None:
        cache, service, tasks = world(Kept({KEY: 1}))
        asked = 1
        if first == "a read":
            read = asyncio.ensure_future(cache.fetch(KEY))
            await turns()
            service.answer(0, 2)
            assert await soon(read) == 2
        elif first == "an invalidation":
            cache.invalidate(KEY)
            await turns()
            service.answer(0, 2)
            await turns()
        elif first == "a value that is known":
            cache.set(KEY, 2)
            asked = 0
        else:
            cache.remove(KEY, BusRequestError("bus.not-found", "gone"))
            asked = 0
        assert len(service.asked) == asked
        observing = cache.observe(KEY)
        await now(observing)
        # The removed key is asked for by its first observer, as any failed key is: not because it was kept.
        assert len(service.asked) == (1 if first == "its removal" else asked)
        await tasks.close()

    run(scenario())


def test_b17_values_are_saved_once_they_have_stopped_changing_and_only_values() -> None:
    async def scenario() -> None:
        persister = Kept()
        cache, service, tasks = world(persister)
        assert not owing(cache)
        failing = cache.observe("failing")
        assert await now(failing) == Pending()
        # Fetching, it has not kept what it knows.
        assert owing(cache)
        service.fail(0)
        await turns()
        failure = service.fail(1)
        assert await now(failing) == Failed(failure)
        assert not owing(cache)

        cache.set("a", 1)
        assert owing(cache)
        await pass_time((SAVE_DEBOUNCE_MS - 10) / 1000, step=0.01)
        cache.set("b", 2)
        # The wait begins again with each change: a burst is one save.
        await pass_time((SAVE_DEBOUNCE_MS - 10) / 1000, step=0.01)
        assert persister.saves == []
        assert owing(cache)
        await pass_time(0.02, step=0.01)
        # A failure is not a value, and is not kept.
        assert persister.saves == [{"a": 1, "b": 2}]
        assert not owing(cache)

        # A removal is a change too, and what is gone is no longer kept.
        cache.remove("a", BusRequestError("bus.not-found", "gone"))
        assert owing(cache)
        await pass_time(0.1, step=0.01)
        assert persister.saves[1:] == [{"b": 2}]
        # And a fetched value is saved as a known one is.
        fetched = cache.observe("c")
        assert await now(fetched) == Pending()
        service.answer(2, 3)
        assert await now(fetched) == Ready(3)
        await pass_time(0.1, step=0.01)
        assert persister.saves[2:] == [{"b": 2, "c": 3}]
        await tasks.close()

    run(scenario())


def test_b17_disposing_makes_a_save_that_was_owed_at_once_and_none_is_made_after() -> None:
    async def scenario() -> None:
        persister = Kept()
        cache, _, tasks = world(persister)
        cache.set("a", 1)
        cache.dispose()
        assert persister.saves == [{"a": 1}]
        cache.set("b", 2)
        await pass_time(0.2, step=0.05)
        assert persister.saves == [{"a": 1}]

        # With nothing owed, disposing saves nothing.
        idle = Kept({"a": 1})
        resting, _, _ = world(idle)
        resting.dispose()
        assert idle.saves == []
        await tasks.close()

    run(scenario())


def test_a_cache_that_keeps_nothing_owes_nothing() -> None:
    async def scenario() -> None:
        cache, _, tasks = world()
        cache.observe(KEY)
        cache.set("a", 1)
        await turns()
        assert not owing(cache)
        await tasks.close()

    run(scenario())


def test_a_failure_nobody_waited_for_is_not_said_to_be_unheard(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> SemiontError:
        cache, service, tasks = world()
        cache.observe(KEY)
        await turns()
        # Let go of by an invalidation: nobody awaits the first fetch any more.
        cache.invalidate(KEY)
        await turns()
        failure = service.fail(0)
        service.answer(1, 2)
        await turns()
        await tasks.close()
        return failure

    with caplog.at_level(logging.ERROR, logger="asyncio"):
        run(scenario())
        gc.collect()
    assert [record for record in caplog.records if "never retrieved" in record.getMessage()] == []
