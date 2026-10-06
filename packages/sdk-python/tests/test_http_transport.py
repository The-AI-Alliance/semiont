"""The HTTP transport, for what the conformance corpus cannot script.

The corpus holds it to the protocol against a real gateway
(`tests/conformance/sdk/wire`). Here are the parts with no wire to show them
on: the arithmetic of its backoff, the window of ids it remembers, what a
closed transport leaves behind, and what it does with a stream that carries
something other than a frame.
"""

import asyncio
import logging

import pytest
from aio import run, soon
from gateway_server import Answer, GatewayServer

from semiont.bus import request
from semiont.channels import BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS
from semiont.errors import BusRequestError, SemiontError, TransportError
from semiont.http import HttpTransport, Timing
from semiont.http.stream import SeenIds, backoff_cap_ms
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.retry import RetryPolicy
from semiont.timing import MAX_RECONNECT_MS, RECONNECT_MS
from semiont.transport import ConnectionState, Frame
from semiont.watched import Variable, reached

QUICK = Timing(reconnect_ms=10, lazy_remove_ms=10, linger_ms=10, emit_retry=RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1))
CHANNELS = ("beckon:focus", "browse:resource-result", "browse:resource-failed")


def test_the_wait_before_a_connect_doubles_per_failure_up_to_the_ceiling() -> None:
    assert [backoff_cap_ms(RECONNECT_MS, failures) for failures in range(5)] == [5000, 10000, 20000, 40000, MAX_RECONNECT_MS]
    assert [backoff_cap_ms(50, failures) for failures in range(4)] == [50, 100, 200, 400]
    assert backoff_cap_ms(50, 11) == MAX_RECONNECT_MS
    # However long the gateway has been away, the wait is the ceiling and no more.
    assert backoff_cap_ms(1, 10_000) == MAX_RECONNECT_MS
    assert backoff_cap_ms(MAX_RECONNECT_MS * 3, 0) == MAX_RECONNECT_MS


def test_the_ids_remembered_are_the_last_ones_delivered() -> None:
    seen = SeenIds(3)
    assert [seen.remember(event_id) for event_id in ("a", "b", "c")] == [True, True, True]
    assert not seen.remember("a"), "a frame delivered is not delivered again"
    assert seen.remember("d")
    assert seen.remember("a"), "the oldest has been forgotten"
    assert not seen.remember("c")


def test_no_channel_is_heard_twice() -> None:
    assert len(set(BRIDGED_CHANNELS)) == len(BRIDGED_CHANNELS)
    assert set(BRIDGED_CHANNELS).isdisjoint(RESOURCE_SCOPED_CHANNELS)


async def opened(transport: HttpTransport) -> None:
    await soon(reached(transport.state, lambda state: state == "open"))


def test_a_frame_is_delivered_with_what_is_beside_its_payload_and_what_is_not_a_frame_is_not(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> list[Frame]:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK) as transport,
        ):
            await opened(transport)
            frames = transport.frames("beckon:focus")
            gateway.write("event: ping\ndata:\n\n")
            gateway.send("e-1", {"channel": "beckon:focus", "payload": {"annotationId": "a-1", "_userId": "did:web:example.org:users:a"}})
            gateway.send("e-2", {"channel": "beckon:focus", "payload": {}, "scope": "not an id"})
            gateway.write("id: e-3\nevent: bus-event\ndata: {not json\n\n")
            gateway.send("e-1", {"channel": "beckon:focus", "payload": {"annotationId": "the same id again"}})
            gateway.send("e-4", {"channel": "beckon:focus", "payload": {"annotationId": "a-2"}, "scope": "res-1", "correlationId": "c"})
            gateway.send("e-5", {"channel": "beckon:focus", "payload": {}, "addedByALaterGateway": True})
            delivered = [await soon(anext(frames)), await soon(anext(frames)), await soon(anext(frames))]
        assert [frame async for frame in frames] == []
        return delivered

    with caplog.at_level(logging.WARNING, logger="semiont.http"):
        delivered = run(scenario())
    assert delivered == [
        Frame(channel="beckon:focus", payload={"annotationId": "a-1", "_userId": "did:web:example.org:users:a"}),
        Frame(channel="beckon:focus", payload={"annotationId": "a-2"}, scope=ResourceId("res-1"), correlation_id="c"),
        # A frame a later gateway adds a field to is still a frame.
        Frame(channel="beckon:focus", payload={}),
    ]
    assert [record.getMessage().split(":")[0] for record in caplog.records] == [
        "the stream carried what is not a frame (id e-2)",
        "the stream carried what is not a frame (id e-3)",
    ]


def test_a_closed_transport_has_ended_everything_it_began() -> None:
    async def scenario() -> tuple[list[ConnectionState], list[Frame], list[SemiontError], str, str, list[str]]:
        async with GatewayServer() as gateway:
            transport = HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=QUICK)
            states: list[ConnectionState] = []

            async def watch() -> None:
                async for state in transport.state:
                    states.append(state)

            watching = asyncio.create_task(watch())
            async with transport:
                await opened(transport)
                frames, failures = transport.frames("beckon:focus"), transport.failures()
                hold = transport.subscribe_to_resource(ResourceId("res-1"))
                await soon(gateway.streams(2))
                asking = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, {"resourceId": "res-1"}))
                await soon(gateway.arrived("POST", "/bus/emit"))
            # Left: its stream has ended, and so has every reader's wait.
            await soon(watching)
            hold.release()
            with pytest.raises(BusRequestError) as pending:
                await soon(asking)
            with pytest.raises(BusRequestError) as after:
                await soon(request(transport, BROWSE_RESOURCE_REQUESTED, {"resourceId": "res-1"}))
            with pytest.raises(TransportError) as emitted:
                await soon(transport.emit("beckon:focus", {}))
            await transport.close()
            return (
                states,
                [frame async for frame in frames],
                [error async for error in failures],
                pending.value.code,
                after.value.code,
                [emitted.value.code, transport.state.value],
            )

    states, frames, failures, pending, after, last = run(scenario())
    assert states[0] == "initial"
    assert states[-2:] == ["open", "closed"]
    assert (frames, failures) == ([], [])
    assert (pending, after) == ("bus.closed", "bus.closed")
    assert last == ["error", "closed"]


def test_a_transport_closed_before_it_was_opened_is_closed_and_cannot_be_opened() -> None:
    async def scenario() -> str:
        transport = HttpTransport("http://127.0.0.1:1", token=Variable[str | None](None), channels=CHANNELS)
        with pytest.raises(RuntimeError):
            await transport.emit("beckon:focus", {})
        await transport.close()
        await transport.close()
        with pytest.raises(RuntimeError):
            await transport.__aenter__()
        return transport.state.value

    assert run(scenario()) == "closed"


def test_closing_ends_an_emit_that_is_waiting_to_be_made_again() -> None:
    async def scenario() -> tuple[str, int | None, int, float]:
        patient = Timing(reconnect_ms=10, emit_retry=RetryPolicy(attempts=5, initial_delay_ms=1, max_delay_ms=1))
        async with GatewayServer() as gateway:
            gateway.scripted[("POST", "/bus/emit")] = [
                Answer(status=429, headers={"Retry-After": "600"}, body=b'{"error":"not now","code":"emit-rate"}')
            ]
            started = asyncio.get_running_loop().time()
            async with HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS, timing=patient) as transport:
                await opened(transport)
                failures = transport.failures()
                emitting = asyncio.ensure_future(transport.emit("beckon:focus", {}))
                await soon(gateway.arrived("POST", "/bus/emit"))
                await asyncio.sleep(0.01)
            with pytest.raises(TransportError) as raised:
                await soon(emitting)
            reported = [error async for error in failures]
            assert reported == [raised.value]
            return raised.value.code, raised.value.retry_after_ms, len(gateway.emits), asyncio.get_running_loop().time() - started

    code, stated_wait, attempts, took = run(scenario())
    assert (code, stated_wait, attempts) == ("rate-limited", 600_000, 1)
    assert took < 5


def test_a_stream_that_cannot_open_is_tried_again_and_a_token_that_changes_reaches_the_next_request() -> None:
    async def scenario() -> tuple[list[str], list[str]]:
        token: Variable[str | None] = Variable("first")
        async with GatewayServer() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [Answer(status=503, body=b"") for _ in range(3)]
            async with HttpTransport(gateway.origin, token=token, channels=CHANNELS, timing=QUICK) as transport:
                failures = transport.failures()
                await soon(reached(transport.state, lambda state: state == "reconnecting"))
                refused = await soon(anext(failures))
                await opened(transport)
                token.set("second")
                await soon(transport.emit("beckon:focus", {}))
            return [refused.code, str(refused.status)], sorted({asked.headers["authorization"] for asked in gateway.asked})

    assert run(scenario()) == (["unavailable", "503"], ["Bearer first", "Bearer second"])
