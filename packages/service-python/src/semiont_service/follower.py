"""Following the record: a cursor for each log, moved by one.

The record is a set of logs, one for each resource and `__system__` for the
knowledge base's own events, each numbered from 1 with no holes. A service
that keeps a projection of the record follows it. It keeps a cursor for each
log it follows, the last event of it taken, and moves a cursor only by taking
the event right after it. A delivered event is a hint: at or below the cursor
it is dropped, right after it taken, and further on the log is read from the
record after the cursor and taken in order. At its start, and each time its
stream opens after a drop, the follower sweeps: each log it follows is taken
up to what the record holds.

An event the projection refuses as recorded is taken as nothing, and
counted. A taking that fails for any other reason stops its log where it is,
and the next sweep takes the log on from there.

The rule is docs/protocol/TRANSPORT-CONTRACT.md § What repairs a passing
frame, and what it does in each case is specs/src/follower/follow-cases.json.
Cursors are kept in a file on the container's own disk, never in the knowledge
base: losing one costs time, never correctness.

**How it takes a log.** A log's events are taken in a lane of the log's own
(`semiont_service.lanes`), a run at a time: the delivered events that follow
its cursor with no gap, or else what the record holds after its cursor, an
answer at a time. The projection takes a run whole, in order. A sweep lists
the record's logs and takes those that moved, a few at a time. The projection
does its own work on a log in the same lane (`in_turn`), and a log is taken
again from its first event there too (`again`): once the projection has
forgotten what it made of it, as it is when the record has gone behind its
cursor.
"""

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Final, Literal, Protocol, final

from pydantic import JsonValue, TypeAdapter, ValidationError
from semiont.channels import CHANNELS, PERSISTED_EVENT_TYPES
from semiont.transport import ConnectionState, Frame
from semiont.types import StoredEventResponse
from semiont.watched import Watched

from semiont_service.lanes import Lanes

__all__ = [
    "SYSTEM",
    "Cursors",
    "Followed",
    "Follower",
    "FromTheFirst",
    "OwnStart",
    "Record",
    "RecordUnread",
    "Retaken",
    "Take",
    "Unfinished",
    "WithNoCursor",
    "log_of",
    "recorded",
]

SYSTEM: Final = "__system__"
"""The log of the knowledge base's own events, by the record's name for it."""

type Followed = Literal["resources", "__system__"]
"""What a follower follows: every resource's log, and `__system__`."""

_LOG: Final = logging.getLogger("semiont_service.follower")

_SWEEP_AT_ONCE: Final = 8
"""How many logs a sweep takes at a time: each reads the record, and a start that takes every log takes them a few at a time."""

_KEEP_SECONDS: Final = 5.0
"""How often the cursors are written, when one has moved."""

_SWEEP_AGAIN_SECONDS: Final = (1.0, 60.0)
"""How long a sweep the record did not answer waits before it is tried again: the first wait, and the longest, each twice the last."""

_PERSISTED: Final = frozenset(PERSISTED_EVENT_TYPES)


def _words_of(failure: BaseException) -> str:
    return f"{type(failure).__name__}: {failure}"


def log_of(event: StoredEventResponse) -> str:
    """The log an event is of: its resource's, or `__system__` for an event that names none."""
    return SYSTEM if event.resource_id is None else event.resource_id


def recorded(frame: Frame) -> StoredEventResponse | None:
    """The event of the record a frame carries. Nothing for a frame on a channel that carries none.

    Raises pydantic's `ValidationError` for a frame on such a channel that carries no stored event.
    """
    if frame.channel not in _PERSISTED:
        return None
    event = CHANNELS[frame.channel].decode(frame.payload)
    if not isinstance(event, StoredEventResponse):
        raise TypeError(f"{frame.channel} carries a {type(event).__name__}, not a stored event")
    return event


@final
class RecordUnread(Exception):
    """The record could not be read: the account could not sign in, or the record's keeper did not answer or refused. A passing failure."""


class Record(Protocol):
    """The record, as a follower reads it: by position. Each read raises `RecordUnread` where the record was not read."""

    async def logs(self) -> Mapping[str, int]:
        """Every log the record has, each with the sequence of its last event."""
        ...

    async def after(self, log: str, sequence: int) -> Sequence[StoredEventResponse]:
        """The first of a log's events after `sequence`, in order: as many as one read holds, at least one where there are any.

        None where the log has none after `sequence`. A follower that wants more reads again after the last one it was given.
        """
        ...


@final
class Unfinished(Exception):
    """A run whose taking failed for a passing reason after the first `taken` of its events were taken, `refused` of them refused.

    Raised from what it failed with.
    """

    def __init__(self, *, taken: int, refused: int) -> None:
        super().__init__(f"{taken} of the run were taken, {refused} of them refused")
        self.taken: Final = taken
        self.refused: Final = refused


type Take = Callable[[Sequence[StoredEventResponse]], Awaitable[int]]
"""Taking a run of one log's events, each the one right after the last, in order: applying each, or applying it as nothing where the
projection has no use for its type. It answers how many of them it refused as recorded.

Where a taking fails for a passing reason it raises `Unfinished`, saying how many were taken first. Anything else it raises takes none
of the run.
"""


@final
@dataclass(frozen=True, slots=True)
class FromTheFirst:
    """A log with no cursor at the start is taken from its first event."""


@final
@dataclass(frozen=True, slots=True)
class OwnStart:
    """A log with no cursor at the start is started the projection's own way, and followed from its last event as it was before."""

    start: Callable[[frozenset[str]], Awaitable[None]]
    """Starts the logs named, as the projection rebuilds itself."""


type WithNoCursor = FromTheFirst | OwnStart
"""How a log with no cursor at the start is started. A log first met after the start is a new one, and is taken from its first event."""


@final
@dataclass(frozen=True, slots=True)
class Retaken:
    """What taking logs again from their first events came to: how many events were taken, and whether a log was stopped first."""

    taken: int
    stopped: bool


_HELD: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


@final
class Cursors:
    """Each log's cursor, in a file on the container's own disk."""

    def __init__(self, path: Path) -> None:
        self._path: Final = path

    def held(self) -> dict[str, int]:
        """Each log's cursor, as the file holds it. None where there is no file, or nothing in it is readable as cursors."""
        try:
            held = _HELD.validate_json(self._path.read_bytes())
        except (OSError, ValidationError):
            return {}
        return {log: sequence for log, sequence in held.items() if isinstance(sequence, int) and not isinstance(sequence, bool)}

    def keep(self, cursors: Mapping[str, int]) -> None:
        """Write the cursors, in place of what the file held. Raises `OSError` where they cannot be written."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Written beside the file and moved over it, so that a process killed while writing leaves the cursors it had.
        beside = self._path.with_name(self._path.name + ".tmp")
        beside.write_text(json.dumps(dict(cursors)), encoding="utf-8")
        os.replace(beside, self._path)


type _Phase = Literal["pending", "running", "done", "due"]


@final
class Follower:
    """A follower of `record`, taking each log it `follows` with `take`, its cursors kept in `cursors`. See the module's documentation.

    `forget` undoes what the projection made of a log, before the log is
    taken again from its first event. Made, and closed, on the loop it
    follows on.
    """

    def __init__(
        self,
        *,
        record: Record,
        take: Take,
        forget: Callable[[str], Awaitable[None]],
        follows: frozenset[Followed],
        with_no_cursor: WithNoCursor,
        cursors: Cursors,
    ) -> None:
        self._record: Final = record
        self._take: Final = take
        self._forget: Final = forget
        self._follows: Final = follows
        self._with_no_cursor: Final = with_no_cursor
        self._cursors: Final = cursors
        self._at: Final = cursors.held()
        """Each log's cursor. A log with none has taken nothing: it is at 0, a log's sequences beginning at 1."""
        self._moved = False
        """Whether a cursor has moved since the cursors were last written."""
        self._lanes: Final = Lanes()
        self._known: set[str] | None = None
        """The logs the record had at the start, and those met since. None until the start's sweep has listed the record."""
        self._wanted: Final[dict[str, int]] = {}
        """For each log, the last of its events known to be recorded and not yet taken."""
        self._waiting: Final[dict[str, dict[int, StoredEventResponse]]] = {}
        """For each log, the events delivered after its cursor and not yet taken, by sequence."""
        self._turned: Final[set[str]] = set()
        """The logs a turn is put on the lane of, not yet begun."""
        self._stopped: Final[set[str]] = set()
        self._refused = 0
        self._drops = 0
        self._phase: _Phase = "pending"
        self._sweeping: asyncio.Task[None] | None = None
        self._again = False
        """Whether another sweep is to follow the one under way."""
        self._swept: Final = asyncio.Event()
        self._keeping: asyncio.Task[None] | None = None
        self._closed = False

    # ── What it says of itself ─────────────────────────────────────────

    @property
    def refused(self) -> int:
        """How many events were refused as recorded, and taken as nothing."""
        return self._refused

    @property
    def stopped(self) -> frozenset[str]:
        """The logs a failed taking has stopped, until the next sweep."""
        return frozenset(self._stopped)

    def _cursor(self, log: str) -> int:
        """The last event of a log taken. 0 for a log of which none is."""
        return self._at.get(log, 0)

    def said(self) -> dict[str, JsonValue]:
        """This, as a service's health reports it."""
        return {"sweep": self._phase, "stopped": len(self._stopped), "refused": self._refused, "streamDrops": self._drops}

    async def settled(self) -> None:
        """Wait until nothing is left to take, and every cursor moved is in its file.

        What a test waits on. Nothing of a service does: a follower is never done.
        """
        while True:
            sweeping = self._sweeping
            if sweeping is not None:
                await asyncio.wait([sweeping])
            await self._lanes.settled()
            if self._sweeping is sweeping and (sweeping is None or sweeping.done()) and not self._turned:
                break
        await self._keep()

    async def swept(self) -> None:
        """Wait until a sweep has taken each log it found up to what the record held, and none is under way."""
        await self._swept.wait()

    # ── The stream ─────────────────────────────────────────────────────

    async def watch(self, states: Watched[ConnectionState]) -> None:
        """Follow the stream's states until it closes: its first opening starts the follower, and each opening after a drop sweeps."""
        started = was_open = down = False
        async for state in states:
            if state == "closed":
                return
            # A state that was open and is open again was something else between the two looks.
            if was_open:
                self.dropped()
                down = True
            if state == "open":
                if not started:
                    started = True
                    self.start()
                elif down:
                    down = False
                    self.reopened()
            was_open = state == "open"

    def start(self) -> None:
        """Start following: sweep each log followed, and keep the cursors from now on."""
        if self._keeping is None:
            self._keeping = asyncio.get_running_loop().create_task(self._keep_every())
        self._sweep()

    def dropped(self) -> None:
        """The stream dropped: what is recorded while it is down is never delivered."""
        self._drops += 1
        _LOG.warning(
            "The stream of the record dropped: what is recorded until it opens again is taken by the sweep when it does",
            extra={"streamDrops": self._drops},
        )

    def reopened(self) -> None:
        """The stream opened again after a drop: sweep each log followed."""
        self._sweep()

    # ── Delivered ──────────────────────────────────────────────────────

    def delivered(self, event: StoredEventResponse) -> None:
        """An event the stream delivered: a hint of what the record holds."""
        log = log_of(event)
        sequence = event.metadata.sequence_number
        if self._closed or not self._follows_log(log) or sequence <= self._cursor(log) or log in self._stopped:
            # At or below the cursor it was taken; a stopped log waits for the next sweep, which reads it from the record.
            return
        self._waiting.setdefault(log, {})[sequence] = event
        self._want(log, sequence)
        if self._known is not None:
            # A log first met after the start is a new one: taken from its first event.
            self._known.add(log)
            self._turn_soon(log)

    def _follows_log(self, log: str) -> bool:
        return ("__system__" if log == SYSTEM else "resources") in self._follows

    def _want(self, log: str, sequence: int) -> None:
        if sequence > self._wanted.get(log, 0):
            self._wanted[log] = sequence

    def _turn_soon(self, log: str) -> None:
        if log not in self._turned:
            self._turned.add(log)
            self._lanes.put(log, partial(self._turn, log))

    # ── Taking a log ───────────────────────────────────────────────────

    async def _turn(self, log: str) -> None:
        """Take a log up to the last event of it known to be recorded. It raises nothing: a log that cannot be taken is stopped."""
        self._turned.discard(log)
        wanted = self._wanted.pop(log, 0)
        if log in self._stopped:
            self._waiting.pop(log, None)
            return
        try:
            await self._take_up_to(log, wanted)
        except Exception as failure:
            self._stop(log, failure)

    async def _take_up_to(self, log: str, wanted: int | None) -> int:
        """Take a log, a run at a time, up to `wanted`, or to its end where none is: answers how many events were taken."""
        taken = 0
        while wanted is None or self._cursor(log) < wanted:
            cursor = self._cursor(log)
            run = self._delivered_run(log, cursor) if wanted is not None else []
            if not run:
                try:
                    run = list(await self._record.after(log, cursor))
                except RecordUnread as failure:
                    self._stop(log, failure)
                    return taken
                if not run:
                    return taken
                began = run[0].metadata.sequence_number
                if began != cursor + 1:
                    self._stop(log, RecordUnread(f"the record holds no event {cursor + 1} of {log}: its answer began at {began}"))
                    return taken
            moved = await self._take_run(log, run)
            taken += moved
            if log in self._stopped:
                return taken
        return taken

    def _delivered_run(self, log: str, cursor: int) -> list[StoredEventResponse]:
        """The delivered events of a log that follow its cursor with no gap, in order. Those at or below the cursor are dropped."""
        waiting = self._waiting.get(log)
        if waiting is None:
            return []
        for taken in [sequence for sequence in waiting if sequence <= cursor]:
            del waiting[taken]
        run: list[StoredEventResponse] = []
        while (next_one := waiting.pop(cursor + len(run) + 1, None)) is not None:
            run.append(next_one)
        if not waiting:
            del self._waiting[log]
        return run

    async def _take_run(self, log: str, run: Sequence[StoredEventResponse]) -> int:
        """Hand a run to the projection, and move the cursor over what it took. Answers how many it took."""
        try:
            refused = await self._take(run)
        except Unfinished as unfinished:
            self._refused += unfinished.refused
            if unfinished.taken:
                self._move(log, run[unfinished.taken - 1].metadata.sequence_number)
            self._stop(log, unfinished.__cause__ or unfinished)
            return unfinished.taken
        except Exception as failure:
            self._stop(log, failure)
            return 0
        self._refused += refused
        self._move(log, run[-1].metadata.sequence_number)
        return len(run)

    def _move(self, log: str, sequence: int) -> None:
        self._at[log] = sequence
        self._moved = True

    def _stop(self, log: str, failure: BaseException) -> None:
        """A log whose taking failed waits where it is for the next sweep, and so does what was delivered of it."""
        self._stopped.add(log)
        self._waiting.pop(log, None)
        _LOG.error(
            "A log of the record stopped: its later events wait for the next sweep",
            extra={"log": log, "cursor": self._cursor(log), "error": _words_of(failure)},
        )

    # ── Sweeping ───────────────────────────────────────────────────────

    def _sweep(self) -> None:
        if self._closed:
            return
        if self._sweeping is not None and not self._sweeping.done():
            self._again = True
            return
        self._swept.clear()
        self._sweeping = asyncio.get_running_loop().create_task(self._sweep_until_done())

    async def _sweep_until_done(self) -> None:
        """Sweep, and again where a sweep was asked for while one was under way, until one ends with none asked for since."""
        wait = _SWEEP_AGAIN_SECONDS[0]
        while True:
            self._again = False
            self._phase = "running"
            try:
                await self._sweep_once()
            except RecordUnread as failure:
                self._phase = "due"
                _LOG.error("A sweep could not list the record: it is tried again", extra={"seconds": wait, "error": _words_of(failure)})
                await asyncio.sleep(wait)
                wait = min(wait * 2, _SWEEP_AGAIN_SECONDS[1])
                continue
            wait = _SWEEP_AGAIN_SECONDS[0]
            if not self._again:
                self._phase = "done"
                self._swept.set()
                return

    async def _sweep_once(self) -> None:
        """List the record's logs, and take each followed log up to what the record holds: those a taking stopped among them."""
        listed = {log: last for log, last in (await self._record.logs()).items() if self._follows_log(log)}
        unstarted = frozenset[str]()
        starting: asyncio.Future[None] | None = None
        if self._known is None:
            unstarted = frozenset(log for log in listed if log not in self._at)
            match self._with_no_cursor:
                case OwnStart(start=own) if unstarted:
                    # Followed from its last event as it was before the projection's own start reads anything.
                    for log in unstarted:
                        self._move(log, listed[log])
                    starting = asyncio.ensure_future(own(unstarted))
                case FromTheFirst() | OwnStart():
                    pass
            self._known = set(listed)
        else:
            self._known.update(listed)
        self._stopped.clear()
        for log, last in listed.items():
            if last < self._cursor(log):
                # The record has gone behind the cursor: it was rewound, and the cursor claims what is not so.
                _LOG.warning(
                    "A log of the record is behind its cursor: it is taken again from its first event",
                    extra={"log": log, "cursor": self._cursor(log), "last": last},
                )
                try:
                    await self._lanes.run(log, partial(self._again_in_turn, log))
                except Exception as failure:
                    self._stop(log, failure)
            self._want(log, last)
        due = [log for log, wanted in self._wanted.items() if wanted > self._cursor(log)]
        await self._each(due, lambda log: self._lanes.run(log, partial(self._turn, log)))
        if starting is not None:
            try:
                await starting
            except Exception as failure:
                # Those logs are started again, the projection's own way, by the sweep that follows.
                for log in unstarted:
                    del self._at[log]
                self._moved = True
                self._known = None
                raise RecordUnread(f"the projection's own start of {len(unstarted)} log(s) failed: {_words_of(failure)}") from failure

    async def _each(self, logs: Sequence[str], work: Callable[[str], Awaitable[object]]) -> None:
        """Do `work` for each log, a few at a time."""
        pending: Iterator[str] = iter(logs)

        async def doing() -> None:
            for log in pending:
                await work(log)

        await asyncio.gather(*(doing() for _ in range(_SWEEP_AT_ONCE)))

    # ── The projection's own work ──────────────────────────────────────

    async def in_turn[T](self, log: str, work: Callable[[], Awaitable[T]]) -> T:
        """Do `work` in a log's lane, in its turn, and answer what it answers. What it raises is raised here."""
        return await self._lanes.run(log, work)

    async def again(self, log: str) -> Retaken:
        """Take a log again from its first event, in its lane, once the projection has forgotten what it made of it."""
        return await self._lanes.run(log, partial(self._again_in_turn, log))

    async def _again_in_turn(self, log: str) -> Retaken:
        await self._forget(log)
        self._move(log, 0)
        self._stopped.discard(log)
        self._waiting.pop(log, None)
        taken = await self._take_up_to(log, None)
        return Retaken(taken=taken, stopped=log in self._stopped)

    async def again_all(self, first: Callable[[], Awaitable[None]]) -> Retaken:
        """Take every followed log again from its first event, once `first` is done with no lane working.

        `first` undoes everything the projection made. Events delivered meanwhile wait for it.
        """
        listed = {log: last for log, last in (await self._record.logs()).items() if self._follows_log(log)}
        async with self._lanes.alone():
            await first()
            for log in [*self._at, *listed]:
                if self._follows_log(log):
                    self._move(log, 0)
            self._stopped.clear()
        taken = 0

        async def retaken(log: str) -> None:
            nonlocal taken
            taken += await self._lanes.run(log, partial(self._take_up_to, log, None))

        await self._each(list(listed), retaken)
        return Retaken(taken=taken, stopped=any(log in self._stopped for log in listed))

    # ── The cursors, kept ──────────────────────────────────────────────

    async def _keep_every(self) -> None:
        while True:
            await asyncio.sleep(_KEEP_SECONDS)
            await self._keep()

    async def _keep(self) -> None:
        """Write the cursors, if one has moved since they were last written. Cursors that cannot be written are written the next time."""
        if not self._moved:
            return
        self._moved = False
        try:
            await asyncio.to_thread(self._cursors.keep, dict(self._at))
        except OSError as failure:
            self._moved = True
            _LOG.warning("The cursors could not be kept", extra={"error": _words_of(failure)})

    async def aclose(self) -> None:
        """Stop following. Nothing more is taken, and the cursors are written."""
        self._closed = True
        doing = [task for task in (self._sweeping, self._keeping) if task is not None]
        for task in doing:
            task.cancel()
        await asyncio.gather(*doing, return_exceptions=True)
        await self._lanes.aclose()
        await self._keep()
