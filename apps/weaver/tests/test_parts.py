"""The Weaver's parts, each alone: its marks, its lanes, and the file it keeps its marks in."""

import asyncio
from pathlib import Path

import pytest
from aio import run

from semiont_weaver.checkpoint import Checkpoint
from semiont_weaver.lanes import Lanes
from semiont_weaver.marks import Marks

# ── The marks ──────────────────────────────────────────────────────────


def test_a_mark_rises_and_never_falls() -> None:
    marks = Marks()
    assert marks.of("r") == 0
    assert marks.reach("r", 2) == 2
    assert marks.reach("r", 5) == 5
    # A lower sequence is an event delivered again.
    assert marks.reach("r", 3) is None
    assert marks.reach("r", 5) is None
    assert marks.all() == {"r": 5}
    assert marks.unsaved


def test_a_mark_never_reaches_an_event_that_was_not_applied_however_many_later_ones_are() -> None:
    marks = Marks()
    assert marks.reach("r", 1) == 1
    marks.missed("r", 2)
    marks.missed("r", 4)
    assert marks.reach("r", 3) is None
    assert marks.reach("r", 9) is None
    assert marks.of("r") == 1
    assert marks.failures == 2

    # Applied at last, an event holds the mark back no longer: the next one that was not applied does.
    marks.landed("r", 2)
    assert marks.reach("r", 9) == 3
    marks.landed("r", 4)
    assert marks.reach("r", 9) == 9
    # What was missed stays counted: the count is of what happened, and not of what is still wrong.
    assert marks.failures == 2


def test_nothing_is_marked_for_a_resource_whose_first_event_was_not_applied() -> None:
    marks = Marks()
    marks.missed("r", 1)
    assert marks.reach("r", 2) is None
    assert marks.all() == {}
    assert not marks.unsaved


def test_an_event_of_no_resource_that_was_not_applied_is_counted_and_holds_no_mark() -> None:
    marks = Marks()
    marks.missed(None, 7)
    assert marks.failures == 1
    assert marks.reach("r", 9) == 9


def test_kept_marks_raise_a_mark_and_lower_none_and_a_forgotten_mark_is_gone() -> None:
    marks = Marks()
    marks.reach("a", 5)
    marks.keep({"a": 3, "b": 7})
    assert marks.all() == {"a": 5, "b": 7}
    assert marks.tracked() == 2
    marks.forget("b")
    marks.forget("never-marked")
    assert marks.all() == {"a": 5}
    assert marks.reach("b", 2) == 2


# ── The lanes ──────────────────────────────────────────────────────────


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


# ── The marks, kept ────────────────────────────────────────────────────


def test_marks_kept_are_the_marks_read_back(tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = Checkpoint(tmp_path / "state" / "marks.json")
        assert await kept.load() == {}
        await kept.save({"res-1": 4, "res-2": 1})
        assert await kept.load() == {"res-1": 4, "res-2": 1}
        await kept.save({"res-1": 5})
        assert await kept.load() == {"res-1": 5}
        # Nothing is left beside the file: it was written beside it, and moved over it.
        assert [path.name for path in (tmp_path / "state").iterdir()] == ["marks.json"]

    run(scenario())


@pytest.mark.parametrize("held", ["", "{", "[1, 2]", '"text"', "null"])
def test_what_cannot_be_read_as_marks_is_no_marks(tmp_path: Path, held: str) -> None:
    async def scenario() -> None:
        path = tmp_path / "marks.json"
        path.write_text(held, encoding="utf-8")
        assert await Checkpoint(path).load() == {}

    run(scenario())


def test_a_mark_that_is_no_whole_number_is_left_out(tmp_path: Path) -> None:
    async def scenario() -> None:
        path = tmp_path / "marks.json"
        path.write_text('{"res-1": 3, "res-2": "4", "res-3": 1.5, "res-4": true, "res-5": null}', encoding="utf-8")
        assert await Checkpoint(path).load() == {"res-1": 3}

    run(scenario())


def test_marks_that_cannot_be_written_raise(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "a-file").write_text("", encoding="utf-8")
        with pytest.raises(OSError, match="a-file"):
            await Checkpoint(tmp_path / "a-file" / "marks.json").save({"res-1": 1})

    run(scenario())
