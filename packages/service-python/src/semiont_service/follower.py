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

An event the projection refuses as recorded (`Refused`) is taken as nothing,
and counted. One whose taking fails for any other reason stops its log where
it is, and the next sweep takes the log on from there.

The rule is docs/protocol/TRANSPORT-CONTRACT.md § What repairs a passing
frame, and what it does in each case is specs/src/follower/follow-cases.json.
Cursors are kept in a file on the container's own disk, never in the knowledge
base: losing one costs time, never correctness.
"""

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, Protocol, final

from semiont.types import StoredEventResponse

__all__ = [
    "SYSTEM",
    "Cursors",
    "Followed",
    "Follower",
    "FromTheFirst",
    "OwnStart",
    "Record",
    "Refused",
    "Take",
    "WithNoCursor",
    "log_of",
]

SYSTEM: Final = "__system__"
"""The log of the knowledge base's own events, by the record's name for it."""

type Followed = Literal["resources", "__system__"]
"""What a follower follows: every resource's log, and `__system__`."""

_NOT_YET: Final = "the follower does not follow yet"


@final
class Refused(Exception):
    """An event the projection cannot take as it is recorded. Its words say which event, and what it lacks."""


def log_of(event: StoredEventResponse) -> str:
    """The log an event is of: its resource's, or `__system__` for an event that names none."""
    return SYSTEM if event.resource_id is None else event.resource_id


class Record(Protocol):
    """The record, as a follower reads it: by position."""

    async def logs(self) -> Mapping[str, int]:
        """Every log the record has, each with the sequence of its last event."""
        ...

    async def after(self, log: str, sequence: int) -> Sequence[StoredEventResponse]:
        """A log's events after `sequence`, in order."""
        ...


type Take = Callable[[StoredEventResponse], Awaitable[None]]
"""Taking an event: applying it, or applying it as nothing where the projection has no use for its type.

It raises `Refused` for an event it cannot take as recorded, and anything else where the taking failed for a passing reason.
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
class Cursors:
    """Each log's cursor, in a file on the container's own disk."""

    def __init__(self, path: Path) -> None:
        self._path: Final = path

    def held(self) -> Mapping[str, int]:
        """Each log's cursor, as the file holds it."""
        raise NotImplementedError(_NOT_YET)

    def move(self, log: str, sequence: int) -> None:
        """Move a log's cursor to `sequence`, in the file."""
        raise NotImplementedError(_NOT_YET)


@final
class Follower:
    """A follower of the record. See the module's documentation."""

    def __init__(self, *, record: Record, take: Take, follows: frozenset[Followed], with_no_cursor: WithNoCursor, cursors: Cursors) -> None:
        raise NotImplementedError(_NOT_YET)

    def start(self) -> None:
        """Start following: sweep each log followed."""
        raise NotImplementedError(_NOT_YET)

    def delivered(self, event: StoredEventResponse) -> None:
        """An event the stream delivered: a hint of what the record holds."""
        raise NotImplementedError(_NOT_YET)

    def dropped(self) -> None:
        """The stream dropped: what is recorded while it is down is never delivered."""
        raise NotImplementedError(_NOT_YET)

    def reopened(self) -> None:
        """The stream opened again after a drop: sweep each log followed."""
        raise NotImplementedError(_NOT_YET)

    async def settled(self) -> None:
        """Wait until nothing is left to take, and every cursor moved is in its file."""
        raise NotImplementedError(_NOT_YET)

    @property
    def refused(self) -> int:
        """How many events were refused as recorded, and taken as nothing."""
        raise NotImplementedError(_NOT_YET)

    @property
    def stopped(self) -> frozenset[str]:
        """The logs a failed taking has stopped, until the next sweep."""
        raise NotImplementedError(_NOT_YET)

    async def aclose(self) -> None:
        """Stop following. Nothing more is taken."""
        raise NotImplementedError(_NOT_YET)
