"""A stream whose first reader is given what was said before it came: the latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT`."""

from collections import deque
from typing import Final, final

from semiont.events import Broadcast, Events
from semiont.timing import ERRORS_KEPT_FOR_FIRST_READER_COUNT

__all__ = ["KeptForFirstReader", "Latest"]


@final
class Latest[T](deque[T]):
    """What waits for a reader who has not come: the latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT` appended, the oldest dropped."""

    def __init__(self) -> None:
        super().__init__(maxlen=ERRORS_KEPT_FOR_FIRST_READER_COUNT)


@final
class KeptForFirstReader[T]:
    """What is delivered, to every reader listening, and, while none has come, kept for the first.

    The first reader is given the latest `ERRORS_KEPT_FOR_FIRST_READER_COUNT`
    delivered before it came, in the order they were delivered, the oldest
    beyond them dropped; every later one, what is delivered from then on.
    Closing drops what is still kept: a reader that comes after is given
    nothing, and its events are over.
    """

    def __init__(self) -> None:
        self._broadcast: Final = Broadcast[T]()
        self._kept: Latest[T] | None = Latest()
        """What was delivered while nobody has listened, for the first who does; none once one has, or it has closed."""

    def listen(self) -> Events[T]:
        """A reader: the first given what was kept for it, then what is delivered from now on."""
        kept, self._kept = self._kept, None
        return self._broadcast.listen() if kept is None else self._broadcast.listen_with(kept)

    def deliver(self, item: T) -> None:
        """Give `item` to every reader, or, while none has come, keep it for the first."""
        if self._kept is None:
            self._broadcast.deliver(item)
        else:
            self._kept.append(item)

    def close(self) -> None:
        """End every reader's events, once it has read what was delivered, and drop what was kept for a first who has not come."""
        self._kept = None
        self._broadcast.close()
