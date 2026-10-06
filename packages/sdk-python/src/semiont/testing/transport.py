"""A scriptable `Transport` with no wire, for tests.

Two things are scripted, and they are different things. The **wire**, by a
schedule of faults applied one to each request in turn: deliver its reply,
drop it, delay it, deliver it twice, or refuse the emit. And the **gateway**,
by the responses queued for each operation. So "the first reply is lost and
the retry sees the next page" can be said: a dropped reply still spends its
queued response, because the gateway answered and the wire ate it.

A request can be scripted to be answered with a failure (`refuse_when`): the
answer a peer gives when it will not do what was asked. That is not the wire
failing, and the schedule applies to it as to any reply.

A request nobody scripted a response for is refused, naming the operation. A
double that answered it with an empty success would hand its caller a reply
whose every field is absent, which fails far from its cause.

What is emitted through it is delivered through it, to whoever listens, as a
gateway gives a frame to its subscribers. All of its variation comes in
through the schedule, so a test that fixes the schedule fixes the run.
"""

import asyncio
from collections import deque
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final, Literal, NoReturn, final, override

from pydantic import JsonValue, TypeAdapter

from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast, Events
from semiont.identifiers import ResourceId
from semiont.operations import OPERATIONS
from semiont.transport import ConnectionState, Frame, FrameHub, FrameSink, PendingReply, ReplyRouter, ResourceHold, Transport, unsubscribed
from semiont.watched import Variable, Watched

__all__ = [
    "Delay",
    "Deliver",
    "DropReply",
    "DuplicateReply",
    "FaultAction",
    "FaultyTransport",
    "MakeResponse",
    "Refuse",
    "RejectEmit",
    "RequestLogEntry",
    "refuse_unscripted_operation",
    "retry_key_of",
]


@final
@dataclass(frozen=True, slots=True)
class Deliver:
    """The request's reply is delivered."""

    kind: Literal["deliver"] = field(default="deliver", init=False)


@final
@dataclass(frozen=True, slots=True)
class DropReply:
    """The request's reply is lost."""

    kind: Literal["drop-reply"] = field(default="drop-reply", init=False)


@final
@dataclass(frozen=True, slots=True)
class Delay:
    """The request's reply is delivered after `ms` milliseconds."""

    ms: int
    kind: Literal["delay"] = field(default="delay", init=False)


@final
@dataclass(frozen=True, slots=True)
class DuplicateReply:
    """The request's reply is delivered twice."""

    kind: Literal["duplicate-reply"] = field(default="duplicate-reply", init=False)


@final
@dataclass(frozen=True, slots=True)
class RejectEmit:
    """The emit itself is refused: the request never reaches the gateway."""

    kind: Literal["reject-emit"] = field(default="reject-emit", init=False)


type FaultAction = Deliver | DropReply | Delay | DuplicateReply | RejectEmit
"""What the wire does to one request."""

type MakeResponse = Callable[[str, Mapping[str, JsonValue]], JsonValue | None]
"""What the gateway answers a request with, given its operation and its payload.

Its `response`, or nothing for a reply that carries none.
"""

type Refuse = Callable[[str, Mapping[str, JsonValue]], Mapping[str, JsonValue] | None]
"""The failure the gateway answers a request with, when it answers it with one: the payload of the operation's failure channel."""

_PAIRS: Final = TypeAdapter[list[tuple[str, JsonValue]]](list[tuple[str, JsonValue]])

# What a gateway stamps on a payload: no part of what was asked.
_STAMPED: Final = ("_trace", "_userId")


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class RequestLogEntry:
    """One request the transport was sent."""

    channel: str
    action: FaultAction
    """What the schedule did to it."""
    correlation_id: str | None
    retry_key: str
    """The request's identity across retries: two entries with the same key are one logical request, sent again."""
    payload: Mapping[str, JsonValue]
    """The payload as it was sent."""


def retry_key_of(channel: str, payload: Mapping[str, JsonValue]) -> str:
    """A request's identity across retries: its channel and its payload, less what the gateway stamps on it."""
    asked = sorted((name, value) for name, value in payload.items() if name not in _STAMPED)
    return f"{channel} {_PAIRS.dump_json(asked).decode()}"


def refuse_unscripted_operation(operation: str, payload: Mapping[str, JsonValue]) -> NoReturn:
    """What answers a request nothing was scripted for: a refusal that names the operation, never a response made up."""
    raise TransportError(
        "error",
        f'No response scripted for bus operation "{operation}". '
        f'Script one with queue_reply("{operation}", ...) or build the transport with a make_response that answers it.',
    )


@final
class FaultyTransport(Transport):
    """See the module's documentation.

    The i-th request meets `schedule[i % len(schedule)]`; with an empty
    schedule every reply is delivered. `make_response` answers every request
    no queued response does: with none, such a request is refused by name.
    `channels` are the channels its stream delivers with no scope held: every
    channel, unless a test names them.
    """

    def __init__(
        self,
        schedule: Sequence[FaultAction] = (),
        *,
        make_response: MakeResponse = refuse_unscripted_operation,
        channels: Collection[str] | None = None,
    ) -> None:
        self._schedule: Final = tuple(schedule)
        self._make_response: Final = make_response
        self._channels: Final = channels
        self._refuse: Refuse | None = None
        self._replies: Final[dict[str, deque[JsonValue | None]]] = {}
        self._log: Final[list[RequestLogEntry]] = []
        self._emitted: Final[list[Frame]] = []
        self._held: Final[dict[ResourceId, int]] = {}
        """How many holds each resource's scope has."""
        self._hub: Final = FrameHub()
        self._router: Final = ReplyRouter()
        self._state: Final = Variable[ConnectionState]("open")
        self._failures: Final = Broadcast[SemiontError]()
        self._closed = False

    # ── What a test says ────────────────────────────────────────────────

    def queue_reply(self, operation: str, responses: Iterable[JsonValue | None]) -> None:
        """Queue what the gateway answers the next requests of `operation` with, one each, before `make_response` is asked.

        Each is a `response`, or `None` for a reply that carries none.
        """
        self._replies.setdefault(operation, deque()).extend(responses)

    def refuse_when(self, refuse: Refuse) -> None:
        """Have the gateway answer with a failure every request `refuse` gives one for.

        The failure is the payload of the operation's failure channel, such
        as `{"code": "not-found", "message": "…"}`. It is asked before
        anything queued or scripted to answer.
        """
        self._refuse = refuse

    def fail(self, error: SemiontError) -> None:
        """Report a failure on the failure stream, as a transport does of a request the gateway refused."""
        self._failures.deliver(error)

    def set_state(self, state: ConnectionState) -> None:
        """Change the connection's state, as a wire would. A closed transport's is closed."""
        self._state.set(state)

    def deliver(self, frame: Frame) -> None:
        """Deliver a frame as if the bus had carried it. A closed transport has nobody to deliver to."""
        self._router.route(frame)
        self._hub.deliver(frame)

    # ── What a test reads ───────────────────────────────────────────────

    @property
    def request_log(self) -> Sequence[RequestLogEntry]:
        """Every request sent, in order."""
        return self._log

    @property
    def emitted(self) -> Sequence[Frame]:
        """Every frame emitted through it, in order: the requests, and what was only sent."""
        return self._emitted

    def holds(self, resource_id: ResourceId) -> int:
        """How many holds there are on a resource's scope."""
        return self._held.get(resource_id, 0)

    @property
    def scopes(self) -> list[ResourceId]:
        """The resources whose scope is held, in name order."""
        return sorted(self._held)

    @property
    def pending_replies(self) -> list[str]:
        """The correlation ids of the replies still awaited."""
        return self._router.awaited()

    # ── The transport ───────────────────────────────────────────────────

    @property
    @override
    def base_url(self) -> str:
        return "faulty://simulator"

    @override
    async def emit(
        self, channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if self._closed:
            return None
        # As it was sent: its caller changing its own payload afterwards rewrites nothing here.
        sent = dict(payload)
        request = Frame(channel=channel, payload=sent, correlation_id=correlation_id, scope=scope)
        self._emitted.append(request)
        operation = OPERATIONS.get(channel)
        if operation is None:
            self.deliver(request)
            return 1

        action: FaultAction = self._schedule[len(self._log) % len(self._schedule)] if self._schedule else Deliver()
        self._log.append(
            RequestLogEntry(
                channel=channel, action=action, correlation_id=correlation_id, retry_key=retry_key_of(channel, sent), payload=sent
            )
        )
        if isinstance(action, RejectEmit):
            raise TransportError("error", f"FaultyTransport: emit rejected by schedule on {channel}")

        # The gateway answers once per request that reaches it, whatever the wire then does to the answer.
        refused = None if self._refuse is None else self._refuse(channel, sent)
        if refused is not None:
            reply = Frame(channel=operation.failure.name, payload=refused, correlation_id=correlation_id)
        else:
            queued = self._replies.get(channel)
            response = queued.popleft() if queued else self._make_response(channel, sent)
            reply = Frame(
                channel=operation.result.name, payload={} if response is None else {"response": response}, correlation_id=correlation_id
            )
        self.deliver(request)

        # The reply comes after the emit has been accepted, as a wire's does. One on its way when the transport closes is dropped.
        loop = asyncio.get_running_loop()
        match action:
            case Deliver():
                loop.call_soon(self._arrive, reply, 1)
            case DuplicateReply():
                loop.call_soon(self._arrive, reply, 2)
            case Delay(ms=ms):
                loop.call_later(ms / 1000, self._arrive, reply, 1)
            case DropReply():
                pass
        return 1

    def _arrive(self, reply: Frame, copies: int) -> None:
        for _ in range(copies):
            self.deliver(reply)

    @override
    def frames(self, channel: str) -> Events[Frame]:
        if not self.is_subscribed(channel):
            raise unsubscribed(channel)
        return self._hub.frames(channel)

    @override
    def is_subscribed(self, channel: str) -> bool:
        return self._channels is None or channel in self._channels

    @override
    def subscribe_to_resource(self, resource_id: ResourceId) -> ResourceHold:
        # Nothing here is delivered by scope, so a hold changes only the count of them (`holds`).
        self._held[resource_id] = self._held.get(resource_id, 0) + 1

        def release() -> None:
            remaining = self._held[resource_id] - 1
            if remaining:
                self._held[resource_id] = remaining
            else:
                del self._held[resource_id]

        return ResourceHold(release)

    @property
    @override
    def state(self) -> Watched[ConnectionState]:
        return self._state

    @override
    def failures(self) -> Events[SemiontError]:
        return self._failures.listen()

    @override
    def track_reply(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        return self._router.track(correlation_id, reply_channels)

    @override
    def bridge_into(self, bus: FrameSink) -> None:
        self._hub.bridge(bus)

    @override
    async def close(self) -> None:
        self._closed = True
        self._state.set("closed")
        self._state.end()
        self._hub.close()
        self._router.close()
        self._failures.close()
