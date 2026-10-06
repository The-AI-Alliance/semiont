"""What a transport does when the gateway refuses its token (`401`), with a refresher and without one.

The stream asks its refresher once per outage, and opens again at once with
what it is given. A request asks once, and is made a second time with what it
is given, whatever its method: it was refused, not processed. An upload sent
twice reports its progress once.
"""

import asyncio
from typing import final

import pytest
from aio import run, settle, soon
from spec import JsonObject
from stub_gateway import Answer, StubGateway

from semiont.errors import SignInError, TransportError
from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.retry import RetryPolicy
from semiont.transport import PutBinaryRequest, UploadProgress
from semiont.watched import Variable, reached

QUICK = Timing(reconnect_ms=20, lazy_remove_ms=10, linger_ms=10, emit_retry=RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1))
REFUSED = Answer(status=401, body=b'{"error":"The token is not one this gateway admits"}')
STATUS: JsonObject = {
    "status": "operational",
    "version": "1.0.0",
    "features": {"semanticContent": "ready", "collaboration": "ready"},
    "message": "All is well",
}


@final
class Source:
    """A token, and what renews it: each renewal gives the next of `renewals`, or nothing once they are spent."""

    def __init__(self, first: str | None, *renewals: str | SignInError | None) -> None:
        self.token = Variable[str | None](first)
        self.renewals = list(renewals)
        self.asked = 0

    async def refresh(self) -> str | None:
        self.asked += 1
        renewal = self.renewals.pop(0) if self.renewals else None
        if isinstance(renewal, SignInError):
            raise renewal
        if renewal is not None:
            # Whoever renews a transport's token also feeds it.
            self.token.set(renewal)
        return renewal


def sent_with(gateway: StubGateway, method: str, path: str) -> list[str | None]:
    """The credential each request of a method and path carried."""
    return [asked.headers.get("authorization") for asked in gateway.of(method, path)]


async def state_is(transport: HttpTransport, wanted: str) -> None:
    await soon(reached(transport.state, lambda state: state == wanted))


# ── The stream ──────────────────────────────────────────────────────────


def test_a_stream_refused_asks_its_refresher_and_opens_at_once_with_what_it_is_given() -> None:
    source = Source("stale", "fresh")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
            # A reconnect that waited out its backoff would not have opened by the time this test ends.
            slow = Timing(reconnect_ms=60_000)
            async with HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, timing=slow) as transport:
                failures = transport.failures()
                await state_is(transport, "open")
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer stale", "Bearer fresh"]
                assert source.asked == 1
                # A refused connect is a request the gateway refused, and is reported as one.
                refusal = await soon(anext(failures))
                assert (refusal.code, refusal.status) == ("unauthorized", 401)

    run(scenario())


@pytest.mark.parametrize(
    "gives", [None, "stale", SignInError("exchange", "the issuer is away")], ids=["nothing", "the token refused", "a failure"]
)
def test_a_stream_whose_refresher_gives_no_other_token_waits_for_one_and_asks_once_per_outage(gives: str | SignInError | None) -> None:
    source = Source("stale", gives)

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
            async with HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, timing=QUICK) as transport:
                await state_is(transport, "unauthenticated")
                # Many of its retries pass: the token the gateway refused is not sent again, and nobody is asked again.
                await asyncio.sleep(0.3)
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer stale"]
                assert source.asked == 1
                assert transport.state.value == "unauthenticated"

                source.token.set("another")
                await state_is(transport, "open")
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer stale", "Bearer another"]
                assert source.asked == 1

    run(scenario())


def test_a_stream_whose_renewed_token_is_refused_too_asks_for_no_third() -> None:
    # An issuer that goes on issuing what the gateway goes on refusing is asked once, not without end.
    source = Source("first", "second", "third")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED, REFUSED]
            async with HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, timing=QUICK) as transport:
                await soon(gateway.arrived("POST", "/bus/subscribe", 2))
                await asyncio.sleep(0.2)
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer first", "Bearer second"]
                assert source.asked == 1
                assert transport.state.value == "unauthenticated"

                source.token.set("another")
                await state_is(transport, "open")
                assert source.asked == 1

    run(scenario())


def test_a_stream_refused_again_after_it_opened_asks_its_refresher_again() -> None:
    source = Source("first", "second", "third")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
            async with HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, timing=QUICK) as transport:
                await state_is(transport, "open")
                assert source.asked == 1

                # The stream drops, and the gateway refuses the token it reconnects with: another outage.
                gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
                gateway.drop()
                await soon(gateway.arrived("POST", "/bus/subscribe", 4))
                await state_is(transport, "open")
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer first", "Bearer second", "Bearer second", "Bearer third"]
                assert source.asked == 2

    run(scenario())


def test_a_stream_with_no_refresher_waits_for_its_token_to_change() -> None:
    token = Variable[str | None]("stale")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/bus/subscribe")] = [REFUSED]
            async with HttpTransport(gateway.origin, token=token, timing=QUICK) as transport:
                await state_is(transport, "unauthenticated")
                await asyncio.sleep(0.1)
                assert sent_with(gateway, "POST", "/bus/subscribe") == ["Bearer stale"]
                token.set("fresh")
                await state_is(transport, "open")

    run(scenario())


# ── A request ───────────────────────────────────────────────────────────


def test_a_request_refused_is_made_once_more_with_the_token_its_refresher_gives() -> None:
    source = Source("stale", "fresh")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.answers["/api/status"] = STATUS
            gateway.scripted[("GET", "/api/status")] = [REFUSED]
            # No stream: only the request is refused here.
            transport = HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, channels=())
            try:
                failures = transport.failures()
                assert (await soon(transport.get_status())).version == "1.0.0"
                assert sent_with(gateway, "GET", "/api/status") == ["Bearer stale", "Bearer fresh"]
                assert source.asked == 1
                # A request that was answered in the end failed nobody.
                await settle()
                transport_failures = asyncio.ensure_future(anext(failures))
                await settle()
                assert not transport_failures.done()
                transport_failures.cancel()
                await asyncio.gather(transport_failures, return_exceptions=True)
            finally:
                await transport.close()

    run(scenario())


def test_a_request_that_may_have_an_effect_is_made_again_too_for_it_was_refused_and_not_processed() -> None:
    source = Source("stale", "fresh")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.answers["/api/tokens/media"] = {"token": "a-media-token"}
            gateway.scripted[("POST", "/api/tokens/media")] = [REFUSED]
            transport = HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, channels=())
            try:
                assert (await soon(transport.get_media_token(ResourceId("res-1")))).token == "a-media-token"
                asked = gateway.of("POST", "/api/tokens/media")
                assert [request.headers.get("authorization") for request in asked] == ["Bearer stale", "Bearer fresh"]
                assert asked[0].body == asked[1].body
            finally:
                await transport.close()

    run(scenario())


def test_a_request_refused_twice_is_refused_and_its_refresher_was_asked_once() -> None:
    source = Source("stale", "fresh", "fresher")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("GET", "/api/status")] = [REFUSED, REFUSED]
            transport = HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, channels=())
            try:
                with pytest.raises(TransportError) as refused:
                    await soon(transport.get_status())
                assert (refused.value.code, refused.value.status) == ("unauthorized", 401)
                assert refused.value.message == "The token is not one this gateway admits"
                assert sent_with(gateway, "GET", "/api/status") == ["Bearer stale", "Bearer fresh"]
                assert source.asked == 1
            finally:
                await transport.close()

    run(scenario())


@pytest.mark.parametrize("gives", [None, SignInError("exchange", "the issuer is away")], ids=["nothing", "a failure"])
def test_a_request_refused_with_nothing_to_renew_with_is_refused_at_once(gives: SignInError | None) -> None:
    async def scenario(transport_of: str) -> None:
        source = Source("stale", gives)
        async with StubGateway() as gateway:
            gateway.scripted[("GET", "/api/status")] = [REFUSED]
            gateway.answers["/api/status"] = STATUS
            refresher = source.refresh if transport_of == "a refresher that gives nothing" else None
            transport = HttpTransport(gateway.origin, token=source.token, refresher=refresher, channels=())
            try:
                with pytest.raises(TransportError) as refused:
                    await soon(transport.get_status())
                assert refused.value.code == "unauthorized"
                assert sent_with(gateway, "GET", "/api/status") == ["Bearer stale"]
                assert source.asked == (0 if refresher is None else 1)
            finally:
                await transport.close()

    run(scenario("a refresher that gives nothing"))
    run(scenario("no refresher"))


def test_a_request_that_sends_no_token_asks_nobody_to_renew_one() -> None:
    source = Source("stale", "fresh")

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("GET", "/.well-known/oauth-protected-resource")] = [REFUSED]
            transport = HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, channels=())
            try:
                with pytest.raises(TransportError):
                    await soon(transport.get_protected_resource_metadata())
                assert source.asked == 0
                assert sent_with(gateway, "GET", "/.well-known/oauth-protected-resource") == [None]
            finally:
                await transport.close()

    run(scenario())


# ── An upload ───────────────────────────────────────────────────────────


def test_an_upload_refused_is_sent_again_whole_and_its_progress_is_reported_once() -> None:
    source = Source("stale", "fresh")
    data = bytes(range(256)) * 1024  # Four pieces of the grain an upload is sent in.

    async def scenario() -> None:
        async with StubGateway() as gateway:
            gateway.scripted[("POST", "/resources")] = [REFUSED]
            transport = HttpTransport(gateway.origin, token=source.token, refresher=source.refresh, channels=())
            try:
                upload = transport.content.put_binary(
                    PutBinaryRequest(name="a.bin", file=data, format="application/octet-stream", storage_uri="file://a.bin")
                )
                reported: list[UploadProgress] = []

                async def watch() -> None:
                    async for progress in upload:
                        reported.append(progress)

                watching = asyncio.create_task(watch())
                created = await soon(upload)
                await soon(watching)

                sent = gateway.of("POST", "/resources")
                assert [request.headers.get("authorization") for request in sent] == ["Bearer stale", "Bearer fresh"]
                # The body was sent from its start both times.
                assert sent[0].body == sent[1].body
                assert sent[1].form()["file"][0] == data
                assert created.resource_id == "res-uploaded-2"
                # Progress never goes back, and ends at the body's length.
                uploaded = [progress.bytes_uploaded for progress in reported]
                assert uploaded == sorted(set(uploaded)), "a piece was reported twice"
                assert reported[-1].bytes_uploaded == reported[-1].total_bytes == len(sent[1].body)
                assert len(reported) >= 4
            finally:
                await transport.close()

    run(scenario())
