"""The stream's reader, held to `protocol/specs/src/bus/frame-cases.json`: the table every SDK's stream reader runs.

Each case's line is carried by a gateway's stream, and after it a frame of
`beckon:focus` that is read cleanly, so the stream is seen to go on past it.
What the transport delivers, what a typed read of `beckon:focus` is given, and
what the failure report is told are each held to the case.
"""

from typing import Final, Literal

import pytest
from aio import run, soon
from gateway_server import GatewayServer
from pydantic import BaseModel, JsonValue
from spec import SPEC, JsonObject

from semiont.bus import Bus, Delivered, Heard
from semiont.channels import BECKON_FOCUS
from semiont.errors import SemiontError
from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.retry import RetryPolicy
from semiont.transport import Frame, FrameRefusal
from semiont.types import BeckonFocusEvent
from semiont.watched import Variable, reached

type Told = Literal["readers", "failure-report"]
type Reason = Literal["lacks", "malformed"]


class DeliveredFrame(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame allows, which the reader delivers as it states it."""

    why: str
    frame: JsonObject


class RefusedFrame(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame does not allow, or whose payload is not its channel's, refused for its first fault."""

    why: str
    frame: JsonObject
    refused: Literal[True]
    member: str
    """The way to the member its first fault is at, from the frame: the names of the members it is within, and its own, joined by dots."""
    reason: Reason
    told: Told


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
CHANNELS: Final = (BECKON_FOCUS.name, "browse:resource-result")
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


def carry(gateway: GatewayServer, case: RefusedFrame | RefusedLine) -> None:
    if isinstance(case, RefusedFrame):
        gateway.send("e-case", case.frame)
    else:
        gateway.write(f"id: e-case\nevent: bus-event\ndata: {case.data}\n\n")
    gateway.send("e-after", AFTER)


def test_the_table_has_a_frame_of_each_kind() -> None:
    assert DELIVERED
    assert {case.reason for case in REFUSED} == {"lacks", "malformed"}
    assert {case.told for case in REFUSED} == {"readers", "failure-report"}


@pytest.mark.parametrize("case", DELIVERED, ids=lambda case: case.why)
def test_a_frame_busframe_allows_is_delivered_as_it_states_it(case: DeliveredFrame) -> None:
    async def scenario() -> tuple[JsonObject, list[SemiontError]]:
        channel = case.frame["channel"]
        assert isinstance(channel, str)
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            frames, failures = transport.frames(channel), transport.failures()
            gateway.send("e-case", case.frame)
            read = await soon(anext(frames))
        assert isinstance(read, Frame), read
        return stated(read), [failure async for failure in failures]

    assert run(scenario()) == (case.frame, [])


@pytest.mark.parametrize("case", REFUSED, ids=lambda case: case.why)
def test_a_refused_frame_is_told_to_whom_the_table_states_for_its_first_fault_and_the_stream_goes_on(
    case: RefusedFrame | RefusedLine,
) -> None:
    async def scenario() -> tuple[list[Heard[BeckonFocusEvent]], list[SemiontError]]:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            read, failures = Bus(transport).frames(BECKON_FOCUS), transport.failures()
            carry(gateway, case)
            before: list[Heard[BeckonFocusEvent]] = []
            while not isinstance(heard := await soon(anext(read)), Delivered) or heard.payload.resource_id != "after":
                before.append(heard)
            assert transport.state.value == "open", "the stream goes on"
        return before, [failure async for failure in failures]

    before, told = run(scenario())
    if case.told == "readers":
        assert isinstance(case, RefusedFrame)
        assert case.frame["channel"] == BECKON_FOCUS.name
        # A frame that carries no payload is refused with none, as is one whose payload is null.
        payload: JsonValue = case.frame.get("payload")
        scope = case.frame.get("scope")
        assert before == [
            FrameRefusal(
                channel=BECKON_FOCUS.name,
                member=case.member,
                reason=case.reason,
                payload=payload,
                scope=None if scope is None else ResourceId(str(scope)),
            )
        ]
        assert told == []
    else:
        assert before == []
        assert [(failure.code, failure.status, str(failure)) for failure in told] == [
            ("error", None, f"the stream carried what is not a frame: {said(case.member, case.reason)}")
        ]
