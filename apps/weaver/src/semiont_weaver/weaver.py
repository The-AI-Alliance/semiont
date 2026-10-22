"""The Weaver: what follows the record, applies it to the graph, and repairs what the graph lost.

`docs/protocol/WEAVER.md` states what it does, rule by rule. Held with
`async with`: it follows the record from the way in to the way out, as a
follower of the record (`semiont_service.follower`), each resource's log
taken into the graph by the fold. Its two other pieces of work are asked of
it: `reconcile`, which a service runs once its first sweep is done, and a
rebuild, which it answers when it is commanded on `weave:rebuild`.

It reaches three things, each handed to it: the graph, through the store; the
record, through a reader of it and of a resource's annotations; and the bus,
through the transport. It opens no file of the record and knows no address.
"""

import asyncio
from collections.abc import Sequence
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
from semiont_service.archivist import AnnotationReads
from semiont_service.follower import Cursors, Follower, FromTheFirst, Record, Retaken, Unfinished, recorded

from semiont_weaver.fold import Refused, apply, said_of
from semiont_weaver.history import History
from semiont_weaver.log import LOG

__all__ = ["Reconciled", "Weaver"]


def words_of(failure: BaseException) -> str:
    """A failure, in a line: what kind it is, and what it says."""
    return f"{type(failure).__name__}: {failure}"


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Reconciled:
    """What reconcile found, and did about it."""

    resources_checked: int
    divergent: int
    healed: int
    heal_failures: int
    """The divergent resources whose rebuild stopped at an event it could not apply."""
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
class _Delivered(FrameSink):
    """Where a Weaver's transport delivers every frame: to the Weaver, as each is delivered."""

    def __init__(self, weaver: "Weaver") -> None:
        self._weaver: Final = weaver

    @override
    def deliver(self, frame: Frame) -> None:
        self._weaver.delivered(frame)


@final
class Weaver:
    """A Weaver over `graph`, reaching the knowledge base through `transport`, reading `record` and `annotations`, its cursors in `cursors`.

    The graph is connected and the transport's stream names what a Weaver
    reads (`semiont_weaver.service.CHANNELS`) before it is entered. None of
    them is closed on the way out: they are whoever made them's to close.
    """

    def __init__(
        self, graph: GraphDatabase, transport: Transport, *, record: Record, annotations: AnnotationReads, cursors: Cursors
    ) -> None:
        self._graph: Final = graph
        self._transport: Final = transport
        self._bus: Final = Bus(transport)
        self._stopping: Final = asyncio.Event()
        self._history: Final = History(self._bus, annotations, self._stopping)
        self._signals: Final[asyncio.Queue[WeaveApplied]] = asyncio.Queue()
        self._commanded: Final[asyncio.Queue[Frame]] = asyncio.Queue()
        self._doing: Final[list[asyncio.Task[None]]] = []
        self.follower: Final = Follower(
            record=record,
            take=self._take,
            forget=self._forget,
            follows=frozenset({"resources"}),
            with_no_cursor=FromTheFirst(),
            cursors=cursors,
        )
        """How it follows the record: each resource's log, a log with no cursor taken from its first event."""

    # ── From the way in to the way out ─────────────────────────────────

    async def __aenter__(self) -> Self:
        # Every frame the transport delivers from here on is handed over as it is delivered, whatever its channel:
        # one stream, in the order of delivery. The stream's first opening starts the follower, and each opening after
        # a drop sweeps the record.
        self._transport.bridge_into(_Delivered(self))
        loop = asyncio.get_running_loop()
        works = (self._answer_rebuilds(), self._signal(), self.follower.watch(self._transport.state))
        self._doing.extend(loop.create_task(work) for work in works)
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._stopping.set()
        for task in self._doing:
            task.cancel()
        await asyncio.gather(*self._doing, return_exceptions=True)
        await self.follower.aclose()

    async def settled(self) -> None:
        """Wait until every command it was sent is answered, every event it was handed taken, and every taking signalled.

        What a test waits on. Nothing of the service does: a Weaver that is
        following is never done.
        """
        await self._commanded.join()
        await self.follower.settled()
        await self._signals.join()

    # ── Following ──────────────────────────────────────────────────────

    def delivered(self, frame: Frame) -> None:
        """Take a frame the transport delivered: an event of the record is the follower's, and a rebuild command waits its turn."""
        if frame.channel == WEAVE_REBUILD.name:
            self._commanded.put_nowait(frame)
            return
        try:
            event = recorded(frame)
        except ValidationError as unread:
            # Nobody's to act on. Which log it was of cannot be said: the next sweep reads the record for it.
            LOG.error(
                "A frame on a channel of the record is not a recorded event", extra={"channel": frame.channel, "error": words_of(unread)}
            )
            return
        if event is not None:
            self.follower.delivered(event)

    async def _take(self, run: Sequence[StoredEventResponse]) -> int:
        """Apply a run of one resource's events to the graph, in order, and signal how far it got. Answers how many it refused.

        An event the graph cannot take as recorded is taken as nothing. Any
        other failure stops the run where it is (`Unfinished`): the follower
        holds the resource's log there until its next sweep.
        """
        refused = 0
        for taken, event in enumerate(run):
            try:
                await apply(self._graph, event)
            except Refused as refusal:
                refused += 1
                LOG.error(
                    "An event the graph cannot take as recorded was taken as nothing",
                    extra={"event": said_of(event), "error": str(refusal)},
                )
            except Exception as failure:
                LOG.error("Failed to apply event to graph", extra={"event": said_of(event), "error": words_of(failure)})
                if taken:
                    self._reached(run[taken - 1])
                raise Unfinished(taken=taken, refused=refused) from failure
        self._reached(run[-1])
        return refused

    def _reached(self, event: StoredEventResponse) -> None:
        """Signal that the graph holds its resource's log up to `event`."""
        if event.resource_id is not None:
            self._signals.put_nowait(WeaveApplied(resource_id=event.resource_id, sequence_number=event.metadata.sequence_number))

    async def _forget(self, log: str) -> None:
        """The graph loses a resource and the annotations on it, before its log is taken again from its first event."""
        await self._graph.delete_resource(ResourceId(log))

    async def _signal(self) -> None:
        """Say on `weave:applied` how far each resource's log was taken, in the order it was.

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

    # ── Reconcile ──────────────────────────────────────────────────────

    async def reconcile(self) -> Reconciled:
        """Find and heal a graph that no longer holds what was applied to it (`docs/protocol/WEAVER.md` § Reconcile).

        Each resource is compared in its own lane, and healed there, so that
        neither is done in the middle of one of its events.
        """
        resources = await self._history.resources()
        divergent = healed = heal_failures = orphaned = 0
        for resource in resources:
            reason = await self.follower.in_turn(resource.id, partial(self._divergence_of, resource))
            if reason is None:
                continue
            divergent += 1
            LOG.warning("Reconcile divergence: healing from the record", extra={"resourceId": resource.id, "reason": reason})
            rebuilt = await self.rebuild_resource(resource.id)
            if rebuilt.taken == 0:
                # The catalog lists it and the record holds nothing of it: there is nothing to rebuild it from.
                # Counted as healed, the same divergence would be found and "healed" at every start.
                orphaned += 1
                LOG.warning(
                    "Reconcile found an orphaned view: the record holds no events for this resource, so healing wrote nothing",
                    extra={"resourceId": resource.id, "reason": reason},
                )
            elif rebuilt.stopped:
                heal_failures += 1
            else:
                healed += 1

        reconciled = Reconciled(
            resources_checked=len(resources), divergent=divergent, healed=healed, heal_failures=heal_failures, orphaned=orphaned
        )
        if divergent:
            LOG.warning("Reconcile found divergence", extra=reconciled.said())
        else:
            LOG.info("Reconcile complete: the graph holds what the record says", extra=reconciled.said())
        return reconciled

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

    async def rebuild_resource(self, resource_id: ResourceId) -> Retaken:
        """Rebuild one resource from the record, in its lane (`docs/protocol/WEAVER.md` § Rebuild).

        The graph loses the resource and the annotations on it, and the resource's log is taken again from its first event.
        """
        LOG.info("Rebuilding resource from the record", extra={"resourceId": resource_id})
        rebuilt = await self.follower.again(resource_id)
        if rebuilt.stopped:
            LOG.error(
                "Rebuild stopped at an event it could not apply: the graph is incomplete for this resource",
                extra={"resourceId": resource_id},
            )
        return rebuilt

    async def rebuild_all(self) -> Retaken:
        """Rebuild the whole graph from the record (`docs/protocol/WEAVER.md` § Rebuild).

        The graph is cleared with no lane working, and every resource's log is taken again from its first event.
        """
        LOG.info("Rebuilding the whole graph from the record")
        rebuilt = await self.follower.again_all(self._graph.clear_database)
        if rebuilt.stopped:
            LOG.error("Rebuild stopped at events it could not apply: the graph is incomplete")
        return rebuilt

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
            if rebuilt.stopped:
                # A rebuild that stopped says so: it never answers for a graph it did not build.
                await self._bus.emit(
                    WEAVE_REBUILD_FAILED,
                    CommandError(
                        message="the rebuild stopped at an event it could not apply: the graph is incomplete; see the Weaver's log"
                    ),
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
