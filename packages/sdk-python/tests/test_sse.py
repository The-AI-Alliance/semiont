"""The stream's parser gives the same events wherever the reads fall (`docs/protocol/TRANSPORT-HTTP.md` § Wire framing)."""

from semiont.http.sse import SseEvent, SseParser

STREAM = (
    'event: bus-event\nid: e-beckon:focus:1\ndata: {"channel":"beckon:focus","payload":{"annotationId":"naïve — 日本語 😀"}}\n\n'
    "event: ping\ndata:\n\n"
    'event: bus-event\nid: p-res-1-2\ndata: {"channel":"mark:added","payload":{},"scope":"res-1"}\n\n'
).encode()


def whole() -> list[SseEvent]:
    return SseParser().feed(STREAM)


def test_a_stream_read_at_once_gives_its_events() -> None:
    events = whole()
    assert [event.event for event in events] == ["bus-event", "ping", "bus-event"]
    assert events[0].id == "e-beckon:focus:1"
    assert "naïve — 日本語 😀" in events[0].data
    assert events[1] == SseEvent(event="ping", id=None, data="")
    assert events[2].id == "p-res-1-2"


def test_the_events_do_not_depend_on_where_the_reads_fall() -> None:
    # Every split point, and every size of read down to a byte, which splits
    # lines, blank lines and characters.
    for split in range(len(STREAM) + 1):
        parser = SseParser()
        assert parser.feed(STREAM[:split]) + parser.feed(STREAM[split:]) == whole(), f"split at {split}"
    for size in range(1, 8):
        parser = SseParser()
        events = [event for start in range(0, len(STREAM), size) for event in parser.feed(STREAM[start : start + size])]
        assert events == whole(), f"reads of {size}"


def test_a_carriage_return_before_the_newline_is_not_part_of_the_line() -> None:
    assert SseParser().feed(b"event: bus-event\r\ndata: {}\r\n\r\n") == [SseEvent(event="bus-event", id=None, data="{}")]


def test_a_blank_line_with_nothing_before_it_is_no_event() -> None:
    assert SseParser().feed(b"\n\n: a comment\n\n") == []


def test_a_line_that_grows_over_many_reads_is_given_whole() -> None:
    parser = SseParser()
    long = "x" * 200_000
    events: list[SseEvent] = []
    for piece in (b"event: bus-event\ndata: ", *(long[start : start + 4096].encode() for start in range(0, len(long), 4096)), b"\n\n"):
        events += parser.feed(piece)
    assert events == [SseEvent(event="bus-event", id=None, data=long)]
