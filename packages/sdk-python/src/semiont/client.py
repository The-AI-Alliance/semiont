"""A client of one knowledge base: its eleven namespaces over a transport, the bytes that never ride the bus, and the gateway's own answers.

A client owns a bus of its own (`bus`). Its transport delivers into that bus
every frame it receives, and what the client's own parts say to each other (a
viewer's signals) goes through it and never reaches the wire. The namespaces
are attributes: `client.browse`, `client.mark`, and so on, with `yield_` for
the one whose name Python keeps for itself.

A client keeps its queries true: what `browse`, `gather` and `match` answer
as live queries comes from its cache, and each event its transport delivers
refreshes what the cache holds (`semiont.cached`). With a `persistence`, the
small queries are kept there, and the next client of the same knowledge base
shows them at once.

A client is held with `async with`, and inside it listens for what keeps
its queries true. On the way out its live queries end, its followed jobs end,
every reader of its own bus is told there is no more, and the tasks it
started have ended. It does not open or close its transport: whoever opened
that closes it, after the client.

    async with HttpTransport(origin, token=token) as transport:
        async with SemiontClient(transport, transport.content, transport) as client:
            resource = await client.browse.resource(resource_id).fresh()
"""

from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final

from semiont.bus import Bus
from semiont.event_bus import EventBus
from semiont.namespaces.auth import AuthNamespace
from semiont.namespaces.beckon import BeckonNamespace
from semiont.namespaces.bind import BindNamespace
from semiont.namespaces.browse import BrowseNamespace
from semiont.namespaces.frame import FrameNamespace
from semiont.namespaces.gather import GatherNamespace
from semiont.namespaces.job import JobNamespace
from semiont.namespaces.links import Links
from semiont.namespaces.live import CachePersistence, Live
from semiont.namespaces.mark import MarkNamespace
from semiont.namespaces.match import MatchNamespace
from semiont.namespaces.refresher import Refresher
from semiont.namespaces.system import SystemNamespace
from semiont.namespaces.yield_ import YieldNamespace
from semiont.timing import BUS_REQUEST_TIMEOUT_MS, INVALIDATION_WINDOW_MS, JOB_SILENCE_MS, JOB_STATUS_POLL_MS
from semiont.transport import ContentTransport, GatewayOperations, Transport

__all__ = ["CachePersistence", "ClientTiming", "SemiontClient"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ClientTiming:
    """The waits a client keeps: `specs/src/client/timing.json`'s, unless a caller that must not wait them out says otherwise."""

    bus_request_ms: int = BUS_REQUEST_TIMEOUT_MS
    """How long a bus request waits for its reply."""
    job_silence_ms: int = JOB_SILENCE_MS
    """How long a followed job may say nothing before its status is asked for."""
    job_status_poll_ms: int = JOB_STATUS_POLL_MS
    """How often a silent job's status is asked for after that."""
    invalidation_window_ms: int = INVALIDATION_WINDOW_MS
    """How long the refetches events ask of one cached key are one refetch."""


@final
class SemiontClient[T: Transport]:
    """See the module's documentation.

    `content` carries the bytes and `gateway` answers for itself; over HTTP
    the transport is all three. `transport` is kept as the kind of transport
    it is, for what the namespaces do not cover: a frame on a channel by name,
    a hold on a resource's scope.
    """

    def __init__(
        self,
        transport: T,
        content: ContentTransport,
        gateway: GatewayOperations,
        *,
        timing: ClientTiming | None = None,
        persistence: CachePersistence | None = None,
    ) -> None:
        kept = ClientTiming() if timing is None else timing
        self.transport: Final[T] = transport
        self.timing: Final = kept
        self.bus: Final = EventBus()
        """The client's own bus: every frame the transport delivered, and every signal the client's parts gave each other."""
        self.wire: Final = Bus(transport)
        """The bus over the transport, typed by channel: an emit, a channel's frames, a request."""
        transport.bridge_into(self.bus)
        self._links: Final = Links(
            wire=self.wire,
            own=self.bus,
            bus_request_ms=kept.bus_request_ms,
            job_silence_ms=kept.job_silence_ms,
            job_status_poll_ms=kept.job_status_poll_ms,
        )
        self._closed = False
        self._held = False
        self._live: Final = Live(self._links, persistence)
        self._refresher: Final = Refresher(self._links, self._live, invalidation_window_ms=kept.invalidation_window_ms)

        self.frame: Final = FrameNamespace(self._links)
        """The vocabulary: what kinds of things exist."""
        self.browse: Final = BrowseNamespace(self._links, content, self._live)
        """Reads, and this viewer's own signals."""
        self.mark: Final = MarkNamespace(self._links)
        """Annotations, a resource's own metadata, and the annotating of a resource delegated as a job."""
        self.bind: Final = BindNamespace(self._links)
        """Linking a reference to what it refers to."""
        self.gather: Final = GatherNamespace(self._links, self._live)
        """Assembling the context a model is given, and what refers to a resource."""
        self.match: Final = MatchNamespace(self._links, self._live)
        """Searching: for what a reference could refer to, and for resources by text."""
        self.yield_: Final = YieldNamespace(self._links, content)
        """Creating resources."""
        self.beckon: Final = BeckonNamespace(self._links)
        """Attention: driving the other participants' viewers."""
        self.job: Final = JobNamespace(self._links)
        """Jobs: their lifecycle, their status and their cancellation."""
        self.auth: Final = AuthNamespace(gateway)
        """The gateway's view of who is signed in."""
        self.system: Final = SystemNamespace(gateway)
        """What the knowledge base says about itself."""

    async def __aenter__(self) -> Self:
        if self._closed or self._held:
            raise RuntimeError("a client is held once")
        self._held = True
        self._refresher.start()
        self._live.kept_true()
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.close()

    @property
    def persistence_settled(self) -> bool:
        """Whether every cache the client keeps is at rest: none is fetching, and none owes a save.

        What is kept of the stream's place is kept only then (`semiont.resume`).
        """
        return self._live.persistence_settled

    async def close(self) -> None:
        """End the client.

        The queries end first: every watcher's states end, a read asked for
        after is refused as `bus.closed`, and what was owed to storage is
        saved. Then its own bus ends, so every reader of it and every followed
        job does, and then the tasks it started: a read still waiting for its
        answer fails as `bus.closed`. Closing twice is closing once.
        """
        self._closed = True
        self._refresher.dispose()
        self._live.dispose()
        self.bus.destroy()
        await self._links.close()
