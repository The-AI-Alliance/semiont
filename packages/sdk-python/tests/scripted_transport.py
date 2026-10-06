"""A transport that does what a test tells it to, and records what it was asked: for what no gateway can be made to do on cue."""

import asyncio
from collections.abc import Collection, Mapping
from typing import final, override

from pydantic import JsonValue

from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast, Events
from semiont.identifiers import ResourceId
from semiont.transport import ConnectionState, Frame, FrameHub, PendingReply, ReplyRouter, ResourceHold, Transport, unsubscribed
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
        self.emitted: list[tuple[str, Mapping[str, JsonValue], str | None]] = []
        self.sent = asyncio.Event()
        self.refusal: TransportError | None = None

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
        self.emitted.append((channel, payload, correlation_id))
        self.sent.set()
        return None

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
        return ResourceHold(lambda: None)

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
    async def close(self) -> None:
        self.now.set("closed")
        self.now.end()
        self.router.close()

    async def asked(self) -> str:
        """The correlation id of the one request emitted, once it has been."""
        await self.sent.wait()
        correlation_id = self.emitted[0][2]
        assert correlation_id is not None
        return correlation_id
