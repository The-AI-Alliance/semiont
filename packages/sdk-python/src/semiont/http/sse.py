"""The stream's framing (`docs/protocol/TRANSPORT-HTTP.md` § Wire framing and client parser obligations).

`text/event-stream`: each event an `event` line, an `id` line and one `data`
line, ended by a blank line.

The parser holds its state across reads. One event can span many reads of the
connection, and a read can end anywhere: inside a line, between a line and its
blank line, inside a character. So it keeps bytes until a line is whole and
decodes a line only then, and it scans each read once, however long the line
it belongs to has grown.
"""

from dataclasses import dataclass
from typing import final

__all__ = ["SseEvent", "SseParser"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SseEvent:
    """One event of the stream."""

    event: str
    id: str | None
    data: str


@final
class SseParser:
    """Takes a stream's bytes as they are read, and gives the events they complete."""

    def __init__(self) -> None:
        self._line: list[bytes] = []
        """The pieces of the line not yet ended, joined once, when its newline arrives."""
        self._event = ""
        self._id: str | None = None
        self._data: str | None = None

    def feed(self, read: bytes) -> list[SseEvent]:
        """Take the next bytes read. Returns the events they complete."""
        events: list[SseEvent] = []
        start = 0
        while (end := read.find(b"\n", start)) >= 0:
            self._line.append(read[start:end])
            start = end + 1
            line = b"".join(self._line)
            self._line.clear()
            event = self._line_ended(line)
            if event is not None:
                events.append(event)
        if start < len(read):
            self._line.append(read[start:])
        return events

    def _line_ended(self, raw: bytes) -> SseEvent | None:
        line = raw.decode("utf-8", errors="replace").removesuffix("\r")
        if line == "":
            event = SseEvent(event=self._event, id=self._id, data=self._data or "")
            had_anything = event.event != "" or event.id is not None or event.data != ""
            self._event, self._id, self._data = "", None, None
            return event if had_anything else None
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            self._event = value
        elif field == "id":
            self._id = value
        elif field == "data":
            self._data = value if self._data is None else f"{self._data}\n{value}"
        return None
