"""A client of a knowledge base's bus, over any `Transport`: emit, read, and request.

**By type** (`Bus`), a channel is one of `semiont.channels`' constants and a
payload is that channel's own, so a type checker refuses a wrong payload for a
channel, gives a frame its payload's type, and gives a request its
operation's reply:

    bus = Bus(transport)
    await bus.emit(BECKON_FOCUS, BeckonFocusEvent(annotation_id=annotation))
    async for frame in bus.frames(MARK_ADDED): ...          # frame.payload is that channel's
    created = await bus.request(MARK_CREATE_REQUEST, command)

**By name** (`request`, and the transport's own `emit` and `frames`), a
channel is the registry's name and a payload a JSON object: for what relays
frames it does not read, or is told its channels at run time.

A request (`docs/protocol/TRANSPORT-CONTRACT.md` § Requests) is one emit that
carries a correlation id of this client's making
beside its payload, answered on its operation's result channel or its failure
channel. It is not sent before the stream that carries its reply is open. Its
id is tracked until it settles, so a reply published while the stream was down
is sent again. And it settles once: with its result, with a failure under this
vocabulary's code, or as a timeout.

A caller abandons a request by cancelling the task that awaits it. What was
sent stays sent, the reply stops being tracked, and one that comes anyway
reaches nobody. Cancelled while it waits for the stream, it sends nothing.
"""

import asyncio
import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final

from pydantic import JsonValue, ValidationError

from semiont.channel import AnyOperation, Channel, Operation
from semiont.errors import BusRequestError, TransportError
from semiont.events import Events
from semiont.identifiers import ResourceId, UserId
from semiont.model import WireModel
from semiont.timing import BUS_REQUEST_TIMEOUT_MS
from semiont.transport import ConnectionState, Frame, TraceContext, Transport
from semiont.watched import NeverReached, reached

__all__ = ["Bus", "Delivered", "Typed", "decoded", "reply_channels_for", "request"]

_LOG: Final = logging.getLogger("semiont.bus")

# What the gateway stamps on a payload to say who emitted it.
_EMITTED_BY: Final = "_userId"


def reply_channels_for(*operations: AnyOperation) -> tuple[str, ...]:
    """The result and failure channels of `operations`, each once.

    What a process that awaits only those operations names as its transport's
    channels: it hears its replies and nothing else.
    """
    replies: dict[str, None] = {}
    for operation in operations:
        replies[operation.result.name] = None
        replies[operation.failure.name] = None
    return tuple(replies)


def _settled(state: ConnectionState) -> bool:
    return state in ("open", "closed")


async def request(
    transport: Transport,
    operation: AnyOperation,
    payload: Mapping[str, JsonValue],
    *,
    timeout_ms: int = BUS_REQUEST_TIMEOUT_MS,
) -> Mapping[str, JsonValue]:
    """Send `payload` as the request of `operation`, and wait up to `timeout_ms` for its reply.

    Returns the payload of the reply on the operation's result channel.
    Raises `BusRequestError` when it is answered with a failure, when no
    reply comes in time, when the transport is closed, and when the
    transport's stream does not carry the operation's replies; and
    `TransportError` when the emit itself is refused.
    """
    asked, result, failure = operation.request.name, operation.result.name, operation.failure.name
    for channel in (result, failure):
        if not transport.is_subscribed(channel):
            raise BusRequestError(
                "bus.unsubscribed",
                f"Transport is not subscribed to reply channel {channel}: a reply to {asked} can never arrive. "
                "Add this operation's reply channels to the transport's channels.",
            )

    deadline = asyncio.get_running_loop().time() + timeout_ms / 1000

    def timed_out() -> BusRequestError:
        return BusRequestError("bus.timeout", f"Bus request timed out after {timeout_ms}ms on {result}")

    # No request before its reply can arrive: wait, inside the request's own
    # deadline, for the stream to be open. Only `open` delivers. A closed bus
    # fails at once, and does not spend the deadline.
    try:
        async with asyncio.timeout_at(deadline):
            state = await reached(transport.state, _settled)
    except TimeoutError:
        raise timed_out() from None
    except NeverReached:
        # A state that will change no more, and is not open, will not deliver.
        state = "closed"
    if state != "open":
        raise BusRequestError("bus.closed", f"Bus closed before emit on {asked}")

    # Tracked before the emit, so a stream opened while the emit is in flight
    # already names the reply. The emit is not cut short by the deadline: a
    # request half sent is one nobody can account for.
    correlation_id = str(uuid.uuid4())
    with transport.track_reply(correlation_id, (result, failure)) as pending:
        await transport.emit(asked, payload, correlation_id=correlation_id)
        try:
            async with asyncio.timeout_at(deadline):
                reply = await pending.frame()
        except TimeoutError:
            raise timed_out() from None

    if reply is None:
        raise BusRequestError("bus.closed", f"Bus closed before a reply on {result}")
    if reply.channel == result:
        return reply.payload
    raise BusRequestError.answered(reply.payload)


# ── By type ─────────────────────────────────────────────────────────────


def decoded[P: WireModel](channel: Channel[P], payload: Mapping[str, JsonValue]) -> P:
    """A payload as `channel` types it. Raises `ValidationError` for one that is not that channel's.

    What the gateway stamps on a payload (a member whose name begins `_`) is
    the bus's, not the payload's: one the channel's type does not declare is
    left out before the payload is read.
    """
    return channel.decode({name: value for name, value in payload.items() if not name.startswith("_") or name in channel.stamps})


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Delivered[P: WireModel]:
    """A frame of one channel, its payload decoded."""

    payload: P
    correlation_id: str | None = None
    scope: ResourceId | None = None
    user_id: UserId | None = None
    """Who emitted it, as the gateway stamped it."""
    trace: TraceContext | None = None


@final
class Typed[P: WireModel]:
    """One channel's frames from now on, each with its payload decoded.

    Iterated (`async for`), and can be held with `async with`, which stops
    listening on the way out. A frame whose payload is not the channel's is
    nobody's to act on: it is not given, and is said so in the log.
    """

    def __init__(self, channel: Channel[P], frames: Events[Frame]) -> None:
        self._channel: Final = channel
        self._frames: Final = frames

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> Delivered[P]:
        while True:
            frame = await anext(self._frames)
            try:
                payload = decoded(self._channel, frame.payload)
            except ValidationError as error:
                _LOG.warning("a payload on %s is not that channel's: %s", self._channel.name, error)
                continue
            stamped = frame.payload.get(_EMITTED_BY)
            return Delivered(
                payload=payload,
                correlation_id=frame.correlation_id,
                scope=frame.scope,
                user_id=UserId.parse(stamped) if isinstance(stamped, str) else None,
                trace=frame.trace,
            )

    async def aclose(self) -> None:
        """Stop listening."""
        await self._frames.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.aclose()


@final
class Bus:
    """The bus over `transport`, typed by channel. See the module's documentation."""

    def __init__(self, transport: Transport) -> None:
        self.transport: Final = transport

    async def emit[P: WireModel](
        self, channel: Channel[P], payload: P, *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        """Send one frame on `channel`. How many subscribers the gateway reached, or nothing when it kept no count."""
        return await self.transport.emit(channel.name, channel.encode(payload), scope=scope, correlation_id=correlation_id)

    def frames[P: WireModel](self, channel: Channel[P]) -> Typed[P]:
        """The frames delivered on `channel` from now on. Refused, as `bus.unsubscribed`, for a channel this transport can never deliver."""
        return Typed(channel, self.transport.frames(channel.name))

    async def request[Q: WireModel, R: WireModel, F: WireModel](
        self, operation: Operation[Q, R, F], payload: Q, *, timeout_ms: int = BUS_REQUEST_TIMEOUT_MS
    ) -> R:
        """Send `payload` as the request of `operation`, and wait up to `timeout_ms` for its result.

        Raises as `request` does, and `TransportError` when the result that
        came is not the operation's.
        """
        reply = await request(self.transport, operation, operation.request.encode(payload), timeout_ms=timeout_ms)
        try:
            return decoded(operation.result, reply)
        except ValidationError as error:
            raise TransportError("error", f"a payload on {operation.result.name} is not that channel's: {error}") from error
