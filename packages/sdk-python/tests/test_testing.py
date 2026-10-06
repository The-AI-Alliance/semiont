"""`semiont.testing`: the doubles a consumer's tests are built on, each held to what it says it does.

A double answers what a test told it to and refuses the rest by name. It
never answers with a value of its own making.
"""

import asyncio
from collections.abc import Mapping
from typing import final, override

import pytest
from aio import pass_time, run, soon, turns
from pydantic import JsonValue
from spec import JsonObject

from semiont.bus import request
from semiont.cache import Pending, Ready
from semiont.channels import BECKON_FOCUS
from semiont.client import CachePersistence, ClientTiming, SemiontClient
from semiont.errors import BusRequestError, SemiontError, TransportError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.operations import BROWSE_RESOURCE_REQUESTED, MARK_DELETE
from semiont.storage import MemoryStorage
from semiont.testing import (
    Delay,
    Deliver,
    DropReply,
    DuplicateReply,
    FaultyTransport,
    GetBinary,
    GetBinaryStream,
    GetResourceGraph,
    InMemoryContent,
    PutBinary,
    RejectEmit,
    RequestLogEntry,
    StubGateway,
    TestClient,
    create_test_client,
    retry_key_of,
)
from semiont.transport import Content, ContentTransport, Frame, FrameSink, GatewayOperations, PutBinaryRequest, Transport
from semiont.types import GetResourceResponse, HealthResponse, MediaTokenResponse, StatusResponse, UserResponse

RESOURCE, OTHER = ResourceId("res-1"), ResourceId("res-2")
ASKED: JsonObject = {"resourceId": "res-1"}
ASK = "browse:resource-requested"
DESCRIBED: JsonObject = {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []}


@final
class Carried(FrameSink):
    """What a transport carried, as it carried it."""

    def __init__(self) -> None:
        self.channels: list[str] = []

    @override
    def deliver(self, frame: Frame) -> None:
        self.channels.append(frame.channel)


async def asked(transport: Transport, payload: JsonObject | None = None, timeout_ms: int = 5000) -> JsonValue:
    """What a request for a resource is answered with: its `response`."""
    answer = await soon(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED if payload is None else payload, timeout_ms=timeout_ms))
    return answer.get("response")


# ── The transport ───────────────────────────────────────────────────────


def test_the_doubles_are_what_a_client_is_built_over() -> None:
    # Each is the protocol it stands in for: a checker refuses these lines for one that is not.
    transport: Transport = FaultyTransport()
    content: ContentTransport = InMemoryContent()
    gateway: GatewayOperations = StubGateway()
    assert transport.base_url == "faulty://simulator"
    assert isinstance(content, InMemoryContent)
    assert isinstance(gateway, StubGateway)


def test_a_request_is_answered_with_what_was_queued_for_its_operation_one_each_in_order() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        transport.queue_reply(ASK, [{"n": 1}, None])
        transport.queue_reply(ASK, [{"n": 3}])
        transport.queue_reply("mark:delete", [{"annotationId": "ann-1"}])
        assert await asked(transport) == {"n": 1}
        # A reply that carries no response.
        assert await soon(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED)) == {}
        assert await asked(transport) == {"n": 3}
        assert (await soon(request(transport, MARK_DELETE, {"annotationId": "ann-1"}))) == {"response": {"annotationId": "ann-1"}}
        assert transport.pending_replies == []
        await transport.close()

    run(scenario())


def test_a_request_nothing_was_scripted_for_is_refused_by_name_and_is_still_on_record() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        with pytest.raises(TransportError) as refused:
            await asked(transport)
        assert refused.value.code == "error"
        assert str(refused.value) == (
            'No response scripted for bus operation "browse:resource-requested". '
            'Script one with queue_reply("browse:resource-requested", ...) or build the transport with a make_response that answers it.'
        )
        # It was sent: what a caller sent is judged whether or not anything answered.
        assert [(frame.channel, frame.payload) for frame in transport.emitted] == [(ASK, ASKED)]
        assert [entry.channel for entry in transport.request_log] == [ASK]
        assert transport.pending_replies == []
        await transport.close()

    run(scenario())


def test_what_no_queued_response_answers_the_transports_own_gateway_does() -> None:
    async def scenario() -> None:
        said: list[tuple[str, Mapping[str, JsonValue]]] = []

        def gateway(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
            said.append((operation, payload))
            return None if operation == "mark:delete" else {"for": operation}

        transport = FaultyTransport(make_response=gateway)
        transport.queue_reply(ASK, [{"queued": True}])
        assert await asked(transport) == {"queued": True}
        assert await asked(transport) == {"for": ASK}
        assert await soon(request(transport, MARK_DELETE, {"annotationId": "ann-1"})) == {}
        # Asked only for what nothing was queued for.
        assert said == [(ASK, ASKED), ("mark:delete", {"annotationId": "ann-1"})]
        await transport.close()

    run(scenario())


def test_each_request_in_turn_meets_the_next_action_of_the_schedule_and_the_schedule_comes_round_again() -> None:
    async def scenario() -> None:
        transport = FaultyTransport([Deliver(), DropReply(), Delay(200), DuplicateReply(), RejectEmit()])
        transport.queue_reply(ASK, [{"n": n} for n in range(1, 6)])

        # Its reply is delivered.
        assert await asked(transport) == {"n": 1}

        # Its reply is lost: the gateway answered, and the wire ate it.
        with pytest.raises(BusRequestError) as lost:
            await asked(transport, timeout_ms=30)
        assert lost.value.code == "bus.timeout"

        # Its reply is delivered after that long, and not before.
        waiting = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        await pass_time(0.15, step=0.05)
        assert not waiting.done()
        await pass_time(0.1, step=0.05)
        assert (await soon(waiting)).get("response") == {"n": 3}

        # Its reply is delivered twice: the request resolves once, and the second reaches nobody.
        heard = transport.frames("browse:resource-result")
        assert await asked(transport) == {"n": 4}
        await turns()
        assert [(await soon(anext(heard))).payload, (await soon(anext(heard))).payload] == [{"response": {"n": 4}}] * 2
        assert transport.pending_replies == []

        # The emit itself is refused: the request never reaches the gateway, so nothing queued is spent.
        with pytest.raises(TransportError) as rejected:
            await asked(transport)
        assert (rejected.value.code, str(rejected.value)) == ("error", f"FaultyTransport: emit rejected by schedule on {ASK}")

        # And the schedule comes round again: delivered, with what the rejected request left queued.
        assert await asked(transport) == {"n": 5}
        assert [entry.action for entry in transport.request_log] == [
            Deliver(),
            DropReply(),
            Delay(200),
            DuplicateReply(),
            RejectEmit(),
            Deliver(),
        ]
        assert len(transport.emitted) == 6
        await transport.close()

    run(scenario())


def test_a_request_the_gateway_refuses_is_answered_on_its_failure_channel_before_anything_queued() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        transport.queue_reply(ASK, [{"n": 1}])
        transport.refuse_when(
            lambda operation, payload: (
                {"code": "not-found", "message": "no such resource"} if payload.get("resourceId") == "res-2" else None
            )
        )
        with pytest.raises(BusRequestError) as refused:
            await asked(transport, {"resourceId": "res-2"})
        assert (refused.value.code, str(refused.value)) == ("bus.not-found", "no such resource")
        assert refused.value.failure == {"code": "not-found", "message": "no such resource"}
        # What was queued is still there for the request the gateway does not refuse.
        assert await asked(transport) == {"n": 1}
        # The schedule applies to a refusal as to any reply.
        dropping = FaultyTransport([DropReply()])
        dropping.refuse_when(lambda operation, payload: {"code": "not-found", "message": "gone"})
        with pytest.raises(BusRequestError) as lost:
            await asked(dropping, timeout_ms=30)
        assert lost.value.code == "bus.timeout"
        await transport.close()
        await dropping.close()

    run(scenario())


def test_what_is_only_sent_is_delivered_to_whoever_listens_and_into_a_clients_bus() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        client = SemiontClient(transport, InMemoryContent(), StubGateway())
        heard = transport.frames("beckon:focus")
        on_the_bus = client.bus.frames(BECKON_FOCUS)
        # One subscriber reached: this transport delivers whatever is emitted through it.
        assert await transport.emit("beckon:focus", {"annotationId": "ann-1"}, scope=RESOURCE) == 1
        assert await soon(anext(heard)) == Frame(channel="beckon:focus", payload={"annotationId": "ann-1"}, scope=RESOURCE)
        assert (await soon(anext(on_the_bus))).payload.annotation_id == "ann-1"
        # It is no request: the log does not hold it.
        assert transport.request_log == []
        assert [frame.channel for frame in transport.emitted] == ["beckon:focus"]

        # And the schedule does not count it: the first request meets the schedule's first action, whatever was sent before it.
        scheduled = FaultyTransport([Deliver(), RejectEmit()], make_response=lambda operation, payload: None)
        carried = Carried()
        scheduled.bridge_into(carried)
        await scheduled.emit("beckon:focus", {"annotationId": "ann-1"})
        assert await scheduled.emit(ASK, ASKED, correlation_id="cid-1") == 1
        # Its reply comes after the emit has been accepted, as a wire's does.
        assert carried.channels == ["beckon:focus", ASK]
        await turns()
        assert carried.channels == ["beckon:focus", ASK, "browse:resource-result"]
        await scheduled.close()

        # A request is delivered too, as the gateway gives a request to whoever answers it.
        transport.queue_reply(ASK, [None])
        requests = transport.frames(ASK)
        await asked(transport)
        assert (await soon(anext(requests))).payload == ASKED
        await client.close()
        await transport.close()

    run(scenario())


def test_the_log_holds_each_request_as_it_was_sent_and_a_request_made_again_under_one_key() -> None:
    async def scenario() -> None:
        transport = FaultyTransport(make_response=lambda operation, payload: None)
        payload: JsonObject = {"resourceId": "res-1", "_trace": "t-1", "_userId": "did:web:example.org:users:alice"}
        await soon(request(transport, BROWSE_RESOURCE_REQUESTED, payload))
        # Changed by its caller afterwards, what was sent is still what was sent.
        payload["resourceId"] = "res-9"
        await soon(request(transport, BROWSE_RESOURCE_REQUESTED, {"_trace": "t-2", "resourceId": "res-1"}))
        await soon(request(transport, BROWSE_RESOURCE_REQUESTED, {"resourceId": "res-2"}))
        first, again, other = transport.request_log
        assert isinstance(first, RequestLogEntry)
        assert (first.channel, first.action, first.payload["resourceId"]) == (ASK, Deliver(), "res-1")
        assert first.correlation_id is not None
        assert first.correlation_id != again.correlation_id
        # One logical request, sent again: what the gateway stamps on a payload is no part of what was asked.
        assert first.retry_key == again.retry_key == retry_key_of(ASK, {"resourceId": "res-1"})
        assert other.retry_key != first.retry_key
        assert retry_key_of("mark:delete", {"resourceId": "res-1"}) != first.retry_key
        assert retry_key_of(ASK, {"b": 1, "a": 2}) == retry_key_of(ASK, {"a": 2, "b": 1})
        await transport.close()

    run(scenario())


def test_a_test_says_what_the_wire_does_its_state_its_failures_and_what_it_carries() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        assert transport.state.value == "open"
        states = aiter(transport.state)
        assert await soon(anext(states)) == "open"
        transport.set_state("reconnecting")
        assert await soon(anext(states)) == "reconnecting"

        failures = transport.failures()
        failure = TransportError.of_status("refused", 403, None)
        transport.fail(failure)
        assert await soon(anext(failures)) is failure

        # A frame delivered as if the bus had carried it reaches the request that awaits it.
        dropping = FaultyTransport([DropReply()], make_response=lambda operation, payload: None)
        asking = asyncio.ensure_future(request(dropping, BROWSE_RESOURCE_REQUESTED, ASKED))
        await turns()
        (correlation_id,) = dropping.pending_replies
        assert correlation_id == dropping.request_log[0].correlation_id
        dropping.deliver(Frame(channel="browse:resource-result", payload={"response": DESCRIBED}, correlation_id=correlation_id))
        assert (await soon(asking)).get("response") == DESCRIBED
        assert dropping.pending_replies == []
        await transport.close()
        await dropping.close()

    run(scenario())


def test_the_holds_on_each_resources_scope_are_counted() -> None:
    transport = FaultyTransport()
    assert (transport.holds(RESOURCE), transport.scopes) == (0, [])
    # In name order, whatever order they were taken in.
    other, one, two = (
        transport.subscribe_to_resource(OTHER),
        transport.subscribe_to_resource(RESOURCE),
        transport.subscribe_to_resource(RESOURCE),
    )
    assert (transport.holds(RESOURCE), transport.holds(OTHER), transport.scopes) == (2, 1, [RESOURCE, OTHER])
    one.release()
    one.release()
    assert (transport.holds(RESOURCE), transport.scopes) == (1, [RESOURCE, OTHER])
    two.release()
    other.release()
    assert (transport.holds(RESOURCE), transport.holds(OTHER), transport.scopes) == (0, 0, [])


def test_a_transport_told_its_channels_delivers_no_other_and_one_told_none_delivers_every_one() -> None:
    async def scenario() -> None:
        every = FaultyTransport()
        assert every.is_subscribed("browse:resource-result")
        assert every.is_subscribed("a channel nobody registered")

        some = FaultyTransport(channels=["mark:delete-ok", "mark:delete-failed"])
        assert some.is_subscribed("mark:delete-ok")
        assert not some.is_subscribed("browse:resource-result")
        with pytest.raises(BusRequestError) as unheard:
            some.frames("browse:resource-result")
        assert unheard.value.code == "bus.unsubscribed"
        # A request whose reply could never arrive is refused before it is sent.
        with pytest.raises(BusRequestError) as unsubscribed:
            await asked(some)
        assert unsubscribed.value.code == "bus.unsubscribed"
        assert some.emitted == []
        await every.close()
        await some.close()

    run(scenario())


def test_a_closed_transport_has_ended_everything_and_does_nothing_more() -> None:
    async def scenario() -> None:
        transport = FaultyTransport([Delay(100), DropReply()])
        transport.queue_reply(ASK, [{"n": 1}, {"n": 2}])
        heard = transport.frames("browse:resource-result")
        failures = transport.failures()
        states = aiter(transport.state)
        assert await soon(anext(states)) == "open"
        delayed = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        unanswered = asyncio.ensure_future(request(transport, BROWSE_RESOURCE_REQUESTED, ASKED))
        await turns()
        assert len(transport.emitted) == 2

        await transport.close()
        await transport.close()
        assert transport.state.value == "closed"
        # Its state is closed and will be nothing else; every reader's events end; every request still pending fails as closed.
        assert await soon(anext(states)) == "closed"
        assert await soon(anext(states, None)) is None
        assert await soon(anext(heard, None)) is None
        assert await soon(anext(failures, None)) is None
        for pending in (delayed, unanswered):
            with pytest.raises(BusRequestError) as closed:
                await soon(pending)
            assert closed.value.code == "bus.closed"

        # Nothing is sent, delivered, failed or changed after: the reply that was on its way never comes.
        assert await transport.emit("beckon:focus", {"annotationId": "ann-1"}) is None
        assert len(transport.emitted) == 2
        transport.deliver(Frame(channel="beckon:focus", payload={}))
        transport.fail(TransportError("error", "after the end"))
        transport.set_state("open")
        await pass_time(0.2, step=0.05)
        assert transport.state.value == "closed"
        assert await soon(anext(transport.frames("beckon:focus"), None)) is None
        assert await soon(anext(transport.failures(), None)) is None

    run(scenario())


# ── Content ─────────────────────────────────────────────────────────────


def test_content_in_memory_keeps_what_it_is_given_gives_it_back_and_refuses_what_nobody_stored() -> None:
    async def scenario() -> None:
        content = InMemoryContent()
        # Nothing stored: refused as a gateway refuses, naming the resource, with no bytes of the double's making.
        for read, what in (
            (content.get_binary(RESOURCE), "content"),
            (content.get_binary_stream(RESOURCE), "content"),
            (content.get_resource_graph(RESOURCE), "description"),
        ):
            with pytest.raises(TransportError) as missing:
                await read
            assert (missing.value.code, missing.value.status) == ("not-found", 404)
            assert str(missing.value) == f"InMemoryContent: no {what} stored for res-1"

        page = Content(data=b"# A page", content_type="text/markdown")
        content.seed(RESOURCE, page)
        graph = GetResourceResponse.model_validate({"resource": DESCRIBED, "annotations": [], "entityReferences": []})
        content.seed_graph(RESOURCE, graph)
        assert await content.get_binary(RESOURCE) == page
        async with await content.get_binary_stream(RESOURCE) as arriving:
            assert arriving.content_type == "text/markdown"
            assert [piece async for piece in arriving] == [b"# A page"]
        assert await content.get_resource_graph(RESOURCE) is graph
        with pytest.raises(TransportError):
            await content.get_binary(OTHER)

        # An upload is kept under an id of the double's making, and reports that all of it was sent.
        put = PutBinaryRequest(name="Notes", file=b"some notes", format="text/plain", storage_uri="file://notes.txt")
        upload = content.put_binary(put)
        reports = [progress async for progress in upload]
        created = await upload
        assert created.resource_id == "test-content-2"
        assert [(progress.bytes_uploaded, progress.total_bytes) for progress in reports] == [(10, 10)]
        assert await content.get_binary(created.resource_id) == Content(data=b"some notes", content_type="text/plain")
        assert (await content.put_binary(put)).resource_id == "test-content-3"

        # Every call, in order, answered or not.
        assert content.calls == [
            GetBinary(RESOURCE),
            GetBinaryStream(RESOURCE),
            GetResourceGraph(RESOURCE),
            GetBinary(RESOURCE),
            GetBinaryStream(RESOURCE),
            GetResourceGraph(RESOURCE),
            GetBinary(OTHER),
            PutBinary(put),
            GetBinary(ResourceId("test-content-2")),
            PutBinary(put),
        ]

    run(scenario())


# ── The gateway's own operations ────────────────────────────────────────


def test_a_stub_gateway_answers_only_what_it_was_told_to_and_records_every_call() -> None:
    async def scenario() -> None:
        gateway = StubGateway()
        for unscripted, name in (
            (gateway.get_current_user(), "get_current_user"),
            (gateway.get_media_token(RESOURCE), "get_media_token"),
            (gateway.get_protected_resource_metadata(), "get_protected_resource_metadata"),
            (gateway.health_check(), "health_check"),
            (gateway.get_status(), "get_status"),
        ):
            with pytest.raises(TransportError) as refused:
                await unscripted
            assert (refused.value.code, str(refused.value)) == ("error", f"StubGateway: not scripted: {name}")

        alice = UserResponse.model_validate(
            {
                "did": "did:web:example.org:users:alice",
                "email": "alice@example.org",
                "name": "Alice",
                "image": None,
                "domain": "example.org",
            }
        )
        status = StatusResponse.model_validate(
            {"status": "ok", "version": "0.0.0", "features": {"semanticContent": "on", "collaboration": "on"}, "message": "serving"}
        )
        health = HealthResponse.model_validate(
            {"status": "ok", "message": "serving", "version": "0.0.0", "timestamp": "2026-10-06T00:00:00.000Z"}
        )
        gateway.current_user(alice)
        gateway.status(status)
        gateway.health(health)
        assert await gateway.get_current_user() is alice
        assert await gateway.get_status() is status
        assert await gateway.health_check() is health
        # One answer does not answer another operation.
        with pytest.raises(TransportError):
            await gateway.get_media_token(OTHER)
        assert gateway.calls == [
            "get_current_user",
            "get_media_token res-1",
            "get_protected_resource_metadata",
            "health_check",
            "get_status",
            "get_current_user",
            "get_status",
            "health_check",
            "get_media_token res-2",
        ]

    run(scenario())


def test_a_stub_gateway_gives_each_scripted_answer_to_its_own_operation() -> None:
    async def scenario() -> None:
        gateway = StubGateway()
        media = MediaTokenResponse.model_validate({"token": "media-token"})
        gateway.media_token(media)
        assert await gateway.get_media_token(RESOURCE) is media
        with pytest.raises(TransportError):
            await gateway.get_protected_resource_metadata()

    run(scenario())


# ── A client over them ──────────────────────────────────────────────────


def test_a_test_client_is_a_real_client_over_the_doubles_it_is_given_or_makes() -> None:
    async def scenario() -> None:
        made = create_test_client()
        assert isinstance(made.client, SemiontClient)
        assert made.client.transport is made.transport
        assert made.client.timing == ClientTiming()
        # What a test runner reads to know this is no class of tests, whatever its name begins with.
        assert TestClient.__test__ is False

        # What nobody scripted is refused by name, whichever double it reaches.
        for unscripted, message in (
            (made.client.browse.resource(RESOURCE).fresh(), 'No response scripted for bus operation "browse:resource-requested"'),
            (made.client.browse.resource_content(RESOURCE), "InMemoryContent: no content stored for res-1"),
            (made.client.system.status(), "StubGateway: not scripted: get_status"),
        ):
            with pytest.raises(SemiontError, match=message):
                await soon(unscripted)

        # Scripted, the client's own namespaces, cache and deadlines do the rest.
        made.transport.queue_reply(ASK, [{"resource": DESCRIBED, "annotations": [], "entityReferences": []}])
        made.content.seed(RESOURCE, Content(data=b"text", content_type="text/plain"))
        async with made.client as client, client.browse.resource(RESOURCE) as live:
            assert await soon(anext(live)) == Pending()
            shown = await soon(anext(live))
            assert isinstance(shown, Ready)
            assert shown.value.name == "A resource"
            assert await client.browse.resource_content(RESOURCE) == "text"
            assert made.transport.holds(RESOURCE) == 1
        await made.transport.close()

        # Given its doubles and its timing, it is built over those.
        transport, content, gateway = (
            FaultyTransport([DropReply()], make_response=lambda operation, payload: None),
            InMemoryContent(),
            StubGateway(),
        )
        given = create_test_client(transport=transport, content=content, gateway=gateway, timing=ClientTiming(bus_request_ms=30))
        assert (given.transport, given.content, given.gateway) == (transport, content, gateway)
        with pytest.raises(BusRequestError) as late:
            await soon(given.client.mark.delete(RESOURCE, AnnotationId("ann-1")))
        assert late.value.code == "bus.timeout"
        await given.client.close()
        await transport.close()

        # And its persistence: what the client's small queries hold is kept where the test says.
        storage = MemoryStorage()
        keeping = create_test_client(persistence=CachePersistence(storage=storage, key_prefix="kb"))
        keeping.transport.queue_reply(ASK, [{"resource": DESCRIBED, "annotations": [], "entityReferences": []}])
        async with keeping.client as client:
            await soon(client.browse.resource(RESOURCE).fresh())
        assert storage.get("semiont.cache.kb.resource") is not None
        await keeping.transport.close()

    run(scenario())
