"""The stream's reader, held to `protocol/specs/src/bus/frame-cases.json`: the table every SDK's stream reader runs.

Each case's line is carried by a gateway's stream, and after it a frame of
`beckon:focus` that is read cleanly, so the stream is seen to go on past it.
What the transport delivers, what a typed read of the case's channel is given,
what the failure report is told, and what becomes of a reply awaited by the
correlation id a request's case names are each held to the case. A frame
delivered on a failure's channel is read by type too, and what is read is
held to the case's `read`.
"""

import asyncio
from typing import Final, Literal

import pytest
from aio import run, soon, turns
from gateway_server import GatewayServer
from pydantic import BaseModel, Field
from spec import SPEC, JsonObject

from semiont.bus import Bus, Delivered, Heard, Typed
from semiont.channels import BECKON_FOCUS, GATHER_FAILED
from semiont.errors import SemiontError
from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.retry import RetryPolicy
from semiont.transport import Frame, FrameRefusal
from semiont.types import BeckonFocusEvent, BrowseResourceResult, CommandError, GatherFailed
from semiont.watched import Variable, reached

type Told = Literal["readers", "failure-report"]
type Reason = Literal["lacks", "malformed"]
type Request = Literal["fails", "waits"]


class DeliveredFrame(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame allows, which the reader delivers as it states it."""

    why: str
    frame: JsonObject
    read: JsonObject | None = None
    """The payload its channel's typed reader reads, when that is not the payload as the frame states it."""


class RefusedFrame(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame does not allow, or whose payload is not its channel's, refused for its first fault."""

    why: str
    frame: JsonObject
    refused: Literal[True]
    member: str
    """The way to the member its first fault is at, from the frame: the names of the members it is within, and its own, joined by dots."""
    reason: Reason
    told: Told
    correlation_id: str | None = Field(default=None, alias="correlationId")
    """The correlation id its refusal carries, when it carries one."""
    request: Request | None = None
    """What becomes of a reply awaited by `AWAITED` on the frame's channel when the line is carried, when the case says."""


class RefusedLine(BaseModel, frozen=True, extra="forbid"):
    """A `data` line that is no JSON, which the reader refuses as malformed."""

    why: str
    data: str
    refused: Literal[True]
    member: str
    reason: Reason
    told: Told


class Table(BaseModel, frozen=True):
    cases: list[DeliveredFrame | RefusedFrame | RefusedLine]


TABLE: Final = Table.model_validate_json((SPEC / "bus/frame-cases.json").read_bytes())
DELIVERED: Final = [case for case in TABLE.cases if isinstance(case, DeliveredFrame)]
REFUSED: Final = [case for case in TABLE.cases if not isinstance(case, DeliveredFrame)]

QUICK: Final = Timing(
    reconnect_ms=10, lazy_remove_ms=10, linger_ms=10, emit_retry=RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1)
)
REPLY: Final = BROWSE_RESOURCE_REQUESTED.result
"""The channel of the reply a request's case awaits, which it is read on by type."""
FAILED: Final = BROWSE_RESOURCE_REQUESTED.failure
CHANNELS: Final = (BECKON_FOCUS.name, REPLY.name, FAILED.name, GATHER_FAILED.name)
AWAITED: Final = "c-1"
"""The correlation id a request's case names the reply it awaits by."""
AFTER: Final[JsonObject] = {"channel": BECKON_FOCUS.name, "payload": {"resourceId": "after"}}
"""The frame each case's line is followed by."""


def said(member: str, reason: Reason) -> str:
    """A fault in the words every SDK says one in."""
    if reason == "lacks":
        return f"it has no `{member}`"
    return "it is malformed" if member == "" else f"its `{member}` is malformed"


def stated(frame: Frame) -> JsonObject:
    """`frame` as a line of the stream states it."""
    line: JsonObject = {"channel": frame.channel, "payload": dict(frame.payload)}
    if frame.correlation_id is not None:
        line["correlationId"] = frame.correlation_id
    if frame.scope is not None:
        line["scope"] = frame.scope
    return line


def read_on(case: RefusedFrame | RefusedLine) -> str:
    """The channel a case is read on by type: a request's case on its reply's, every other on `beckon:focus`."""
    return REPLY.name if isinstance(case, RefusedFrame) and case.frame.get("channel") == REPLY.name else BECKON_FOCUS.name


def by_type(bus: Bus, channel: str) -> Typed[BeckonFocusEvent] | Typed[BrowseResourceResult]:
    return bus.frames(REPLY) if channel == REPLY.name else bus.frames(BECKON_FOCUS)


def refusal_of(case: RefusedFrame) -> FrameRefusal:
    """The refusal a case told to its readers is given as."""
    # A frame that carries no payload is refused with none, as is one whose payload is null.
    scope = case.frame.get("scope")
    return FrameRefusal(
        channel=read_on(case),
        member=case.member,
        reason=case.reason,
        payload=case.frame.get("payload"),
        scope=None if scope is None else ResourceId(str(scope)),
        correlation_id=case.correlation_id,
    )


def carry(gateway: GatewayServer, case: RefusedFrame | RefusedLine) -> None:
    if isinstance(case, RefusedFrame):
        gateway.send("e-case", case.frame)
    else:
        gateway.write(f"id: e-case\nevent: bus-event\ndata: {case.data}\n\n")
    gateway.send("e-after", AFTER)


async def past_after(read: Typed[BeckonFocusEvent]) -> None:
    """Read `beckon:focus` as far as the frame each case's line is followed by."""
    async for heard in read:
        if isinstance(heard, Delivered) and heard.payload.resource_id == "after":
            return


def test_the_table_has_a_frame_of_each_kind() -> None:
    assert DELIVERED
    assert any(case.read is not None for case in DELIVERED)
    assert {case.reason for case in REFUSED} == {"lacks", "malformed"}
    assert {case.told for case in REFUSED} == {"readers", "failure-report"}
    assert {case.request for case in REFUSED if isinstance(case, RefusedFrame) and case.request is not None} == {"fails", "waits"}


def failure_by_type(bus: Bus, channel: str) -> Typed[CommandError] | Typed[GatherFailed]:
    """A typed read of a failure's channel a delivered case is on."""
    if channel == FAILED.name:
        return bus.frames(FAILED)
    assert channel == GATHER_FAILED.name, f"{channel} is no failure's channel this runner reads by type"
    return bus.frames(GATHER_FAILED)


@pytest.mark.parametrize("case", DELIVERED, ids=lambda case: case.why)
def test_a_frame_busframe_allows_is_delivered_as_it_states_it(case: DeliveredFrame) -> None:
    channel = case.frame["channel"]
    assert isinstance(channel, str)
    on_a_failure = channel in (FAILED.name, GATHER_FAILED.name)
    # What is read by type is held to the case on a failure's channel, and a case on another states none.
    assert on_a_failure or case.read is None, f"this runner reads no frame on {channel} by type"

    async def scenario() -> tuple[JsonObject, JsonObject | None, list[SemiontError]]:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            frames, failures = transport.frames(channel), transport.failures()
            typed = failure_by_type(Bus(transport), channel) if on_a_failure else None
            gateway.send("e-case", case.frame)
            delivered = await soon(anext(frames))
            heard = None if typed is None else await soon(anext(typed))
        assert isinstance(delivered, Frame), delivered
        if heard is None:
            return stated(delivered), None, [failure async for failure in failures]
        assert isinstance(heard, Delivered), heard
        return stated(delivered), written(heard.payload), [failure async for failure in failures]

    read: JsonObject | None = None
    if on_a_failure:
        payload = case.frame["payload"]
        assert isinstance(payload, dict)
        read = payload if case.read is None else case.read
    assert run(scenario()) == (case.frame, read, [])


@pytest.mark.parametrize("case", REFUSED, ids=lambda case: case.why)
def test_a_refused_frame_is_told_to_whom_the_table_states_for_its_first_fault_and_the_stream_goes_on(
    case: RefusedFrame | RefusedLine,
) -> None:
    channel = read_on(case)

    async def scenario() -> tuple[list[Heard[BeckonFocusEvent] | Heard[BrowseResourceResult]], list[SemiontError]]:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            bus = Bus(transport)
            read, after, failures = by_type(bus, channel), bus.frames(BECKON_FOCUS), transport.failures()
            with transport.track_reply(AWAITED, (REPLY.name, FAILED.name)) as pending:
                replied = asyncio.ensure_future(pending.frame())
                carry(gateway, case)
                await soon(past_after(after))
                assert transport.state.value == "open", "the stream goes on"
                await turns()
                if isinstance(case, RefusedFrame) and case.request == "fails":
                    assert replied.done(), "told at once"
                    assert replied.result() == refusal_of(case)
                if isinstance(case, RefusedFrame) and case.request == "waits":
                    assert not replied.done(), "told nothing"
                replied.cancel()
                await asyncio.gather(replied, return_exceptions=True)
        given = [heard async for heard in read]
        # A read of `beckon:focus` was given the frame that followed too.
        return (given[:-1] if channel == BECKON_FOCUS.name else given), [failure async for failure in failures]

    before, told = run(scenario())
    if case.told == "readers":
        assert isinstance(case, RefusedFrame)
        assert case.frame["channel"] == channel
        assert before == [refusal_of(case)]
        assert told == []
    else:
        assert before == []
        assert [(failure.code, failure.status, str(failure)) for failure in told] == [
            ("error", None, f"the stream carried what is not a frame: {said(case.member, case.reason)}")
        ]
