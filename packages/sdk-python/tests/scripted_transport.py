"""A transport that does what a test tells it to, and records what it was asked: for what no gateway can be made to do on cue."""

import asyncio
from collections.abc import Collection, Mapping
from typing import final, override

from pydantic import JsonValue

from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast, Events
from semiont.identifiers import ResourceId
from semiont.operations import OPERATIONS
from semiont.transport import ConnectionState, Frame, FrameHub, FrameSink, PendingReply, ReplyRouter, ResourceHold, Transport, unsubscribed
from semiont.watched import Variable, Watched


@final
class Scripted(Transport):
    """A transport that does what a test tells it to, and records what it was asked."""

    def __init__(self, channels: Collection[str], state: ConnectionState) -> None:
        self.channels = channels
        self.now: Variable[ConnectionState] = Variable(state)
        self.router = ReplyRouter()
        self.hub = FrameHub()
        self.failed: Broadcast[SemiontError] = Broadcast()
        self.emitted: list[Frame] = []
        """Every frame sent, in order."""
        self.sent = asyncio.Event()
        self.held: list[ResourceId] = []
        """The resource of each hold on a scope that was taken and has not been let go."""
        self.refusal: TransportError | None = None
        self.answers: dict[str, list[JsonValue]] | None = None
        """When there is one, the gateway behind the transport answers each request: with the next of what is
        queued here for its operation (a `response`, or `None` for a reply that carries none), and with a refusal
        when nothing is. With none, a test answers a request itself."""

    @property
    @override
    def base_url(self) -> str:
        return "scripted"

    @override
    async def emit(
        self, channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if self.refusal is not None:
            raise self.refusal
        self.emitted.append(Frame(channel=channel, payload=payload, correlation_id=correlation_id, scope=scope))
        self.sent.set()
        operation = OPERATIONS.get(channel)
        if self.answers is not None and operation is not None and correlation_id is not None:
            queued = self.answers.get(channel)
            if queued:
                response = queued.pop(0)
                self.deliver(
                    Frame(
                        channel=operation.result.name,
                        payload={} if response is None else {"response": response},
                        correlation_id=correlation_id,
                    )
                )
            else:
                # A request nobody scripted an answer for is refused, naming the operation.
                refused: dict[str, JsonValue] = {"code": "rejected", "message": f"the scripted gateway was told no answer to {channel}"}
                self.deliver(Frame(channel=operation.failure.name, payload=refused, correlation_id=correlation_id))
        return None

    def deliver(self, frame: Frame) -> None:
        """Deliver a frame as if the bus had carried it."""
        self.router.route(frame)
        self.hub.deliver(frame)

    @override
    def frames(self, channel: str) -> Events[Frame]:
        if not self.is_subscribed(channel):
            raise unsubscribed(channel)
        return self.hub.frames(channel)

    @override
    def is_subscribed(self, channel: str) -> bool:
        return channel in self.channels

    @override
    def subscribe_to_resource(self, resource_id: ResourceId) -> ResourceHold:
        self.held.append(resource_id)
        return ResourceHold(lambda: self.held.remove(resource_id))

    @property
    @override
    def state(self) -> Watched[ConnectionState]:
        return self.now

    @override
    def failures(self) -> Events[SemiontError]:
        return self.failed.listen()

    @override
    def track_reply(self, correlation_id: str, reply_channels: Collection[str]) -> PendingReply:
        return self.router.track(correlation_id, reply_channels)

    @override
    def bridge_into(self, bus: FrameSink) -> None:
        self.hub.bridge(bus)

    @override
    async def close(self) -> None:
        self.now.set("closed")
        self.now.end()
        self.hub.close()
        self.router.close()

    def asked_for(self, operation: str) -> list[Frame]:
        """The requests of one operation, in the order they were made."""
        return [frame for frame in self.emitted if frame.channel == operation]

    def answer(self, request: Frame, response: JsonValue) -> None:
        """Answer a request with `response`, as the service that answers its operation would."""
        self.deliver(
            Frame(channel=OPERATIONS[request.channel].result.name, payload={"response": response}, correlation_id=request.correlation_id)
        )

    def refuse(self, request: Frame, message: str = "the service refused") -> None:
        """Answer a request with a failure."""
        refused: dict[str, JsonValue] = {"code": "rejected", "message": message}
        self.deliver(Frame(channel=OPERATIONS[request.channel].failure.name, payload=refused, correlation_id=request.correlation_id))

    async def asked(self) -> str:
        """The correlation id of the one request emitted, once it has been."""
        await self.sent.wait()
        correlation_id = self.emitted[0].correlation_id
        assert correlation_id is not None
        return correlation_id
