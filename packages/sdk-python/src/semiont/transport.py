"""The transport contract (`docs/protocol/TRANSPORT-CONTRACT.md`): what a client needs of whatever carries the bus.

A `Transport` is the bus over some carrier: an emit out, frames in, the
connection's state, the failures it met, the resource scopes it holds and the
replies it awaits. It carries names and JSON objects. What a channel's payload
is, as a type, is `semiont.channels`' to say, above this.

Beside the contract are the parts every transport builds it from: the frames
of each channel as their readers are given them (`FrameHub`), and the replies
its requests still await (`ReplyRouter`).
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Collection, Generator, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Literal, Protocol, Self, final

from pydantic import JsonValue

from semiont.errors import BusRequestError, SemiontError
from semiont.events import Broadcast, Events
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.types import (
    Agent,
    CreateResourceResponse,
    GetResourceResponse,
    HealthResponse,
    MediaTokenResponse,
    ProtectedResourceMetadata,
    StatusResponse,
    UserResponse,
)
from semiont.watched import Watched

__all__ = [
    "CONNECTION_STATES",
    "CONNECTION_STATE_MAY_BECOME",
    "ConnectionState",
    "Content",
    "ContentStream",
    "ContentTransport",
    "Frame",
    "FrameHub",
    "GatewayOperations",
    "PendingReply",
    "PutBinaryRequest",
    "ReplyRouter",
    "ResourceHold",
    "TraceContext",
    "Transport",
    "Upload",
    "UploadProgress",
    "unsubscribed",
]

type ConnectionState = Literal["initial", "connecting", "open", "reconnecting", "degraded", "unauthenticated", "closed"]
"""Whether the bus can deliver (`docs/protocol/TRANSPORT-HTTP.md` § Connection lifecycle).

- `initial`: before the transport has started its stream.
- `connecting`: a connect is in flight and no stream is live.
- `open`: a stream is live. It is left only when the stream drops: a transport
  that changes what its stream carries without missing anything stays open, so
  `open` reached again always means something may have been missed.
- `reconnecting`: the stream dropped, or a connect failed with none live.
- `degraded`: has been reconnecting for longer than `DEGRADED_THRESHOLD_MS`.
- `unauthenticated`: not attempting. There is no credential, or the one there
  is was refused. Ends when a different credential appears.
- `closed`: the transport was closed. Terminal.
"""

CONNECTION_STATES: Final[tuple[ConnectionState, ...]] = (
    "initial",
    "connecting",
    "open",
    "reconnecting",
    "degraded",
    "unauthenticated",
    "closed",
)

CONNECTION_STATE_MAY_BECOME: Final[Mapping[ConnectionState, frozenset[ConnectionState]]] = {
    "initial": frozenset({"connecting", "unauthenticated", "closed"}),
    "connecting": frozenset({"open", "reconnecting", "unauthenticated", "closed"}),
    "open": frozenset({"reconnecting", "closed"}),
    "reconnecting": frozenset({"connecting", "degraded", "unauthenticated", "closed"}),
    "degraded": frozenset({"connecting", "unauthenticated", "closed"}),
    "unauthenticated": frozenset({"connecting", "closed"}),
    "closed": frozenset(),
}
"""The states each state may be followed by."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TraceContext:
    """A W3C trace context, as the wire carries one."""

    traceparent: str
    tracestate: str | None = None


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Frame:
    """A frame as a transport delivers it: a payload, and what is beside it, never inside it."""

    channel: str
    payload: Mapping[str, JsonValue]
    correlation_id: str | None = None
    """What pairs a reply with its request."""
    scope: ResourceId | None = None
    """The resource whose scope the frame was delivered on."""
    trace: TraceContext | None = None
    """The trace the work done for this frame continues, when the frame was sent under one."""


def unsubscribed(channel: str) -> BusRequestError:
    """The refusal a transport gives for a channel it can never deliver."""
    return BusRequestError(
        "bus.unsubscribed",
        f"Transport is not subscribed to {channel}: a frame on it can never arrive on this connection. "
        "Add the channel to this client's channels.",
    )


@final
class FrameHub:
    """The frames of every channel anybody listens to, a broadcast per channel."""

    def __init__(self) -> None:
        self._channels: dict[str, Broadcast[Frame]] = {}
        self._closed = False

    def frames(self, channel: str) -> Events[Frame]:
        """The frames delivered on `channel` from now on. Of a closed hub, events that have ended."""
        broadcast = self._channels.get(channel)
        if broadcast is None:
            broadcast = Broadcast[Frame]()
            if self._closed:
                broadcast.close()
            else:
                self._channels[channel] = broadcast
        return broadcast.listen()

    def deliver(self, frame: Frame) -> int:
        """Give `frame` to its channel's readers. Returns how many there were."""
        broadcast = self._channels.get(frame.channel)
        return 0 if broadcast is None else broadcast.deliver(frame)

    def close(self) -> None:
        """End the frames of every reader, and of every later one."""
        self._closed = True
        for broadcast in self._channels.values():
            broadcast.close()
        self._channels.clear()


@final
class PendingReply:
    """A reply a request awaits. Held with `with`: leaving stops the wait.

    The transport then names the reply no more, and one that comes anyway
    reaches nobody. A task cancelled while it waits leaves the same way.
    """

    def __init__(self, reply: asyncio.Future[Frame | None], forget: Callable[[], None]) -> None:
        self._reply = reply
        self._forget = forget

    async def frame(self) -> Frame | None:
        """The reply. Nothing when the transport closed before one came."""
        return await self._reply

    def __enter__(self) -> Self:
        return self

    def __exit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._forget()


@final
@dataclass(frozen=True, slots=True)
class _Awaited:
    channels: frozenset[str]
    reply: asyncio.Future[Frame | None]


@final
class ReplyRouter:
    """The replies a transport's requests still await.

    A reply is handed, by its correlation id, to the one request that awaits
    it, so no amount of other traffic can cost a request its reply. And the ids
    here are what a wire transport names when it opens a stream, so a reply
    published while the stream was down is sent again.
    """

    def __init__(self) -> None:
        self._awaited: dict[str, _Awaited] = {}
        self._closed = False

    def track(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        """Await the reply to `correlation_id` on one of `reply_channels`."""
        reply: asyncio.Future[Frame | None] = asyncio.get_running_loop().create_future()
        if self._closed:
            reply.set_result(None)
        else:
            self._awaited[correlation_id] = _Awaited(frozenset(reply_channels), reply)

        def forget() -> None:
            awaited = self._awaited.get(correlation_id)
            if awaited is not None and awaited.reply is reply:
                del self._awaited[correlation_id]

        return PendingReply(reply, forget)

    def route(self, frame: Frame) -> None:
        """Hand `frame` to the request that awaits it, if one does."""
        if frame.correlation_id is None:
            return
        awaited = self._awaited.get(frame.correlation_id)
        if awaited is None or frame.channel not in awaited.channels:
            return
        del self._awaited[frame.correlation_id]
        if not awaited.reply.done():
            awaited.reply.set_result(frame)

    def awaited(self) -> list[str]:
        """The correlation ids still awaited, in name order."""
        return sorted(self._awaited)

    def close(self) -> None:
        """End every wait: each request still pending learns that no reply will come."""
        self._closed = True
        for awaited in self._awaited.values():
            if not awaited.reply.done():
                awaited.reply.set_result(None)
        self._awaited.clear()


@final
class ResourceHold:
    """One hold on a resource's scope. Let go by `release`, or by leaving a `with`. Letting go twice is letting go once."""

    def __init__(self, release: Callable[[], None]) -> None:
        self._release: Callable[[], None] | None = release

    def release(self) -> None:
        """Let go of the hold."""
        release, self._release = self._release, None
        if release is not None:
            release()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.release()


class Transport(Protocol):
    """The bus, over whatever carries it."""

    @property
    def base_url(self) -> str:
        """What the transport speaks to: an origin over HTTP, a name for one with no wire."""
        ...

    async def emit(
        self,
        channel: str,
        payload: Mapping[str, JsonValue],
        *,
        scope: ResourceId | None = None,
        correlation_id: str | None = None,
    ) -> int | None:
        """Send one frame.

        Returns when it has been accepted, with the number of subscribers it
        reached, or with nothing when there is no count: an absent count is
        never a zero. `scope` makes it a broadcast on that resource's scope.
        Raises `TransportError` when it is refused, or never answered.
        """
        ...

    def frames(self, channel: str) -> Events[Frame]:
        """The frames delivered on `channel` from now on.

        Raises `BusRequestError`, as `bus.unsubscribed`, for a channel this
        transport can never deliver.
        """
        ...

    def is_subscribed(self, channel: str) -> bool:
        """Whether the transport's stream delivers `channel` with no scope held: whether a reply published there can reach this client."""
        ...

    def subscribe_to_resource(self, resource_id: ResourceId) -> ResourceHold:
        """Take one hold on a resource's scope. The scope is on the stream from its first hold to its last release."""
        ...

    @property
    def state(self) -> Watched[ConnectionState]:
        """The connection's state: what it is, and what it becomes."""
        ...

    def failures(self) -> Events[SemiontError]:
        """The failures the transport meets from now on: everything a server refused, and every request never answered."""
        ...

    def track_reply(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        """Await the reply to `correlation_id` on one of `reply_channels`.

        A request calls this before it emits, so its reply cannot arrive
        unawaited.
        """
        ...

    async def close(self) -> None:
        """Stop: the state becomes `closed`, every reader's events end, and every request still pending fails as closed.

        Closing twice is closing once.
        """
        ...


# ── Content ─────────────────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class PutBinaryRequest:
    """An upload: the bytes, and each field the resource is created with."""

    name: str
    file: bytes
    format: str
    """The media type of the bytes."""
    storage_uri: str
    entity_types: Sequence[str] = ()
    language: str | None = None
    source_annotation_id: AnnotationId | None = None
    source_resource_id: ResourceId | None = None
    generation_prompt: str | None = None
    generator: Agent | Sequence[Agent] | None = None
    """The agent or agents that generated it."""
    job_id: JobId | None = None
    """The job this resource fulfils, when a worker is creating it."""
    is_draft: bool | None = None
    clone_token: str | None = None
    """A clone's provenance: with it, the resource is created as a clone."""
    archive_original: bool | None = None
    """Of a clone: archive the source once the clone exists."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class UploadProgress:
    """How much of an upload has been sent."""

    bytes_uploaded: int
    total_bytes: int
    """The size of the whole request."""


@final
class Upload:
    """An upload. Awaited, it gives the resource created; iterated, how much of it has been sent, ending when it has.

    It begins when it is first awaited or iterated, and each is done once. Its
    caller abandons it by cancelling the task that awaits it or reads its
    progress: nothing more is sent, and nothing is reported.
    """

    def __init__(self, start: Callable[[Callable[[UploadProgress], None]], "asyncio.Task[CreateResourceResponse]"]) -> None:
        self._start = start
        self._sending: asyncio.Task[CreateResourceResponse] | None = None
        self._reports: asyncio.Queue[UploadProgress | None] = asyncio.Queue()
        self._awaited = False
        self._iterated = False

    def _begun(self) -> "asyncio.Task[CreateResourceResponse]":
        if self._sending is None:
            self._sending = self._start(self._reports.put_nowait)
            self._sending.add_done_callback(self._ended)
        return self._sending

    def _ended(self, sending: "asyncio.Task[CreateResourceResponse]") -> None:
        # What it reported before it ended has been queued, and it reports no more.
        self._reports.put_nowait(None)
        if not sending.cancelled():
            # Its failure is its awaiter's to hear. Read here, it is not also said to be unheard.
            sending.exception()

    async def _outcome(self) -> CreateResourceResponse:
        return await self._begun()

    def __await__(self) -> Generator[object, None, CreateResourceResponse]:
        if self._awaited:
            raise RuntimeError("an upload is awaited once")
        self._awaited = True
        return self._outcome().__await__()

    def __aiter__(self) -> AsyncIterator[UploadProgress]:
        if self._iterated:
            raise RuntimeError("an upload's progress is read once")
        self._iterated = True
        return self

    async def __anext__(self) -> UploadProgress:
        sending = self._begun()
        try:
            progress = await self._reports.get()
        except asyncio.CancelledError:
            sending.cancel()
            raise
        if progress is None:
            # Left for a later read, which ends the same way.
            self._reports.put_nowait(None)
            raise StopAsyncIteration
        return progress


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Content:
    """A resource's bytes, with their media type."""

    data: bytes
    content_type: str


@final
class ContentStream:
    """A resource's bytes as they arrive, with their media type.

    Held with `async with`, which ends the read on the way out, whether or
    not every byte was taken.
    """

    def __init__(self, content_type: str, pieces: AsyncGenerator[bytes]) -> None:
        self.content_type: Final = content_type
        self._pieces = pieces

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._pieces

    async def aclose(self) -> None:
        """End the read: nothing more is taken from the gateway."""
        await self._pieces.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.aclose()


class ContentTransport(Protocol):
    """Bytes, which never ride the bus, and a resource's description as linked data."""

    def put_binary(self, request: PutBinaryRequest) -> Upload:
        """Upload `request`'s bytes as a new resource."""
        ...

    async def get_binary(self, resource_id: ResourceId) -> Content:
        """A resource's bytes, unchanged, with their media type."""
        ...

    async def get_binary_stream(self, resource_id: ResourceId) -> ContentStream:
        """The same, as a stream."""
        ...

    async def get_resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        """A resource's description: itself, its annotations and the references to it."""
        ...


# ── The gateway's own operations ────────────────────────────────────────


class GatewayOperations(Protocol):
    """What a gateway answers for itself. A transport with no gateway behind it does not offer it."""

    async def get_current_user(self) -> UserResponse:
        """Who the gateway says this token is."""
        ...

    async def get_media_token(self, resource_id: ResourceId) -> MediaTokenResponse:
        """A token that lets a browser fetch one resource's bytes."""
        ...

    async def get_protected_resource_metadata(self) -> ProtectedResourceMetadata:
        """Which issuer the knowledge base trusts (RFC 9728). Public: read before any token exists."""
        ...

    async def health_check(self) -> HealthResponse:
        """Whether the gateway is serving."""
        ...

    async def get_status(self) -> StatusResponse:
        """What the gateway is, and who it takes its caller to be."""
        ...
