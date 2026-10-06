"""A knowledge base's bus over its gateway's HTTP transport (`docs/protocol/TRANSPORT-HTTP.md`), as a `semiont.transport.Transport`.

One stream, `POST /bus/subscribe`, naming the client's global channels and an
entry per resource scope it holds; and `POST /bus/emit` for what it sends. The
stream is `semiont.http.stream`'s. The gateway's own operations ride plain
request and response, and so does content (`HttpTransport.content`).

What crosses the wire is told to OpenTelemetry as the telemetry table says:
each emit is counted and sent in a span whose trace travels with it, and each
frame's arrival is marked in the trace the frame was sent under.
"""

import asyncio
import uuid
from collections.abc import Collection, Mapping, Sequence
from types import TracebackType
from typing import Final, Self, final, override

import httpx
from pydantic import JsonValue, ValidationError

from semiont import telemetry
from semiont.channels import BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS
from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast, Events
from semiont.http.content import HttpContentTransport
from semiont.http.exchange import Exchange
from semiont.http.stream import Stream, Timing
from semiont.identifiers import ResourceId
from semiont.retry import BOOT, RetryFacts, retry_after_ms, retry_with_backoff
from semiont.timing import EMIT_TIMEOUT_MS
from semiont.transport import (
    ConnectionState,
    ContentTransport,
    Frame,
    FrameHub,
    GatewayOperations,
    PendingReply,
    ReplyRouter,
    ResourceHold,
    Transport,
    unsubscribed,
)
from semiont.types import (
    BusEmitAccepted,
    BusEmitRequest,
    HealthResponse,
    MediaTokenRequest,
    MediaTokenResponse,
    ProtectedResourceMetadata,
    StatusResponse,
    UserResponse,
)
from semiont.watched import Watched

__all__ = ["HttpTransport"]


def _worth_another_emit(error: SemiontError) -> bool:
    """Whether an emit that failed this way is made again: nothing answered, or the gateway said "not now"."""
    return error.status is None or BOOT.retryable(RetryFacts(status=error.status, method="POST"))


@final
class HttpTransport(Transport, GatewayOperations):
    """A transport to one gateway. Held with `async with`: its stream opens inside, once there is a token, and ends on the way out.

    `token` is the token every request carries: the present one, and each one
    after it. With none the transport sends nothing and waits for one.
    `channels` are the global channels its stream names: every channel a
    client hears, unless a process that awaits only some operations names
    their reply channels and no others.
    """

    def __init__(
        self,
        base_url: str,
        *,
        token: Watched[str | None],
        channels: Sequence[str] = BRIDGED_CHANNELS,
        timing: Timing | None = None,
    ) -> None:
        self._base_url: Final = base_url.rstrip("/")
        self._token: Final = token
        self._global: Final = tuple(channels)
        self._timing: Final = Timing() if timing is None else timing
        # This client's address for correlated replies: one per transport, not
        # per connection, so both streams of a handoff present the same one.
        self._client_id: Final = str(uuid.uuid4())
        self._hub: Final = FrameHub()
        self._router: Final = ReplyRouter()
        self._failures: Final[Broadcast[SemiontError]] = Broadcast()
        # It reads no environment variable: no proxy and no certificate file it was not given.
        self._http: Final = httpx.AsyncClient(timeout=None, trust_env=False)
        self._stream: Final = Stream(
            base_url=self._base_url,
            http=self._http,
            token=token,
            client_id=self._client_id,
            channels=self._global,
            timing=self._timing,
            hub=self._hub,
            router=self._router,
            failures=self._failures,
        )
        self._closing: Final = asyncio.Event()
        self._exchange: Final = Exchange(
            base_url=self._base_url,
            http=self._http,
            token=token,
            failures=self._failures,
            deadline_ms=self._timing.http_request_ms,
            closing=self._closing,
        )
        self._content: Final = HttpContentTransport(self._exchange)
        self._holds: Final[dict[ResourceId, int]] = {}
        """How many holds each resource's scope has."""
        self._running: asyncio.Task[None] | None = None
        self._closed: Final = asyncio.Event()
        self._emitting = 0
        self._quiet: Final = asyncio.Event()
        """Set while no emit of this transport is under way."""
        self._quiet.set()

    async def __aenter__(self) -> Self:
        if self._running is not None or self._closing.is_set():
            raise RuntimeError("a transport is opened once")
        self._running = asyncio.create_task(self._run())
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.close()

    async def _run(self) -> None:
        """The transport's life: its stream, until it is closed; then the emits under way, each to its end."""
        try:
            await self._stream.run()
            await self._quiet.wait()
        finally:
            # A failure is reported for as long as an emit can fail: to the end.
            self._failures.close()
            try:
                # Whatever else is on the wire ends here, as a request that got no answer.
                await self._http.aclose()
                await self._exchange.ended()
            finally:
                self._closed.set()

    @property
    @override
    def base_url(self) -> str:
        return self._base_url

    @property
    @override
    def state(self) -> Watched[ConnectionState]:
        return self._stream.state

    @property
    def content(self) -> ContentTransport:
        """Bytes, and a resource's description, from the same gateway."""
        return self._content

    @override
    def failures(self) -> Events[SemiontError]:
        return self._failures.listen()

    @override
    def is_subscribed(self, channel: str) -> bool:
        return channel in self._global

    @override
    def frames(self, channel: str) -> Events[Frame]:
        # A channel this stream can never carry would be a reader that is
        # never given anything, which reads as a quiet system: refused at the
        # call. A resource-scoped channel passes with no scope held yet, since
        # frames flow the moment one is.
        if not self.is_subscribed(channel) and channel not in RESOURCE_SCOPED_CHANNELS:
            raise unsubscribed(channel)
        return self._hub.frames(channel)

    @override
    def track_reply(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        return self._router.track(correlation_id, reply_channels)

    @override
    def subscribe_to_resource(self, resource_id: ResourceId) -> ResourceHold:
        held = self._holds.get(resource_id, 0)
        self._holds[resource_id] = held + 1
        if held == 0:
            self._stream.take_scope(resource_id)

        def release() -> None:
            remaining = self._holds[resource_id] - 1
            if remaining > 0:
                self._holds[resource_id] = remaining
                return
            del self._holds[resource_id]
            self._stream.let_go_of_scope(resource_id)

        return ResourceHold(release)

    @override
    async def emit(
        self,
        channel: str,
        payload: Mapping[str, JsonValue],
        *,
        scope: ResourceId | None = None,
        correlation_id: str | None = None,
    ) -> int | None:
        if self._running is None:
            raise RuntimeError("the transport is not open: hold it with `async with`")
        body = BusEmitRequest(
            channel=channel,
            payload=dict(payload),
            scope=scope,
            client_id=self._client_id,
            correlation_id=correlation_id,
        ).model_dump_json(exclude_none=True)
        self._emitting += 1
        self._quiet.clear()
        try:
            with telemetry.emitting(channel, scope):
                return await retry_with_backoff(
                    self._timing.emit_retry,
                    lambda: self._emit_once(body),
                    retryable=_worth_another_emit,
                    give_up=self._closing,
                )
        except TransportError as error:
            # A failed emit is reported where every failure is, as its caller hears it.
            self._failures.deliver(error)
            raise
        finally:
            self._emitting -= 1
            if self._emitting == 0:
                self._quiet.set()

    async def _emit_once(self, body: str) -> int | None:
        """One attempt of an emit: `POST /bus/emit`, answered within `EMIT_TIMEOUT_MS`."""
        if self._closing.is_set():
            raise TransportError("error", "/bus/emit was not sent: the transport is closed")
        try:
            async with asyncio.timeout(EMIT_TIMEOUT_MS / 1000):
                response = await self._http.post(
                    f"{self._base_url}/bus/emit",
                    content=body,
                    headers={
                        **telemetry.trace_headers(),
                        "Authorization": f"Bearer {self._token.value or ''}",
                        "Content-Type": "application/json",
                    },
                )
        except TimeoutError:
            raise TransportError.without_response(f"/bus/emit got no answer within {EMIT_TIMEOUT_MS // 1000}s") from None
        except httpx.HTTPError as error:
            raise TransportError.without_response(f"/bus/emit got no answer: {error!r}") from error
        if not response.is_success:
            status = response.status_code
            detail = response.text[:500]
            raise TransportError.of_status(
                f"/bus/emit {status}: {detail}" if detail else f"/bus/emit {status}",
                status,
                retry_after_ms(response.headers.get("retry-after")),
            )
        # No count is reported as no count, never as a zero: an absent
        # `subscribers` is the gateway saying it could not count, and a body
        # that is not the declared one says nothing at all.
        try:
            return BusEmitAccepted.model_validate_json(response.content).subscribers
        except ValidationError:
            return None

    @override
    async def get_current_user(self) -> UserResponse:
        return await self._exchange.answer(UserResponse, "GET", "/api/users/me")

    @override
    async def get_media_token(self, resource_id: ResourceId) -> MediaTokenResponse:
        return await self._exchange.answer(
            MediaTokenResponse,
            "POST",
            "/api/tokens/media",
            headers={"Content-Type": "application/json"},
            content=MediaTokenRequest(resource_id=resource_id).model_dump_json().encode(),
        )

    @override
    async def get_protected_resource_metadata(self) -> ProtectedResourceMetadata:
        return await self._exchange.answer(ProtectedResourceMetadata, "GET", "/.well-known/oauth-protected-resource", authenticated=False)

    @override
    async def health_check(self) -> HealthResponse:
        return await self._exchange.answer(HealthResponse, "GET", "/api/health")

    @override
    async def get_status(self) -> StatusResponse:
        return await self._exchange.answer(StatusResponse, "GET", "/api/status")

    @override
    async def close(self) -> None:
        if not self._closing.is_set():
            self._closing.set()
            self._stream.stop()
            if self._running is None:
                # Never opened: its stream's task runs only to end.
                self._running = asyncio.create_task(self._run())
        await self._closed.wait()
        if self._running is not None:
            # Whatever ended the stream's task that was not its closing is raised here.
            await self._running
