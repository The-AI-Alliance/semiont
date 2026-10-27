"""The follower of the record, held to `specs/src/follower/follow-cases.json`.

The table is the one every implementation of a follower runs: a case is a
record, the cursors a follower starts with and what happens to it, and what it
must take of each log. The rule is docs/protocol/TRANSPORT-CONTRACT.md § What
repairs a passing frame, and what it does in each case is stated in the table
once, and not once for each language.

Every type the table names is first shown to be an event of the record, by the
bus registry, and every log and place it names to be one its record has. A
case that names what no record holds shows nothing of what a follower does.
"""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Annotated, Final, Literal, final

import pytest
from aio import run
from pydantic import BaseModel, Field, JsonValue
from semiont.types import StoredEventResponse
from spec import SPEC, objects, read, text

from semiont_service.follower import SYSTEM, Cursors, Followed, Follower, FromTheFirst, OwnStart, Unfinished, WithNoCursor, log_of

type How = Literal["applied", "nothing", "refused"]
"""How an event was taken: applied by the fold, applied as nothing (the fold has no use for its type), or refused as recorded."""


class Fold(BaseModel, frozen=True, extra="forbid", strict=True):
    uses: frozenset[str]
    refuses: list[tuple[str, int]]
    fails: list[tuple[str, int, int]]


class Start(BaseModel, frozen=True, extra="forbid", strict=True):
    start: Literal[True]


class Deliver(BaseModel, frozen=True, extra="forbid", strict=True):
    deliver: tuple[str, int]


class Recorded(BaseModel, frozen=True, extra="forbid", strict=True):
    record: tuple[str, str]


class Drop(BaseModel, frozen=True, extra="forbid", strict=True):
    drop: Literal[True]


class Reopen(BaseModel, frozen=True, extra="forbid", strict=True):
    reopen: Literal[True]


class Case(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    record: dict[str, list[str]]
    fold: Fold
    follows: frozenset[Followed]
    cursors: dict[str, int]
    with_no_cursor: Annotated[Literal["from-the-first", "own-start"], Field(alias="withNoCursor")]
    steps: list[Start | Deliver | Recorded | Drop | Reopen]
    taken: dict[str, list[tuple[int, How]]]
    cursors_after: Annotated[dict[str, int], Field(alias="cursorsAfter")]
    stopped: frozenset[str]
    started_own_way: Annotated[frozenset[str], Field(alias="startedOwnWay")]


class Table(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    run_by: Annotated[dict[str, list[str]], Field(alias="runBy")]
    """Who runs the table, which lint:spec-case-tables holds it to."""
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "follower/follow-cases.json").read_bytes())
RECORDED: Final = frozenset(
    text(channel["event"], "a channel's event")
    for channel in objects(read(SPEC / "bus/registry.json")["channels"], "channels")
    if "event" in channel
)
"""The events of the record: the registry's channels that name an event, as the bus derives them (scripts/bus/delivery.mjs)."""


def stored(log: str, sequence: int, event_type: str) -> StoredEventResponse:
    """The event at `sequence` of `log`, as the record holds it. `__system__`'s events name no resource."""
    event: dict[str, JsonValue] = {
        "id": f"{log}-{sequence}",
        "type": event_type,
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
class Kept:
    """The record a case states, read as a follower reads it: by position. A `record` step adds to it."""

    def __init__(self, record: Mapping[str, list[str]]) -> None:
        self._logs: Final = {log: [stored(log, at, kind) for at, kind in enumerate(kinds, start=1)] for log, kinds in record.items()}

    def add(self, log: str, event_type: str) -> None:
        events = self._logs.setdefault(log, [])
        events.append(stored(log, len(events) + 1, event_type))

    def event(self, log: str, sequence: int) -> StoredEventResponse:
        return self._logs[log][sequence - 1]

    async def logs(self) -> Mapping[str, int]:
        """Every log the record has, each with the sequence of its last event."""
        return {log: len(events) for log, events in self._logs.items()}

    async def after(self, log: str, sequence: int) -> Sequence[StoredEventResponse]:
        """A log's events after `sequence`, in order."""
        return self._logs[log][sequence:]


@final
class Projector:
    """The fold a case states: what it takes of each log, the events it refuses as recorded, and the takings that fail."""

    def __init__(self, fold: Fold) -> None:
        self.taken: Final[dict[str, list[tuple[int, How]]]] = {}
        self.started_own_way: Final[set[str]] = set()
        self._uses: Final = fold.uses
        self._refuses: Final = frozenset(fold.refuses)
        self._failing: Final = {(log, sequence): times for log, sequence, times in fold.fails}

        self.forgotten: Final[list[str]] = []

    async def take(self, run: Sequence[StoredEventResponse]) -> int:
        """Take a run an event at a time, and answer how many it refused. A taking that fails stops the run where it is."""
        refused = 0
        for taken, event in enumerate(run):
            place = (log_of(event), event.metadata.sequence_number)
            if place in self._failing and self._failing[place] > 0:
                self._failing[place] -= 1
                raise Unfinished(taken=taken, refused=refused) from ConnectionError(f"the store did not answer for {place}")
            how: How = "refused" if place in self._refuses else "applied" if event.type in self._uses else "nothing"
            self.taken.setdefault(place[0], []).append((place[1], how))
            refused += how == "refused"
        return refused

    async def forget(self, log: str) -> None:
        self.forgotten.append(log)

    async def start_own_way(self, logs: frozenset[str]) -> None:
        self.started_own_way.update(logs)


def test_every_type_the_table_names_is_an_event_of_the_record_and_every_log_and_place_one_its_record_has() -> None:
    assert len({case.why for case in TABLE.cases}) == len(TABLE.cases), "two cases say the same why"
    for case in TABLE.cases:
        held = {log: len(kinds) for log, kinds in case.record.items()}
        named = {kind for kinds in case.record.values() for kind in kinds} | case.fold.uses
        for log, sequence in case.cursors.items():
            assert log in held, f"{case.why}: the record has no log {log}"
            assert 0 <= sequence <= held[log], case.why
        for step in case.steps:
            match step:
                case Recorded(record=(log, kind)):
                    held.setdefault(log, 0)
                    held[log] += 1
                    named.add(kind)
                case Deliver(deliver=(log, sequence)):
                    assert 1 <= sequence <= held[log], f"{case.why}: {log} {sequence} is delivered before it is recorded"
                case Start() | Drop() | Reopen():
                    pass
        assert named <= RECORDED, f"{case.why}: {sorted(named - RECORDED)} are no events of the record"
        places = [*case.fold.refuses, *((log, sequence) for log, sequence, _ in case.fold.fails)]
        places += [(log, sequence) for log, taken in case.taken.items() for sequence, _ in taken]
        for log, sequence in places:
            assert 1 <= sequence <= held[log], f"{case.why}: the record has no {log} {sequence}"
        for log in (*case.cursors_after, *case.stopped, *case.started_own_way):
            assert log in held, f"{case.why}: the record has no log {log}"


@pytest.mark.parametrize("case", [pytest.param(case, id=case.why) for case in TABLE.cases])
def test_a_follower_takes_each_log_as_the_table_states(case: Case, tmp_path: Path) -> None:
    async def scenario() -> None:
        kept = Kept(case.record)
        projector = Projector(case.fold)
        cursors = Cursors(tmp_path / "cursors.json")
        cursors.keep(case.cursors)
        with_no_cursor: WithNoCursor
        match case.with_no_cursor:
            case "from-the-first":
                with_no_cursor = FromTheFirst()
            case "own-start":
                with_no_cursor = OwnStart(projector.start_own_way)
        follower = Follower(
            record=kept, take=projector.take, forget=projector.forget, follows=case.follows, with_no_cursor=with_no_cursor, cursors=cursors
        )
        for step in case.steps:
            match step:
                case Start():
                    follower.start()
                case Deliver(deliver=(log, sequence)):
                    follower.delivered(kept.event(log, sequence))
                case Recorded(record=(log, kind)):
                    kept.add(log, kind)
                case Drop():
                    follower.dropped()
                case Reopen():
                    follower.reopened()
            await follower.settled()
        assert projector.taken == case.taken
        assert follower.refused == sum(how == "refused" for taken in case.taken.values() for _, how in taken)
        assert follower.stopped == case.stopped
        assert projector.started_own_way == case.started_own_way
        # No case rewinds the record, so no log is forgotten.
        assert projector.forgotten == []
        await follower.aclose()
        # The cursors are on disk: a follower made again after a restart starts from them.
        assert Cursors(tmp_path / "cursors.json").held() == case.cursors_after

    run(scenario())
