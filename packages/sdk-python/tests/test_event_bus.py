"""A client's own bus: who is given a frame, in what order, and what its end ends."""

import logging

import pytest
from aio import run, soon

from semiont.channels import BECKON_HOVER, MARK_CANCEL_PENDING
from semiont.event_bus import EventBus
from semiont.events import Events
from semiont.identifiers import AnnotationId, ResourceId
from semiont.testing import FaultyTransport
from semiont.transport import Frame
from semiont.types import BeckonHoverEvent

ONE, OTHER = ResourceId("res-1"), ResourceId("res-2")


async def numbers(frames: Events[Frame]) -> list[object]:
    """What `n` each frame still to be read carries, once the bus has ended."""
    return [frame.payload["n"] async for frame in frames]


def test_a_reader_of_a_channel_does_not_see_a_scope_and_a_scope_sees_only_its_own() -> None:
    async def scenario() -> None:
        bus = EventBus()
        everyone = bus.frames_on("mark:added")
        one = bus.frames_on("mark:added", scope=ONE)
        other = bus.frames_on("mark:added", scope=OTHER)
        elsewhere = bus.frames_on("mark:removed")

        bus.emit("mark:added", {"n": 1})
        bus.emit("mark:added", {"n": 2}, scope=ONE)
        bus.emit("mark:added", {"n": 3}, scope=ResourceId("res-3"))
        bus.destroy()

        assert await soon(numbers(everyone)) == [1]
        assert await soon(numbers(one)) == [2]
        assert await soon(numbers(other)) == []
        assert await soon(numbers(elsewhere)) == []

    run(scenario())


def test_a_reader_of_several_channels_is_given_them_in_the_order_they_were_published() -> None:
    async def scenario() -> None:
        bus = EventBus()
        among = bus.frames_among(["job:complete", "job:fail", "job:report-progress"])
        bus.emit("job:report-progress", {"n": 1})
        bus.emit("job:queued", {"n": 2})
        bus.emit("job:fail", {"n": 3})
        bus.emit("job:report-progress", {"n": 4})
        # What is published into a scope is not published to everyone.
        bus.emit("job:complete", {"n": 5}, scope=ONE)
        bus.emit("job:complete", {"n": 6})
        bus.destroy()
        assert await soon(numbers(among)) == [1, 3, 4, 6]

    run(scenario())


def test_each_reader_is_given_every_frame_and_one_that_left_is_given_no_more() -> None:
    async def scenario() -> None:
        bus = EventBus()
        first, second = bus.frames_on("mark:added"), bus.frames_on("mark:added")
        bus.emit("mark:added", {"n": 1})
        await second.aclose()
        bus.emit("mark:added", {"n": 2})
        bus.destroy()
        assert await soon(numbers(first)) == [1, 2]
        assert await soon(numbers(second)) == []

    run(scenario())


def test_a_frame_carries_what_is_beside_its_payload() -> None:
    async def scenario() -> None:
        bus = EventBus()
        frames = bus.frames_on("match:search-requested")
        bus.emit("match:search-requested", {"n": 1}, correlation_id="cid-1")
        frame = await soon(anext(frames))
        assert (frame.channel, frame.correlation_id, frame.scope) == ("match:search-requested", "cid-1", None)

    run(scenario())


def test_a_destroyed_bus_publishes_nothing_and_its_readers_have_ended() -> None:
    async def scenario() -> None:
        bus = EventBus()
        before = bus.frames_on("mark:added")
        bus.destroy()
        bus.destroy()
        assert bus.destroyed
        bus.emit("mark:added", {"n": 1})
        assert await soon(numbers(before)) == []
        assert await soon(numbers(bus.frames_on("mark:added"))) == []
        assert await soon(numbers(bus.frames_among(["mark:added"]))) == []
        assert [frame async for frame in bus.frames(BECKON_HOVER)] == []

    run(scenario())


def test_by_type_a_frame_is_published_as_its_channel_writes_it_and_read_as_its_channel_types_it(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        bus = EventBus()
        raw, typed = bus.frames_on("beckon:hover"), bus.frames(BECKON_HOVER)
        nothing = bus.frames_on("mark:cancel-pending")

        bus.publish(BECKON_HOVER, BeckonHoverEvent(annotation_id=AnnotationId("ann-1")))
        # Nothing is hovered: the field says so, since the channel's payload requires it.
        bus.publish(BECKON_HOVER, BeckonHoverEvent(annotation_id=None))
        # What is not the channel's payload is nobody's to act on: it is not given, and is said so.
        bus.emit("beckon:hover", {"annotationId": 7})
        bus.publish(BECKON_HOVER, BeckonHoverEvent(annotation_id=AnnotationId("ann-2")))
        bus.emit("mark:cancel-pending", {})
        bus.destroy()

        assert [dict(frame.payload) async for frame in raw] == [
            {"annotationId": "ann-1"},
            {"annotationId": None},
            {"annotationId": 7},
            {"annotationId": "ann-2"},
        ]
        assert [delivered.payload.annotation_id async for delivered in typed] == ["ann-1", None, "ann-2"]
        assert [dict(frame.payload) async for frame in nothing] == [{}]
        assert MARK_CANCEL_PENDING.name == "mark:cancel-pending"

    with caplog.at_level(logging.WARNING, logger="semiont.bus"):
        run(scenario())
    assert ["a payload on beckon:hover is not that channel's" in record.getMessage() for record in caplog.records] == [True]


def test_a_transport_delivers_into_the_bus_it_was_bridged_into_every_frame_whatever_its_channel() -> None:
    async def scenario() -> None:
        transport = FaultyTransport(channels=("mark:added",))
        bus, second = EventBus(), EventBus()
        transport.bridge_into(bus)
        transport.bridge_into(second)
        heard = bus.frames_among(["mark:added", "job:complete"])
        scoped = bus.frames_on("mark:added", scope=ONE)
        also = second.frames_on("job:complete")

        transport.deliver(Frame(channel="mark:added", payload={"n": 1}))
        # A channel the transport's own readers were never promised still reaches the client's bus.
        transport.deliver(Frame(channel="job:complete", payload={"n": 2}, correlation_id="cid-2"))
        transport.deliver(Frame(channel="mark:added", payload={"n": 3}, scope=ONE))
        await transport.close()
        # A closed transport delivers no more, and the bus is its client's to end.
        transport.deliver(Frame(channel="mark:added", payload={"n": 4}))
        assert not bus.destroyed
        bus.destroy()
        second.destroy()

        # What came on a resource's scope is published to everyone, as what came on none is: the scope is the
        # stream's way to carry it, and the bus keeps its scopes for what the client's own parts say to each other.
        assert await soon(numbers(heard)) == [1, 2, 3]
        assert await soon(numbers(scoped)) == []
        assert await soon(numbers(also)) == [2]

    run(scenario())
