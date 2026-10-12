"""The two folds a gather waits on: what `weave:applied` and `smelt:settled` have signalled of each resource.

The rules are `docs/protocol/LIBRARIAN.md`'s (§ The two waits, § Stopping).
A fold keeps the highest sequence number, or the last decision, signalled of
each resource. A wait is answered at once where the fold keeps what it asks
for, when the signal comes where it does not, and with the wait's own
failure where its bound runs out. An entry more than five minutes old may be
forgotten. A stopped fold lets every wait go.

A fold is told of a signal by `noted`, as the service tells it. A bound is
by the loop's clock, which a test moves ahead. How old an entry is, is by a
clock the fold is handed, which here is one a test sets.
"""

import asyncio
from typing import Final, final

import pytest
from aio import hurried, run, soon
from semiont.identifiers import ResourceId
from semiont.types import SmeltSettledOutcome

from semiont_librarian.progress import SmeltProgress, WeaveProgress
from semiont_librarian.reads import SmeltWaitTimedOut, WeaveWaitTimedOut

R1: Final = ResourceId("res-1")
R2: Final = ResourceId("res-2")
R3: Final = ResourceId("res-3")
R4: Final = ResourceId("res-4")
R5: Final = ResourceId("res-5")

LONG: Final = 1000.0
"""A bound, in seconds, that no test waits out."""

SHORT: Final = 2.0
"""A bound, in seconds, that a test waits out by moving the loop's clock."""

MINUTE: Final = 60.0


@final
class Clock:
    """A clock a test sets: the seconds it answers are the ones it was last given."""

    def __init__(self) -> None:
        self.now = 5000.0

    def __call__(self) -> float:
        return self.now


async def turns() -> None:
    """Give up a few turns: long enough for a wait that could be answered to be."""
    for _ in range(5):
        await asyncio.sleep(0)


# ── weave:applied ─────────────────────────────────────────────────────


def test_a_wait_for_a_sequence_number_the_fold_has_reached_returns_at_once() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        progress.noted(R1, 5)

        await soon(progress.when_applied(R1, 3, LONG))
        await soon(progress.when_applied(R1, 5, LONG))

        await progress.aclose()

    run(scenario())


def test_a_wait_returns_when_the_signal_comes() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_applied(R1, 7, LONG))
        await turns()
        assert not waiting.done()

        progress.noted(R1, 7)

        await soon(waiting)
        await progress.aclose()

    run(scenario())


def test_a_signal_wakes_every_wait_at_or_below_it_and_no_wait_above_it() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        below = asyncio.ensure_future(progress.when_applied(R1, 6, LONG))
        at = asyncio.ensure_future(progress.when_applied(R1, 8, LONG))
        above = asyncio.ensure_future(progress.when_applied(R1, 9, SHORT))
        await turns()

        progress.noted(R1, 8)

        await soon(below)
        await soon(at)
        await turns()
        assert not above.done()
        with pytest.raises(WeaveWaitTimedOut, match=r"did not reach 9 for res-1"):
            await hurried(above)
        await progress.aclose()

    run(scenario())


def test_a_signal_of_another_resource_and_a_lower_one_wake_nothing() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_applied(R1, 7, SHORT))
        await turns()

        progress.noted(R2, 9)
        progress.noted(R1, 6)
        await turns()

        assert not waiting.done()
        with pytest.raises(WeaveWaitTimedOut):
            await hurried(waiting)
        await progress.aclose()

    run(scenario())


def test_a_wait_whose_signal_never_comes_fails_as_one_that_ran_out() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())

        with pytest.raises(WeaveWaitTimedOut, match=r"weave:applied did not reach 1 for res-1 within 2\.0 seconds"):
            await hurried(progress.when_applied(R1, 1, SHORT))

        # The wait that ran out is gone: a signal that comes after it wakes nothing, and is kept.
        progress.noted(R1, 1)
        await soon(progress.when_applied(R1, 1, LONG))
        await progress.aclose()

    run(scenario())


def test_what_is_kept_only_rises() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        progress.noted(R1, 9)
        progress.noted(R1, 4)

        await soon(progress.when_applied(R1, 9, LONG))
        with pytest.raises(WeaveWaitTimedOut):
            await hurried(progress.when_applied(R1, 10, SHORT))
        await progress.aclose()

    run(scenario())


def test_a_wait_that_is_cancelled_is_gone() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_applied(R1, 7, LONG))
        await turns()

        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        progress.noted(R1, 7)

        assert waiting.cancelled()
        await soon(progress.when_applied(R1, 7, LONG))
        await progress.aclose()

    run(scenario())


def test_an_applied_entry_more_than_five_minutes_old_is_forgotten_at_most_once_a_minute() -> None:
    async def scenario() -> None:
        clock = Clock()
        began = clock.now
        progress = WeaveProgress(clock)
        progress.noted(R1, 1)
        clock.now = began + 2
        progress.noted(R2, 1)

        # Five minutes and a second on, a signal sweeps: the first entry is that old, and the second is not.
        clock.now = began + 5 * MINUTE + 1
        progress.noted(R3, 1)
        await soon(progress.when_applied(R2, 1, LONG))
        with pytest.raises(WeaveWaitTimedOut):
            await hurried(progress.when_applied(R1, 1, SHORT))

        # Two seconds later the second entry is old enough, and no minute has passed since the sweep: it is still kept.
        clock.now = began + 5 * MINUTE + 3
        progress.noted(R4, 1)
        await soon(progress.when_applied(R2, 1, LONG))

        # A minute after the sweep, the next signal sweeps again.
        clock.now = began + 6 * MINUTE + 1
        progress.noted(R5, 1)
        with pytest.raises(WeaveWaitTimedOut):
            await hurried(progress.when_applied(R2, 1, SHORT))
        await soon(progress.when_applied(R3, 1, LONG))
        await progress.aclose()

    run(scenario())


def test_a_stopped_weave_fold_lets_a_wait_go_as_if_the_signal_had_come() -> None:
    async def scenario() -> None:
        progress = WeaveProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_applied(R1, 7, LONG))
        await turns()

        await progress.aclose()

        await soon(waiting)
        # A wait made after it has stopped returns at once, whatever it is for.
        await soon(progress.when_applied(R2, 99, LONG))
        # Stopping twice is stopping once, and a signal told to a stopped fold is not kept.
        await progress.aclose()
        progress.noted(R1, 7)

    run(scenario())


# ── smelt:settled ─────────────────────────────────────────────────────


def test_a_wait_for_the_decision_the_fold_keeps_is_answered_at_once() -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())
        progress.noted(R1, "cs-a", "indexed")
        progress.noted(R2, "cs-b", "skipped")

        assert await soon(progress.when_settled(R1, "cs-a", LONG)) == "indexed"
        assert await soon(progress.when_settled(R2, "cs-b", LONG)) == "skipped"

        await progress.aclose()

    run(scenario())


@pytest.mark.parametrize("outcome", ["indexed", "skipped"])
def test_a_wait_is_answered_with_the_decision_when_it_is_signalled(outcome: SmeltSettledOutcome) -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_settled(R1, "cs-a", LONG))
        await turns()
        assert not waiting.done()

        progress.noted(R1, "cs-a", outcome)

        assert await soon(waiting) == outcome
        await progress.aclose()

    run(scenario())


def test_a_decision_of_other_bytes_and_one_of_another_resource_wake_nothing_and_the_decision_of_these_bytes_does() -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())
        waiting = asyncio.ensure_future(progress.when_settled(R1, "cs-new", LONG))
        await turns()

        progress.noted(R1, "cs-old", "indexed")
        progress.noted(R2, "cs-new", "indexed")
        await turns()
        assert not waiting.done()

        progress.noted(R1, "cs-new", "skipped")

        assert await soon(waiting) == "skipped"
        await progress.aclose()

    run(scenario())


def test_the_last_decision_of_a_resource_is_the_one_kept_and_a_wait_for_another_checksum_waits() -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())
        progress.noted(R1, "cs-v1", "indexed")
        progress.noted(R1, "cs-v2", "skipped")

        assert await soon(progress.when_settled(R1, "cs-v2", LONG)) == "skipped"
        with pytest.raises(SmeltWaitTimedOut, match=r"smelt:settled did not state cs-v1 for res-1 within 2\.0 seconds"):
            await hurried(progress.when_settled(R1, "cs-v1", SHORT))
        await progress.aclose()

    run(scenario())


def test_a_wait_whose_decision_never_comes_fails_as_one_that_ran_out() -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())

        with pytest.raises(SmeltWaitTimedOut):
            await hurried(progress.when_settled(R1, "cs-a", SHORT))

        # The wait that ran out is gone: a decision that comes after it wakes nothing, and is kept.
        progress.noted(R1, "cs-a", "indexed")
        assert await soon(progress.when_settled(R1, "cs-a", LONG)) == "indexed"
        await progress.aclose()

    run(scenario())


def test_a_settled_entry_more_than_five_minutes_old_is_forgotten_at_most_once_a_minute() -> None:
    async def scenario() -> None:
        clock = Clock()
        began = clock.now
        progress = SmeltProgress(clock)
        progress.noted(R1, "cs-1", "indexed")
        clock.now = began + 2
        progress.noted(R2, "cs-2", "skipped")

        # Five minutes and a second on, a signal sweeps: the first entry is that old, and the second is not.
        clock.now = began + 5 * MINUTE + 1
        progress.noted(R3, "cs-3", "indexed")
        assert await soon(progress.when_settled(R2, "cs-2", LONG)) == "skipped"
        with pytest.raises(SmeltWaitTimedOut):
            await hurried(progress.when_settled(R1, "cs-1", SHORT))

        # Two seconds later the second entry is old enough, and no minute has passed since the sweep: it is still kept.
        clock.now = began + 5 * MINUTE + 3
        progress.noted(R4, "cs-4", "indexed")
        assert await soon(progress.when_settled(R2, "cs-2", LONG)) == "skipped"

        # A minute after the sweep, the next signal sweeps again.
        clock.now = began + 6 * MINUTE + 1
        progress.noted(R5, "cs-5", "indexed")
        with pytest.raises(SmeltWaitTimedOut):
            await hurried(progress.when_settled(R2, "cs-2", SHORT))
        assert await soon(progress.when_settled(R3, "cs-3", LONG)) == "indexed"
        await progress.aclose()

    run(scenario())


def test_a_stopped_smelt_fold_lets_a_wait_go_with_no_decision() -> None:
    async def scenario() -> None:
        progress = SmeltProgress(Clock())
        progress.noted(R2, "cs-b", "indexed")
        waiting = asyncio.ensure_future(progress.when_settled(R1, "cs-a", LONG))
        await turns()

        await progress.aclose()

        assert await soon(waiting) == "inert"
        # A wait made after it has stopped is answered `inert`, also for a decision it kept.
        assert await soon(progress.when_settled(R2, "cs-b", LONG)) == "inert"
        # Stopping twice is stopping once, and a decision told to a stopped fold is not kept.
        await progress.aclose()
        progress.noted(R1, "cs-a", "indexed")
        assert await soon(progress.when_settled(R1, "cs-a", LONG)) == "inert"

    run(scenario())
