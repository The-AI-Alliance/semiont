"""A client's own bus: frames published and read inside one process.

A client makes one and hands it to its transport (`bridge_into`), which
delivers into it every frame it receives. What the client's own parts say to
each other goes through it too, and never reaches the wire.

A frame is published to everyone or into one resource's scope, and a reader
sees one or the other: a reader of a channel does not see a frame published
into a scope, and a scope's reader sees only its own.

A reader of one channel is given its frames in the order they were published.
Two readers give no order between them, so one that needs what was said on
several channels in the order it was said reads them as one (`frames_among`).

By type (`publish`, `frames`), the channel is one of `semiont.channels`'
constants and the payload is that channel's own, as on `semiont.bus.Bus`. By
name (`emit`, `frames_on`), a channel is its name and a payload a JSON object.
"""

from collections.abc import Collection, Mapping
from typing import Final, final, override

from pydantic import JsonValue

from semiont.bus import Typed
from semiont.channel import Channel, ScopedChannel
from semiont.events import Broadcast, Events
from semiont.identifiers import ResourceId
from semiont.model import WireModel
from semiont.transport import Frame, FrameSink

__all__ = ["EventBus"]


@final
class EventBus(FrameSink):
    """See the module's documentation."""

    def __init__(self) -> None:
        self._views: Final[dict[tuple[str, ResourceId | None], Broadcast[Frame]]] = {}
        """The readers of each channel: of what is published to everyone, and of each scope."""
        self._among: list[tuple[frozenset[str], Broadcast[Frame]]] = []
        """The readers of several channels at once, each with the channels it reads."""
        self._destroyed = False

    @property
    def destroyed(self) -> bool:
        """Whether the bus has ended."""
        return self._destroyed

    @override
    def deliver(self, frame: Frame) -> None:
        """Publish a frame as it is: to everyone, or into the scope it names. A destroyed bus has no reader to give it to."""
        if frame.scope is None:
            for channels, readers in self._among:
                if frame.channel in channels:
                    readers.deliver(frame)
        view = self._views.get((frame.channel, frame.scope))
        if view is not None:
            view.deliver(frame)

    def emit(
        self, channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> None:
        """Publish one frame on the channel named `channel`: to everyone, or into `scope`."""
        self.deliver(Frame(channel=channel, payload=payload, correlation_id=correlation_id, scope=scope))

    def publish[P: WireModel](
        self,
        channel: Channel[P] | ScopedChannel[P],
        payload: P,
        *,
        scope: ResourceId | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Publish one frame of `channel`: to everyone, or into `scope`."""
        self.emit(channel.name, channel.encode(payload), scope=scope, correlation_id=correlation_id)

    def frames_on(self, channel: str, *, scope: ResourceId | None = None) -> Events[Frame]:
        """The frames published on the channel named `channel` from now on: to everyone, or into `scope`. Of a destroyed bus, none."""
        view = self._views.get((channel, scope))
        if view is None:
            view = Broadcast[Frame]()
            if self._destroyed:
                view.close()
            else:
                self._views[channel, scope] = view
        return view.listen()

    def frames[P: WireModel](self, channel: Channel[P] | ScopedChannel[P], *, scope: ResourceId | None = None) -> Typed[P]:
        """The frames published on `channel` from now on, each with its payload decoded: to everyone, or into `scope`."""
        return Typed(channel, self.frames_on(channel.name, scope=scope))

    def frames_among(self, channels: Collection[str]) -> Events[Frame]:
        """The frames published to everyone on any of `channels` from now on, in the order they were published."""
        readers = Broadcast[Frame]()
        if self._destroyed:
            readers.close()
        else:
            # A view nobody reads any more is let go here, where the next one is made.
            self._among = [(seen, kept) for seen, kept in self._among if kept.listening > 0]
            self._among.append((frozenset(channels), readers))
        return readers.listen()

    def destroy(self) -> None:
        """End every reader's frames, and every later reader's. Destroying twice is destroying once."""
        self._destroyed = True
        for view in self._views.values():
            view.close()
        for _, readers in self._among:
            readers.close()
        self._views.clear()
        self._among.clear()
