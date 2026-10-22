"""The follower beyond its table: the stream it watches, a record that does not answer, a log taken again, and the file of its cursors.

How a follower takes each log is `specs/src/follower/follow-cases.json`'s,
run by `test_follow_cases.py`. Here is what the table does not state: that
the stream's first opening starts it and each opening after a drop sweeps; that
a sweep the record does not answer is tried again; that a log the record has
gone behind is forgotten and taken again from its first event, as one is on
purpose; that an own start that fails is started again; and what its cursors'
file holds.
"""

import asyncio
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final, final, override

from aio import pass_time, run, turns
from pydantic import JsonValue
from semiont.transport import ConnectionState
from semiont.types import StoredEventResponse
from semiont.watched import Variable

from semiont_service.follower import SYSTEM, Cursors, Follower, FromTheFirst, OwnStart, Record, RecordUnread, Unfinished, log_of


def stored(log: str, sequence: int) -> StoredEventResponse:
    event: dict[str, JsonValue] = {
        "id": f"{log}-{sequence}",
        "type": "mark:added",
        "timestamp": "2026-10-21T00:00:00Z",
        "userId": "did:web:example.org:users:someone",
        "version": 1,
        "payload": {},
        "metadata": {"sequenceNumber": sequence},
    }
    if log != SYSTEM:
        event["resourceId"] = log
    return StoredEventResponse.model_validate(event)


@final
class Kept(Record):
    """A record of each log's events, by sequence. While `unanswered` it is not there; every listing is counted."""

    def __init__(self, logs: Mapping[str, int]) -> None:
        self.logs_held: Final = {log: [stored(log, at) for at in range(1, last + 1)] for log, last in logs.items()}
        self.unanswered = False
        self.listed = 0

    def add(self, log: str) -> StoredEventResponse:
        events = self.logs_held.setdefault(log, [])
        event = stored(log, len(events) + 1)
        events.append(event)
        return event

    @override
    async def logs(self) -> Mapping[str, int]:
        self.listed += 1
        if self.unanswered:
            raise RecordUnread("nothing answers")
        return {log: len(events) for log, events in self.logs_held.items()}

    @override
    async def after(self, log: str, sequence: int) -> Sequence[StoredEventResponse]:
        if self.unanswered:
            raise RecordUnread("nothing answers")
        return self.logs_held[log][sequence:]


@final
class Projection:
    """What a follower is followed for: each event taken, by log, and each log forgotten."""

    def __init__(self) -> None:
        self.taken: Final[dict[str, list[int]]] = {}
        self.forgotten: Final[list[str]] = []
        self.failing: set[tuple[str, int]] = set()

    async def take(self, run: Sequence[StoredEventResponse]) -> int:
        for taken, event in enumerate(run):
            place = (log_of(event), event.metadata.sequence_number)
            if place in self.failing:
                raise Unfinished(taken=taken, refused=0) from ConnectionError(f"the store did not answer for {place}")
            self.taken.setdefault(place[0], []).append(place[1])
        return 0

    async def forget(self, log: str) -> None:
        self.forgotten.append(log)


def following(record: Kept, projection: Projection, cursors: Path, *, own: OwnStart | None = None) -> Follower:
    return Follower(
        record=record,
        take=projection.take,
        forget=projection.forget,
        follows=frozenset({"resources"}),
        with_no_cursor=FromTheFirst() if own is None else own,
        cursors=Cursors(cursors),
    )


def test_the_stream_s_first_opening_starts_it_and_each_opening_after_a_drop_sweeps(tmp_path: Path) -> None:
    async def scenario() -> None:
        record, projection = Kept({"res-1": 1}), Projection()
        follower = following(record, projection, tmp_path / "cursors.json")
        states = Variable[ConnectionState]("connecting")
        watching = asyncio.ensure_future(follower.watch(states))
        await turns()
        assert record.listed == 0

        states.set("open")
        await turns()
        await follower.settled()
        assert projection.taken == {"res-1": [1]}

        states.set("reconnecting")
        await turns()
        record.add("res-1")
        states.set("open")
        await turns()
        await follower.settled()
        assert projection.taken == {"res-1": [1, 2]}
        assert follower.said() == {"sweep": "done", "stopped": 0, "refused": 0, "streamDrops": 1}

        states.set("closed")
        await turns()
        assert watching.done()
        await follower.aclose()

    run(scenario())


def test_a_sweep_the_record_does_not_answer_is_tried_again(tmp_path: Path) -> None:
    async def scenario() -> None:
        record, projection = Kept({"res-1": 2}), Projection()
        record.unanswered = True
        follower = following(record, projection, tmp_path / "cursors.json")
        follower.start()
        await turns()
        assert follower.said()["sweep"] == "due"
        assert projection.taken == {}

        record.unanswered = False
        await pass_time(2.0, step=0.5)
        await follower.settled()
        assert projection.taken == {"res-1": [1, 2]}
        assert follower.said()["sweep"] == "done"
        await follower.aclose()

    run(scenario())


def test_a_log_the_record_has_gone_behind_is_forgotten_and_taken_again_from_its_first_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        path = tmp_path / "cursors.json"
        Cursors(path).keep({"res-1": 5})
        record, projection = Kept({"res-1": 2}), Projection()
        follower = following(record, projection, path)
        follower.start()
        await follower.settled()
        assert projection.forgotten == ["res-1"]
        assert projection.taken == {"res-1": [1, 2]}
        await follower.aclose()
        assert Cursors(path).held() == {"res-1": 2}

    run(scenario())


def test_a_log_is_taken_again_on_purpose_and_says_whether_it_reached_its_end(tmp_path: Path) -> None:
    async def scenario() -> None:
        record, projection = Kept({"res-1": 3, "res-2": 1}), Projection()
        follower = following(record, projection, tmp_path / "cursors.json")
        follower.start()
        await follower.settled()

        again = await follower.again("res-1")
        assert (again.taken, again.stopped) == (3, False)
        assert projection.forgotten == ["res-1"]
        assert projection.taken == {"res-1": [1, 2, 3, 1, 2, 3], "res-2": [1]}

        projection.failing.add(("res-1", 2))
        stopped = await follower.again("res-1")
        assert (stopped.taken, stopped.stopped) == (1, True)
        assert follower.stopped == {"res-1"}

        projection.failing.clear()
        cleared: list[str] = []

        async def clear() -> None:
            cleared.append("everything")

        everything = await follower.again_all(clear)
        assert cleared == ["everything"]
        assert (everything.taken, everything.stopped) == (4, False)
        assert follower.stopped == frozenset()
        await follower.aclose()

    run(scenario())


def test_work_done_in_a_log_s_turn_answers_what_it_answers(tmp_path: Path) -> None:
    async def scenario() -> None:
        follower = following(Kept({}), Projection(), tmp_path / "cursors.json")

        async def work() -> int:
            return 7

        assert await follower.in_turn("res-1", work) == 7
        await follower.aclose()

    run(scenario())


def test_an_own_start_that_fails_is_started_again_by_the_next_sweep(tmp_path: Path) -> None:
    async def scenario() -> None:
        record, projection = Kept({"res-1": 2}), Projection()
        started: list[frozenset[str]] = []

        async def start(logs: frozenset[str]) -> None:
            started.append(logs)
            if len(started) == 1:
                raise ConnectionError("the index did not answer")

        follower = following(record, projection, tmp_path / "cursors.json", own=OwnStart(start))
        follower.start()
        await turns()
        assert follower.said()["sweep"] == "due"

        await pass_time(2.0, step=0.5)
        await follower.settled()
        assert started == [frozenset({"res-1"}), frozenset({"res-1"})]
        # Started its own way each time, and followed from the log's last event as it was: nothing of it was taken.
        assert projection.taken == {}
        assert follower.said()["sweep"] == "done"
        await follower.aclose()
        assert Cursors(tmp_path / "cursors.json").held() == {"res-1": 2}

    run(scenario())


def test_the_cursors_file_holds_each_log_s_cursor_and_what_cannot_be_read_as_one_is_no_cursor(tmp_path: Path) -> None:
    path = tmp_path / "state" / "cursors.json"
    cursors = Cursors(path)
    assert cursors.held() == {}
    cursors.keep({"res-1": 3, SYSTEM: 1})
    assert json.loads(path.read_bytes()) == {"res-1": 3, SYSTEM: 1}
    assert Cursors(path).held() == {"res-1": 3, SYSTEM: 1}

    for written in ("", "{", "[1, 2]", '"text"', "null"):
        path.write_text(written, encoding="utf-8")
        assert Cursors(path).held() == {}, written
    path.write_text(json.dumps({"res-1": 3, "res-2": "four", "res-3": True, "res-4": 2.5}), encoding="utf-8")
    assert Cursors(path).held() == {"res-1": 3}
