"""The transport contract's own parts, and the request made over them.

The connection's states are stated in the protocol's documents and written
again here by hand, so a test holds this SDK's to the documents'. The request
is run against a transport this file scripts, for what no gateway can be made
to do on cue.
"""

import asyncio
import re
from collections.abc import Mapping
from typing import get_args

import pytest
from aio import run, soon
from pydantic import JsonValue
from scripted_transport import Scripted
from spec import ROOT, SPEC, objects, read, text

from semiont.bus import request
from semiont.errors import BusRequestError, TransportError
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.transport import (
    CONNECTION_STATE_MAY_BECOME,
    CONNECTION_STATES,
    ConnectionState,
    Frame,
    ReplyRouter,
    ResourceHold,
)

PROTOCOL = ROOT / "docs/protocol"
RESULT, FAILURE = "browse:resource-result", "browse:resource-failed"


def test_the_states_are_the_ones_the_contract_states_and_the_type_names_no_other() -> None:
    contract = (PROTOCOL / "TRANSPORT-CONTRACT.md").read_text(encoding="utf-8")
    stated = re.search(r"### State\n\n```\n(.+?)\n```", contract, re.DOTALL)
    assert stated is not None, "the contract no longer states the connection's states where this test reads them"
    assert tuple(re.findall(r"'([a-z]+)'", stated.group(1))) == CONNECTION_STATES
    assert get_args(ConnectionState.__value__) == CONNECTION_STATES


def test_each_state_may_become_what_the_protocol_says_it_may() -> None:
    lifecycle = (PROTOCOL / "TRANSPORT-HTTP.md").read_text(encoding="utf-8")
    stated = re.search(r"```\n(initial +→.+?)\n```", lifecycle, re.DOTALL)
    assert stated is not None, "the protocol no longer states the transitions where this test reads them"
    transitions: dict[str, frozenset[str]] = {}
    for line in stated.group(1).splitlines():
        state, _, after = line.partition("→")
        transitions[state.strip()] = frozenset() if "terminal" in after else frozenset(name.strip() for name in after.split("|"))
    assert transitions == CONNECTION_STATE_MAY_BECOME


def frame(channel: str, correlation_id: str | None = None, payload: Mapping[str, JsonValue] | None = None) -> Frame:
    return Frame(channel=channel, payload={} if payload is None else payload, correlation_id=correlation_id)


def test_a_reply_reaches_the_request_that_awaits_it_and_no_other() -> None:
    async def scenario() -> tuple[Frame | None, list[str], list[str]]:
        router = ReplyRouter()
        with router.track("b", [RESULT, FAILURE]) as second, router.track("a", [RESULT, FAILURE]) as first:
            named = router.awaited()
            router.route(frame(RESULT))
            router.route(frame(RESULT, "c"))
            router.route(frame("browse:resources-result", "a"))
            assert router.awaited() == ["a", "b"]
            router.route(frame(FAILURE, "a"))
            reply = await soon(first.frame())
            assert router.awaited() == ["b"]
            assert second is not first
        return reply, named, router.awaited()

    reply, named, after = run(scenario())
    assert reply == frame(FAILURE, "a")
    assert named == ["a", "b"]
    assert after == []


def test_a_closed_router_tells_every_request_no_reply_will_come() -> None:
    async def scenario() -> tuple[Frame | None, Frame | None, list[str]]:
        router = ReplyRouter()
        pending = router.track("a", [RESULT])
        router.close()
        return await soon(pending.frame()), await soon(router.track("b", [RESULT]).frame()), router.awaited()

    assert run(scenario()) == (None, None, [])


def test_a_hold_is_let_go_once() -> None:
    released: list[str] = []
    hold = ResourceHold(lambda: released.append("released"))
    with hold:
        pass
    hold.release()
    assert released == ["released"]


ASKED: Mapping[str, JsonValue] = {"resourceId": "r1"}


def test_a_request_is_one_emit_under_an_id_of_its_own_and_resolves_with_the_reply_that_carries_it() -> None:
    async def scenario() -> tuple[Mapping[str, JsonValue], Scripted]:
        transport = Scripted([RESULT, FAILURE], "open")
        asking = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        correlation_id = await soon(transport.asked())
        assert transport.router.awaited() == [correlation_id]
        transport.router.route(frame(RESULT, "another request's", {"response": "not this one"}))
        transport.router.route(frame(RESULT, correlation_id, {"response": {"found": True}}))
        return await soon(asking), transport

    result, transport = run(scenario())
    assert result == {"response": {"found": True}}
    assert [(frame.channel, frame.payload) for frame in transport.emitted] == [("browse:resource-requested", ASKED)]
    assert transport.router.awaited() == []


def test_a_request_answered_on_its_failure_channel_fails_under_the_code_the_table_gives_the_failure_s_own() -> None:
    table = read(SPEC / "errors/codes.json")["busRequest"]
    assert isinstance(table, dict)
    by_wire = {
        text(entry["wire"], "a wire code"): text(entry["code"], "a code") for entry in objects(table["codes"], "codes") if "wire" in entry
    }
    unrecognized = text(table["unrecognizedFailure"], "unrecognizedFailure")
    assert by_wire

    async def scenario(failure: Mapping[str, JsonValue]) -> BusRequestError:
        transport = Scripted([RESULT, FAILURE], "open")
        asking = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        transport.router.route(frame(FAILURE, await soon(transport.asked()), failure))
        with pytest.raises(BusRequestError) as raised:
            await soon(asking)
        assert transport.router.awaited() == []
        return raised.value

    for wire, code in by_wire.items():
        error = run(scenario({"message": "said by the peer", "code": wire}))
        assert (error.code, error.message, error.failure) == (code, "said by the peer", {"message": "said by the peer", "code": wire})
    assert run(scenario({"message": "no code at all"})).code == unrecognized
    assert run(scenario({"message": "a code from a later peer", "code": "not-a-code-yet"})).code == unrecognized
    assert run(scenario({"code": 7})).message == "Bus request rejected"


def test_a_request_whose_replies_the_stream_does_not_carry_fails_at_once_and_sends_nothing() -> None:
    async def scenario() -> tuple[str, int]:
        transport = Scripted([RESULT], "open")
        with pytest.raises(BusRequestError) as raised:
            await request(transport, BROWSE_RESOURCE_REQUESTED, ASKED)
        return raised.value.code, len(transport.emitted)

    assert run(scenario()) == ("bus.unsubscribed", 0)


def test_a_request_of_a_closed_transport_fails_as_closed_and_sends_nothing() -> None:
    async def scenario() -> tuple[str, str, int]:
        transport = Scripted([RESULT, FAILURE], "closed")
        with pytest.raises(BusRequestError) as at_once:
            await soon(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        waiting = Scripted([RESULT, FAILURE], "connecting")
        asking = asyncio.ensure_future(request(waiting, BROWSE_RESOURCE_REQUESTED, ASKED))
        await asyncio.sleep(0.01)
        await waiting.close()
        with pytest.raises(BusRequestError) as while_waiting:
            await soon(asking)
        return at_once.value.code, while_waiting.value.code, len(transport.emitted) + len(waiting.emitted)

    assert run(scenario()) == ("bus.closed", "bus.closed", 0)


def test_a_request_waits_for_the_stream_inside_its_own_deadline() -> None:
    async def scenario() -> tuple[int, int, str, int]:
        transport = Scripted([RESULT, FAILURE], "connecting")
        asking = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        await asyncio.sleep(0.02)
        before = len(transport.emitted)
        transport.now.set("open")
        transport.router.route(frame(RESULT, await soon(transport.asked())))
        await soon(asking)

        never = Scripted([RESULT, FAILURE], "reconnecting")
        with pytest.raises(BusRequestError) as raised:
            await soon(request(never, BROWSE_RESOURCE_REQUESTED, ASKED, timeout_ms=30))
        return before, len(transport.emitted), raised.value.code, len(never.emitted)

    assert run(scenario()) == (0, 1, "bus.timeout", 0)


def test_a_request_nobody_answers_times_out_and_is_tracked_no_more() -> None:
    async def scenario() -> tuple[str, list[str], int]:
        transport = Scripted([RESULT, FAILURE], "open")
        with pytest.raises(BusRequestError) as raised:
            await soon(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED, timeout_ms=30))
        return raised.value.code, transport.router.awaited(), len(transport.emitted)

    assert run(scenario()) == ("bus.timeout", [], 1)


def test_a_request_whose_emit_is_refused_fails_with_that_refusal_and_is_tracked_no_more() -> None:
    async def scenario() -> tuple[str, list[str]]:
        transport = Scripted([RESULT, FAILURE], "open")
        transport.refusal = TransportError.of_status("refused", 409, None)
        with pytest.raises(TransportError) as raised:
            await soon(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        return raised.value.code, transport.router.awaited()

    assert run(scenario()) == ("conflict", [])


def test_a_request_abandoned_is_tracked_no_more_and_one_abandoned_while_it_waits_for_its_stream_is_never_sent() -> None:
    async def scenario() -> tuple[int, list[str], int]:
        sent = Scripted([RESULT, FAILURE], "open")
        asking = asyncio.ensure_future(request(sent, BROWSE_RESOURCE_REQUESTED, ASKED))
        correlation_id = await soon(sent.asked())
        asking.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asking
        # A reply that comes anyway reaches nobody.
        sent.router.route(frame(RESULT, correlation_id))

        waiting = Scripted([RESULT, FAILURE], "connecting")
        never_sent = asyncio.ensure_future(request(waiting, BROWSE_RESOURCE_REQUESTED, ASKED))
        await asyncio.sleep(0.01)
        never_sent.cancel()
        with pytest.raises(asyncio.CancelledError):
            await never_sent
        waiting.now.set("open")
        await asyncio.sleep(0.01)
        return len(sent.emitted), sent.router.awaited(), len(waiting.emitted)

    assert run(scenario()) == (1, [], 0)
