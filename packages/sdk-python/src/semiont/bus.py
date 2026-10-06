"""A request over the bus, on any `Transport` (`docs/protocol/TRANSPORT-CONTRACT.md` § Requests).

A request is one emit that carries a correlation id of this client's making
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
import uuid
from collections.abc import Mapping

from pydantic import JsonValue

from semiont.channel import AnyOperation
from semiont.errors import BusRequestError
from semiont.timing import BUS_REQUEST_TIMEOUT_MS
from semiont.transport import ConnectionState, Transport
from semiont.watched import NeverReached, reached

__all__ = ["reply_channels_for", "request"]


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
