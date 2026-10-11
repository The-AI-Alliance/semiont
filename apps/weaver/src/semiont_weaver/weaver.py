"""The Weaver: what follows the record, applies it to the graph, and repairs what it missed and what the graph lost.

`docs/protocol/WEAVER.md` states what it does, rule by rule. Held with
`async with`: it follows the record from the way in to the way out. Its three
other pieces of work are asked of it: `catch_up` and `reconcile`, which a
service runs once when it starts, and a rebuild, which it also answers when
it is commanded on `weave:rebuild`.

It reaches two things: the graph, through the store it is given, and
everything else through the transport it is given. It opens no file of the
record and knows no address.
"""

import asyncio
from dataclasses import dataclass
from functools import partial
from types import TracebackType
from typing import Final, Self, final, override

from pydantic import JsonValue, ValidationError
from semiont.bus import Bus, decoded
from semiont.channel import Empty
from semiont.channels import WEAVE_APPLIED, WEAVE_REBUILD, WEAVE_REBUILD_FAILED, WEAVE_REBUILD_OK
from semiont.errors import SemiontError
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.transport import Frame, FrameSink, Transport
from semiont.types import CommandError, ResourceDescriptor, StoredEventResponse, WeaveApplied
from semiont_graph.codec import intended_graph_annotation
from semiont_graph.interface import GraphDatabase

from semiont_weaver.checkpoint import Checkpoint
from semiont_weaver.fold import apply, said_of
from semiont_weaver.history import History
from semiont_weaver.lanes import Lanes
from semiont_weaver.log import LOG
from semiont_weaver.marks import Marks
from semiont_weaver.recorded import stored_event

__all__ = ["CaughtUp", "Rebuilt", "Reconciled", "Weaver"]

_NO_RESOURCE: Final = "__system__"
"""The lane of an event that names no resource. Every event a Weaver follows is a resource's: one that names none has no mark to move."""

_KEEP_SECONDS: Final = 5.0
"""How often the marks are kept, when one has risen."""

_CATCH_UP_WAITS_SECONDS: Final = 30.0
"""How long catch-up waits for what it replayed to be applied, before it reports what has not been and leaves the rest to the lanes."""


def words_of(failure: BaseException) -> str:
    """A failure, in a line: what kind it is, and what it says."""
    return f"{type(failure).__name__}: {failure}"


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CaughtUp:
    """What catch-up did."""

    resources_checked: int
    events_replayed: int
    resources_rebuilt: int
    events_failed: int
    """How many events were not applied while it ran, whoever delivered them."""
    parity_pending: int
    """How many resources had not reached their last event when it stopped waiting."""

    def said(self) -> dict[str, JsonValue]:
        """This, as the health endpoint reports it."""
        return {
            "resourcesChecked": self.resources_checked,
            "eventsReplayed": self.events_replayed,
            "resourcesRebuilt": self.resources_rebuilt,
            "eventsFailed": self.events_failed,
            "parityPending": self.parity_pending,
        }


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Reconciled:
    """What reconcile found, and did about it."""

    resources_checked: int
    divergent: int
    healed: int
    heal_failures: int
    """The divergent resources whose rebuild left events not applied."""
    orphaned: int
    """The resources the catalog lists and the record holds no events for."""

    def said(self) -> dict[str, JsonValue]:
        """This, as the health endpoint reports it."""
        return {
            "resourcesChecked": self.resources_checked,
            "divergent": self.divergent,
            "healed": self.healed,
            "healFailures": self.heal_failures,
            "orphaned": self.orphaned,
        }


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Rebuilt:
    """What a rebuild applied: how many events the record held for what was rebuilt, and how many of them were not applied."""

    events: int
    failed: int


@final
class _Delivered(FrameSink):
    """Where a Weaver's transport delivers every frame: to the Weaver, as each is delivered."""

    def __init__(self, weaver: "Weaver") -> None:
        self._weaver: Final = weaver

    @override
    def deliver(self, frame: Frame) -> None:
        self._weaver.delivered(frame)


@final
class Weaver:
    """A Weaver over `graph`, reaching the knowledge base through `transport`, and keeping its marks in `checkpoint`.

    The graph is connected and the transport's stream names what a Weaver
    reads (`semiont_weaver.service.CHANNELS`) before it is entered. Neither
    is closed on the way out: they are whoever made them's to close.
    """

    def __init__(self, graph: GraphDatabase, transport: Transport, checkpoint: Checkpoint) -> None:
        self._graph: Final = graph
        self._transport: Final = transport
        self._bus: Final = Bus(transport)
        self._checkpoint: Final = checkpoint
        self._marks: Final = Marks()
        self._lanes: Final = Lanes()
        self._stopping: Final = asyncio.Event()
        self._history: Final = History(self._bus, self._stopping)
        self._signals: Final[asyncio.Queue[WeaveApplied]] = asyncio.Queue()
        self._commanded: Final[asyncio.Queue[Frame]] = asyncio.Queue()
        self._doing: Final[list[asyncio.Task[None]]] = []

    # ── From the way in to the way out ─────────────────────────────────

    async def __aenter__(self) -> Self:
        # Every frame the transport delivers from here on is handed over as it is delivered, whatever its channel:
        # one stream, in the order of delivery.
        self._transport.bridge_into(_Delivered(self))
        loop = asyncio.get_running_loop()
        self._doing.extend(loop.create_task(work) for work in (self._answer_rebuilds(), self._signal(), self._keep_marks()))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._stopping.set()
        for task in self._doing:
            task.cancel()
        await asyncio.gather(*self._doing, return_exceptions=True)
        await self._lanes.aclose()
        await self._keep()

    # ── What it says of itself ─────────────────────────────────────────

    @property
    def apply_failures(self) -> int:
        """How many events it could not apply, since it started."""
        return self._marks.failures

    def applied(self) -> dict[str, int]:
        """The sequence number it has applied up to, for each resource it has applied anything of."""
        return self._marks.all()

    async def settled(self) -> None:
        """Wait until every command it was sent is answered, every event it was handed applied, and every mark that rose signalled.

        What a test waits on. Nothing of the service does: a Weaver that is
        following is never done.
        """
        await self._commanded.join()
        await self._lanes.settled()
        await self._signals.join()

    # ── Following ──────────────────────────────────────────────────────

    def delivered(self, frame: Frame) -> None:
        """Take a frame the transport delivered: a followed event goes to its resource's lane, and a rebuild command waits its turn."""
        if frame.channel == WEAVE_REBUILD.name:
            self._commanded.put_nowait(frame)
            return
        try:
            event = stored_event(frame)
        except ValidationError as unread:
            # Nobody's to act on. Which resource it was of cannot be said, so no mark is held back for it.
            LOG.error("A frame on a followed channel is not a recorded event", extra={"channel": frame.channel, "error": words_of(unread)})
            return
        if event is not None:
            self._hand(event)

    def _hand(self, event: StoredEventResponse) -> None:
        self._lanes.put(event.resource_id or _NO_RESOURCE, partial(self._apply_in_turn, event))

    async def _apply_in_turn(self, event: StoredEventResponse) -> None:
        """Apply an event in its lane, unless it was applied already, and raise its resource's mark."""
        resource, sequence = event.resource_id, event.metadata.sequence_number
        if resource is None:
            await self._apply(event)
            return
        # An event at or below the mark was delivered again. Applied again it would undo what came after it: a
        # resource created again loses its tags and is no longer archived.
        if sequence <= self._marks.of(resource):
            return
        if await self._apply(event):
            self._reach(resource, sequence)

    async def _apply(self, event: StoredEventResponse) -> bool:
        """Apply one event, and say whether it was applied. One that was not is counted, and holds its resource's mark below it."""
        try:
            await apply(self._graph, event)
        except Exception as failure:
            self._marks.missed(event.resource_id, event.metadata.sequence_number)
            LOG.error("Failed to apply event to graph", extra={"event": said_of(event), "error": words_of(failure)})
            return False
        if event.resource_id is not None:
            self._marks.landed(event.resource_id, event.metadata.sequence_number)
        return True

    def _reach(self, resource: ResourceId, sequence: int) -> None:
        """Raise a resource's mark towards `sequence`, and signal the mark it reaches."""
        reached = self._marks.reach(resource, sequence)
        if reached is not None:
            self._signals.put_nowait(WeaveApplied(resource_id=resource, sequence_number=reached))

    async def _signal(self) -> None:
        """Say on `weave:applied` each mark that rose, in the order they rose.

        A signal that is not sent is not sent again. Whoever waits on it
        waits out its own deadline, and reads the graph then.
        """
        while True:
            applied = await self._signals.get()
            try:
                await self._bus.emit(WEAVE_APPLIED, applied)
            except SemiontError as failure:
                LOG.warning(
                    "weave:applied emit failed",
                    extra={"resourceId": applied.resource_id, "sequenceNumber": applied.sequence_number, "error": words_of(failure)},
                )
            finally:
                self._signals.task_done()

    # ── The marks, kept ────────────────────────────────────────────────

    async def _keep_marks(self) -> None:
        while True:
            await asyncio.sleep(_KEEP_SECONDS)
            await self._keep()

    async def _keep(self) -> None:
        """Keep the marks, if one has risen since they were last kept. Marks that cannot be kept are kept the next time."""
        if not self._marks.unsaved:
            return
        self._marks.unsaved = False
        try:
            await self._checkpoint.save(self._marks.all())
        except OSError as failure:
            self._marks.unsaved = True
            LOG.warning("The marks could not be kept", extra={"error": words_of(failure)})

    # ── Catch-up ───────────────────────────────────────────────────────

    async def catch_up(self) -> CaughtUp:
        """Apply what was recorded while the Weaver was not running (`docs/protocol/WEAVER.md` § Catch-up).

        Run once it is following, so that nothing falls between what this
        reads and what arrives. What it replays goes through the lanes, in
        turn with what arrives: an event that reaches a lane both ways is
        applied once.
        """
        missed_before = self._marks.failures
        self._marks.keep(await self._checkpoint.load())
        resources = await self._history.resources()

        replayed = rebuilt = 0
        last_of: dict[str, int] = {}
        for resource in resources:
            events = await self._history.events(resource.id)
            if not events:
                continue
            last = events[-1].metadata.sequence_number
            mark = self._marks.of(resource.id)
            if mark > last:
                # The record is behind the mark: it was rewound. The mark claims what is not so.
                LOG.warning(
                    "Mark above the record's last event: rebuilding the resource",
                    extra={"resourceId": resource.id, "mark": mark, "last": last},
                )
                self._marks.forget(resource.id)
                await self.rebuild_resource(resource.id)
                rebuilt += 1
                continue
            since = [event for event in events if event.metadata.sequence_number > mark]
            if not since:
                continue
            for event in since:
                self._hand(event)
            replayed += len(since)
            last_of[resource.id] = last

        try:
            async with asyncio.timeout(_CATCH_UP_WAITS_SECONDS):
                await self._lanes.settled(set(last_of))
        except TimeoutError:
            LOG.warning("Catch-up stopped waiting for what it replayed: the lanes go on applying it")
        pending = len([resource for resource, last in last_of.items() if self._marks.of(resource) < last])
        self._marks.unsaved = True
        await self._keep()

        caught_up = CaughtUp(
            resources_checked=len(resources),
            events_replayed=replayed,
            resources_rebuilt=rebuilt,
            events_failed=self._marks.failures - missed_before,
            parity_pending=pending,
        )
        if caught_up.events_failed or caught_up.parity_pending:
            LOG.error("Catch-up incomplete: events were not applied", extra=caught_up.said())
        else:
            LOG.info("Catch-up complete", extra=caught_up.said())
        return caught_up

    # ── Reconcile ──────────────────────────────────────────────────────

    async def reconcile(self) -> Reconciled:
        """Find and heal a graph that no longer holds what was applied to it (`docs/protocol/WEAVER.md` § Reconcile).

        Each resource is compared and healed in its own lane, so that neither
        is done in the middle of one of its events.
        """
        resources = await self._history.resources()
        divergent = healed = heal_failures = orphaned = 0
        for resource in resources:
            found = await self._lanes.run(resource.id, partial(self._heal, resource))
            if found is None:
                continue
            divergent += 1
            reason, rebuilt = found
            if rebuilt.events == 0:
                # The catalog lists it and the record holds nothing of it: there is nothing to rebuild it from.
                # Counted as healed, the same divergence would be found and "healed" at every start.
                orphaned += 1
                LOG.warning(
                    "Reconcile found an orphaned view: the record holds no events for this resource, so healing wrote nothing",
                    extra={"resourceId": resource.id, "reason": reason},
                )
            elif rebuilt.failed == 0:
                healed += 1
            else:
                heal_failures += 1

        reconciled = Reconciled(
            resources_checked=len(resources), divergent=divergent, healed=healed, heal_failures=heal_failures, orphaned=orphaned
        )
        if divergent:
            LOG.warning("Reconcile found divergence", extra=reconciled.said())
        else:
            LOG.info("Reconcile complete: the graph holds what the record says", extra=reconciled.said())
        return reconciled

    async def _heal(self, resource: ResourceDescriptor) -> tuple[str, Rebuilt] | None:
        """Rebuild a resource the graph holds wrongly, and say why it was. Nothing for one it holds rightly."""
        reason = await self._divergence_of(resource)
        if reason is None:
            return None
        LOG.warning("Reconcile divergence: healing from the record", extra={"resourceId": resource.id, "reason": reason})
        return reason, await self._rebuild(resource.id)

    async def _divergence_of(self, resource: ResourceDescriptor) -> str | None:
        """How the graph differs from what the record's view says of a resource. Nothing where it does not."""
        held = await self._graph.get_resource(resource.id)
        if held is None:
            return "missing-node"
        if (held.archived or False) != (resource.archived or False):
            return "archived-mismatch"
        if sorted(held.entity_types or ()) != sorted(resource.entity_types or ()):
            return "entity-types-mismatch"

        of_record = {annotation.id: annotation for annotation in await self._history.annotations(resource.id)}
        in_graph = await self._graph.get_resource_annotations(resource.id)
        if {annotation.id for annotation in in_graph} != set(of_record):
            return "annotation-set-mismatch"
        # Each annotation is held to what the codec says the graph is to hold of the record's, and not to the
        # record's itself: the graph is no copy, and a view holds what the graph was never given.
        for annotation in in_graph:
            recorded = of_record[annotation.id]
            if recorded.creator is None:
                # One the graph cannot hold at all. Named as that, and not raised out of a routine check.
                return "annotation-creator-unrecorded"
            if written(annotation) != written(intended_graph_annotation(recorded)):
                return "annotation-content-mismatch"
        return None

    # ── Rebuild ────────────────────────────────────────────────────────

    async def rebuild_resource(self, resource_id: ResourceId) -> Rebuilt:
        """Rebuild one resource from the record, in its lane (`docs/protocol/WEAVER.md` § Rebuild)."""
        return await self._lanes.run(resource_id, partial(self._rebuild, resource_id))

    async def _rebuild(self, resource_id: ResourceId) -> Rebuilt:
        """The graph loses the resource and the annotations on it, and the resource's events are applied again, in order."""
        LOG.info("Rebuilding resource from the record", extra={"resourceId": resource_id})
        await self._graph.delete_resource(resource_id)
        events = await self._history.events(resource_id)
        failed = 0
        for event in events:
            if not await self._apply(event):
                failed += 1
        if events and failed == 0:
            self._reach(resource_id, events[-1].metadata.sequence_number)
        if failed:
            LOG.error(
                "Rebuild left events not applied: the graph is incomplete for this resource",
                extra={"resourceId": resource_id, "failed": failed},
            )
        return Rebuilt(events=len(events), failed=failed)

    async def rebuild_all(self) -> Rebuilt:
        """Rebuild the whole graph from the record, with no lane working (`docs/protocol/WEAVER.md` § Rebuild)."""
        async with self._lanes.alone():
            LOG.info("Rebuilding the whole graph from the record")
            await self._graph.clear_database()

            applied = failed = 0
            for resource in await self._history.resources():
                events = await self._history.events(resource.id)
                missed = 0
                for event in events:
                    if not await self._apply(event):
                        missed += 1
                applied += len(events)
                failed += missed
                if events and missed == 0:
                    self._reach(resource.id, events[-1].metadata.sequence_number)
            if failed:
                LOG.error("Rebuild left events not applied: the graph is incomplete", extra={"failed": failed})
            return Rebuilt(events=applied, failed=failed)

    async def _answer_rebuilds(self) -> None:
        """Answer each `weave:rebuild`, one at a time: a rebuild is never done beside another."""
        while True:
            commanded = await self._commanded.get()
            try:
                await self._answer_rebuild(commanded)
            finally:
                self._commanded.task_done()

    async def _answer_rebuild(self, commanded: Frame) -> None:
        try:
            rebuild = decoded(WEAVE_REBUILD, commanded.payload)
        except ValidationError as unread:
            LOG.error("A weave:rebuild that is no rebuild command was passed by", extra={"error": words_of(unread)})
            return
        try:
            rebuilt = await (self.rebuild_all() if rebuild.resource_id is None else self.rebuild_resource(rebuild.resource_id))
            await self._keep()
            if rebuilt.failed:
                # A rebuild that left events out says so: it never answers for a graph it did not build.
                await self._bus.emit(
                    WEAVE_REBUILD_FAILED,
                    CommandError(message=f"rebuild dropped {rebuilt.failed} event(s): the graph is incomplete; see the Weaver's log"),
                    correlation_id=commanded.correlation_id,
                )
            else:
                await self._bus.emit(WEAVE_REBUILD_OK, Empty(), correlation_id=commanded.correlation_id)
        except Exception as failure:
            LOG.error("Rebuild command failed", extra={"resourceId": rebuild.resource_id, "error": words_of(failure)})
            try:
                await self._bus.emit(WEAVE_REBUILD_FAILED, CommandError(message=str(failure)), correlation_id=commanded.correlation_id)
            except SemiontError as unsaid:
                LOG.error("The rebuild's failure could not be answered", extra={"error": words_of(unsaid)})
