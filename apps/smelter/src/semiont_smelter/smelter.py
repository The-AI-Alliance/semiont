"""The Smelter: what follows the record, keeps the vector index and the anchored-text store in step with it, and repairs what it missed.

`docs/protocol/SMELTER.md` states what it does, rule by rule. Held with
`async with`: it follows the record from the way in to the way out. Its two
other pieces of work are asked of it: `reconcile`, which a service runs once
when it starts, and a rebuild of anchored text, which it answers when it is
commanded on `smelt:rebuild-anchors`.

It reaches four things, each handed to it: the index and the embedding
provider (`semiont_vectors`), a resource's bytes (`semiont_service.content`),
the anchored-text store, and everything else through the transport. It opens
no file of the record and knows no address.

**The order it works in.** Every frame the transport delivers is taken as it
is delivered, whatever its channel. A resource's events are applied one at a
time, in the order they arrived, in a lane of the resource's own
(`semiont_service.lanes`), and the lanes work beside each other. Nothing is
held back: an event is applied when its lane reaches it. One thing is
gathered: the `mark:added` events of a resource that are waiting for their
turn together, with no other event of the resource between them, have one
turn, so that the texts they quote are embedded in one batch. Nothing waits
for more of them to arrive. The work a start plans, and a rebuild's, takes
its turn in the same lanes.

**What a start plans is looked at again where the record has moved.** A
reconcile plans from what it read, and does the work afterwards. A piece of
that work whose resource an event has arrived for since is not done as it
was planned: it asks the record again, and does what the record wants now.
One the record no longer wants is not done, and a line of the log says so.

**One resource is declined in one place.** `_conclude` is the only way a
resource that was to be indexed is not, and it does what every such decision
owes: a line of the log, always; and for a decline, the points taken out and
the decision signalled. `tests/test_census.py` holds that nothing else makes
a `_Concluded`.

**A checksum is the SHA-256 of the bytes read, in lower-case hex**, as the
Archivist writes the checksum of a representation. The points carry it, an
anchored-text entry is filed under it, and `smelt:settled` states it.
"""

import asyncio
import hashlib
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from types import TracebackType
from typing import Final, Literal, Self, assert_never, final, override

from pydantic import JsonValue, ValidationError
from semiont.annotations import annotation_exact_text, entity_types
from semiont.bus import Bus, decoded
from semiont.channel import Empty
from semiont.channels import (
    MARK_ADDED,
    MARK_BODY_UPDATED,
    MARK_REMOVED,
    SMELT_REBUILD_ANCHORS,
    SMELT_REBUILD_ANCHORS_FAILED,
    SMELT_REBUILD_ANCHORS_OK,
    SMELT_SETTLED,
)
from semiont.errors import SemiontError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.media_types import text_source_of, yields_geometry_of
from semiont.resources import decode_representation
from semiont.transport import Frame, FrameSink, Transport
from semiont.types import (
    Annotation,
    CommandError,
    ExtractionDeclined,
    ExtractionOutcome,
    SmeltSettled,
    SmeltSettledReason,
    StoredEventResponse,
)
from semiont_service.content import Content, ContentReads, ContentUnread
from semiont_service.lanes import Lanes
from semiont_service.white_space import trimmed
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import AnnotationPayload, AnnotationStamp, Declined, EmbeddingChunk, VectorStore

from semiont_smelter.anchored_text_store import AnchoredTextStore
from semiont_smelter.chunking import Chunking, chunk_text
from semiont_smelter.extraction import PdfExtractor
from semiont_smelter.log import LOG, failure_said, words_of
from semiont_smelter.reconcile import (
    Embed,
    EmbedAnnotation,
    Purge,
    PurgeAnnotation,
    Reanchor,
    ReconcileSummary,
    Restamp,
    RestampAnnotation,
    Work,
    classify_embeddable,
    plan_reconcile,
    quotes_text,
)
from semiont_smelter.record import Record
from semiont_smelter.recorded import stored_event

__all__ = ["ReconcileState", "Smelter"]

_WAVE: Final = 8
"""How many pieces of planned work are under way at once: a start that finds an empty index must not ask for everything at once."""

_EMBED: Final = "embed"
"""The kind of the planned work that indexes a resource: the work whose outcome a reconcile counts."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ReconcileState:
    """How far the reconcile of this start has got, and what it came to."""

    phase: Literal["pending", "running", "done", "failed"]
    summary: ReconcileSummary | None = None
    """What it came to, once it is done."""
    error: str | None = None
    """What it failed with, where it failed."""

    def said(self) -> dict[str, JsonValue]:
        """This, as the health endpoint reports it."""
        said: dict[str, JsonValue] = {"phase": self.phase}
        if self.summary is not None:
            said["summary"] = self.summary.said()
        if self.error is not None:
            said["error"] = self.error
        return said


@final
@dataclass(frozen=True, slots=True)
class _Text:
    """A resource's text, the checksum of the bytes it came from, what those bytes were read as, and whether it was read from pixels."""

    text: str
    checksum: str
    content_type: str
    machine_read: bool


@final
@dataclass(frozen=True, slots=True)
class _Declined:
    """Bytes that were read and give no text to index, and why."""

    checksum: str
    content_type: str
    reason: SmeltSettledReason


@final
@dataclass(frozen=True, slots=True)
class _Unread:
    """Bytes that could not be read. Nothing is known of them, so nothing is decided."""

    failure: ContentUnread


@final
@dataclass(frozen=True, slots=True)
class _Concluded:
    """A resource that was to be indexed and was not. Made by `Smelter._conclude`, and by nothing else.

    `reason` is why it was declined. It is `None` for a resource whose bytes
    could not be read, which is no decision.
    """

    reason: SmeltSettledReason | None


@final
class _Failed:
    """What a piece of planned work came to when it raised."""


_FAILED: Final = _Failed()


@final
class _Unwanted:
    """What a piece of planned work came to when, at its turn, the record no longer wanted it: it was not done."""


_UNWANTED: Final = _Unwanted()


@final
@dataclass(frozen=True, slots=True)
class _Piece:
    """One piece of planned work: what kind it is, the lane it takes its turn in, and the work.

    Its lane is what it is about: a resource, or an annotation whose point
    names no resource. Work that indexes a resource answers what that came
    to. Any work answers that it was not wanted, where it was not, and
    nothing otherwise.
    """

    kind: str
    lane: str
    work: Callable[[], Awaitable[_Concluded | _Unwanted | None]]


@final
class _Delivered(FrameSink):
    """Where a Smelter's transport delivers every frame: to the Smelter, as each is delivered."""

    def __init__(self, smelter: "Smelter") -> None:
        self._smelter: Final = smelter

    @override
    def deliver(self, frame: Frame) -> None:
        self._smelter.delivered(frame)


def _checksum(data: bytes) -> str:
    """The checksum of some bytes, as the Archivist writes one: their SHA-256, in lower-case hex."""
    return hashlib.sha256(data).hexdigest()


@final
class Smelter:
    """A Smelter over `index`, asking `provider` for vectors and `content` for bytes, and reaching the knowledge base through `transport`.

    The index is connected and the transport's stream names what a Smelter
    reads before it is entered. Nothing it was handed is closed on the way
    out: each is whoever made it's to close. The way out ends what it follows
    and what its lanes are doing. It does not end a reconcile: whoever began
    one cancels it first.
    """

    def __init__(
        self,
        *,
        index: VectorStore,
        provider: EmbeddingProvider,
        content: ContentReads,
        extractor: PdfExtractor,
        anchored: AnchoredTextStore,
        transport: Transport,
        chunking: Chunking,
    ) -> None:
        self._index: Final = index
        self._provider: Final = provider
        self._content: Final = content
        self._extractor: Final = extractor
        self._anchored: Final = anchored
        self._transport: Final = transport
        self._chunking: Final = chunking
        self._bus: Final = Bus(transport)
        self._lanes: Final = Lanes()
        self._stopping: Final = asyncio.Event()
        self._record: Final = Record(self._bus, self._stopping)
        self._commanded: Final[asyncio.Queue[Frame]] = asyncio.Queue()
        self._draining: Final = asyncio.Lock()
        """Held while planned work is done: a reconcile's and a rebuild's are never done at once."""
        self._doing: Final[list[asyncio.Task[None]]] = []
        self._gathering: Final[dict[str, list[StoredEventResponse]]] = {}
        """By lane, the `mark:added` events that are waiting for one turn: one that arrives while they wait joins them."""
        self._moved: set[ResourceId] | None = None
        """The resources an event has arrived for since the reconcile under way began to read. `None` while none is under way."""
        self._events_processed = 0
        self._reconcile = ReconcileState(phase="pending")

    # ── From the way in to the way out ─────────────────────────────────

    async def __aenter__(self) -> Self:
        # Every frame the transport delivers from here on is handed over as it is delivered, whatever its channel:
        # one stream, in the order of delivery.
        self._transport.bridge_into(_Delivered(self))
        self._doing.append(asyncio.get_running_loop().create_task(self._answer_rebuilds()))
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._stopping.set()
        for task in self._doing:
            task.cancel()
        await asyncio.gather(*self._doing, return_exceptions=True)
        await self._lanes.aclose()

    # ── What it says of itself ─────────────────────────────────────────

    @property
    def events_processed(self) -> int:
        """How many recorded events it has applied since it started. Planned work is not counted."""
        return self._events_processed

    @property
    def reconcile_state(self) -> ReconcileState:
        """How far the reconcile of this start has got."""
        return self._reconcile

    async def settled(self) -> None:
        """Wait until every command it was sent is answered and every event it was handed applied.

        What a test waits on. Nothing of the service does: a Smelter that is
        following is never done.
        """
        await self._commanded.join()
        await self._lanes.settled()

    # ── Following ──────────────────────────────────────────────────────

    def delivered(self, frame: Frame) -> None:
        """Take a frame the transport delivered: a followed event goes to its resource's lane, and a rebuild command waits its turn.

        A `mark:added` joins those of its resource that are waiting for
        their turn, where there are any and no other event of the resource
        has arrived since.
        """
        if frame.channel == SMELT_REBUILD_ANCHORS.name:
            self._commanded.put_nowait(frame)
            return
        try:
            event = stored_event(frame)
        except ValidationError as unread:
            LOG.error("A frame on a followed channel is not a recorded event", extra={"channel": frame.channel, "error": words_of(unread)})
            return
        if event is None:
            return
        if event.resource_id is None:
            # Every event a Smelter follows is a resource's. One that names none says nothing it can act on.
            LOG.error("A followed event names no resource, and was passed by", extra={"type": event.type, "eventId": event.id})
            return
        resource = event.resource_id
        if self._moved is not None:
            self._moved.add(resource)
        waiting = self._gathering.get(resource)
        if event.type == "mark:added" and waiting is not None:
            waiting.append(event)
            return
        together = [event]
        if event.type == "mark:added":
            self._gathering[resource] = together
        else:
            # An event of another kind ends the gathering: a `mark:added` that arrives after it is applied after it.
            self._gathering.pop(resource, None)
        self._lanes.put(resource, partial(self._apply_in_turn, resource, together))

    async def _apply_in_turn(self, resource: ResourceId, together: list[StoredEventResponse]) -> None:
        """Apply, in their lane, the events that have one turn: one event, or the `mark:added` events that waited for it together.

        What fails is logged and passed by, once for each event: what it
        missed is found when the Smelter next starts.
        """
        if self._gathering.get(resource) is together:
            # Their turn has come: one that arrives from here on waits for a turn of its own.
            del self._gathering[resource]
        try:
            await self._apply(resource, together)
        except Exception as failure:
            for event in together:
                LOG.error("Smelter failed to process event", extra={"type": event.type, "resourceId": resource, **failure_said(failure)})
            return
        self._events_processed += len(together)

    async def _apply(self, resource: ResourceId, together: Sequence[StoredEventResponse]) -> None:
        """Do what an event does (`docs/protocol/SMELTER.md` § What each event does).

        `together` is the events of one turn, which are of one type: one
        event, but for `mark:added`. Which resource or annotation changed is
        all that is taken from an event. What a resource's points are made
        of is read afresh.
        """
        event = together[0]
        match event.type:
            case "yield:created" | "yield:cloned" | "yield:updated" | "yield:representation-added":
                await self._index_resource(resource)
            case "mark:archived":
                await self._index.delete_resource_vectors(resource)
                # The annotations on an archived resource are not to be found either, and a start takes their
                # points out: taken out here, what is followed and what a start plans come to the same.
                await self._index.delete_annotation_vectors_for_resource(resource)
                LOG.info("Deleted vectors for archived resource", extra={"resourceId": resource})
            case "mark:unarchived":
                # What the archiving took out, made again from what the record holds now. The resource comes
                # first: an annotation's point reads the mark of text read from pixels off the resource's points.
                await self._index_resource(resource)
                await self._index_annotations(resource, await self._record.annotations(resource))
            case "mark:added":
                annotations = [MARK_ADDED.event(added).annotation for added in together]
                # An annotation has a point only on a resource of the catalog, which an archived one is not: a start
                # takes such a point out, so none is made here. One that quotes no text has no point whatever its
                # resource is, and nothing is asked for it.
                if any(quotes_text(annotation) for annotation in annotations) and not await self._record.archived(resource):
                    await self._index_annotations(resource, annotations)
            case "mark:body-updated":
                await self._restamp_annotations(resource, [MARK_BODY_UPDATED.event(event).annotation_id])
            case "mark:removed":
                await self._unindex_annotation(MARK_REMOVED.event(event).annotation_id)
            case "mark:entity-tag-added" | "mark:entity-tag-removed":
                await self._restamp(resource)
            case _:
                raise ValueError(f"{event.type} is no event a Smelter follows")

    # ── Indexing a resource ────────────────────────────────────────────

    async def _index_resource(self, resource: ResourceId) -> _Concluded | None:
        """Make a resource's points from its bytes as they are now, and signal the decision. Nothing is answered for one that was indexed.

        Every chunk is embedded before any point is written, so a resource
        whose chunks could not all be embedded keeps the points it had.
        """
        read = await self._text_of(resource)
        if not isinstance(read, _Text):
            return await self._conclude(resource, read)
        chunks = chunk_text(read.text, self._chunking)
        types = await self._record.entity_types(resource)
        embeddings = await self._provider.embed_documents(chunks)
        points = [
            EmbeddingChunk(chunk_index=index, text=chunk, embedding=embedding)
            for index, (chunk, embedding) in enumerate(zip(chunks, embeddings, strict=True))
        ]
        await self._index.upsert_resource_vectors(
            resource, points, read.checksum, types, machine_read=read.machine_read, media_type=read.content_type
        )
        await self._settle(SmeltSettled(resource_id=resource, content_checksum=read.checksum, outcome="indexed"))
        LOG.info("Indexed resource", extra={"resourceId": resource, "chunks": len(chunks)})
        return None

    async def _conclude(self, resource: ResourceId, read: _Declined | _Unread) -> _Concluded:
        """Do what is owed for a resource that is not indexed. The only maker of a `_Concluded`.

        The line of the log is written first, so that a step that then fails
        still leaves the decision readable.
        """
        if isinstance(read, _Declined):
            LOG.warning(
                "Smelter did not index resource",
                extra={"resourceId": resource, "reason": read.reason, "contentType": read.content_type, "contentChecksum": read.checksum},
            )
            # A decline is a decision, and the index is made to agree with it: a resource whose bytes give no
            # text keeps no points made from bytes it had before.
            if read.reason == "no-extractor":
                # A type that has no text: the catalog says as much, and a start plans nothing of it.
                await self._index.delete_resource_vectors(resource)
            else:
                # A type that has text, and bytes that gave none: remembered by their checksum, so that a start does
                # not read them again to learn the same.
                declined = Declined(content_checksum=read.checksum, media_type=read.content_type, reason=read.reason)
                await self._index.decline_resource(resource, declined)
            await self._settle(SmeltSettled(resource_id=resource, content_checksum=read.checksum, outcome="skipped", reason=read.reason))
        else:
            # No decision: nothing is signalled and the index is not changed. A signal of `skipped` would tell
            # whoever waits that the resource will never have text, which is not known.
            LOG.warning("Smelter could not read resource content", extra={"resourceId": resource, "error": words_of(read.failure)})
        return _Concluded(reason=read.reason if isinstance(read, _Declined) else None)

    async def _text_of(self, resource: ResourceId) -> _Text | _Declined | _Unread:
        """A resource's text, from its bytes as they are stored now; or why there is none to index.

        The bytes are read and their checksum taken before anything is
        decided, so whatever is decided is said of those bytes. The content
        type says where the text comes from: decoded from the bytes, derived
        from a PDF, or nowhere.
        """
        try:
            content = await self._content.read(resource)
        except ContentUnread as failure:
            return _Unread(failure)
        checksum = _checksum(content.data)
        source = text_source_of(content.content_type)
        match source:
            case "none":
                return _Declined(checksum, content.content_type, "no-extractor")
            case "decode":
                text, machine_read = decode_representation(content.data, content.content_type), False
            case "pdf-text-layer":
                derived = await self._derived(checksum, content)
                if isinstance(derived, ExtractionDeclined):
                    return _Declined(checksum, content.content_type, derived.declined)
                if derived.ocr_confidence is not None and derived.ocr_confidence.low_confidence_words > 0:
                    # How well the pixels were read, which no reader of the index can work out again.
                    LOG.info(
                        "OCR read words it was unsure of",
                        extra={
                            "resourceId": resource,
                            "contentType": content.content_type,
                            "mean": derived.ocr_confidence.mean,
                            "lowConfidenceWords": derived.ocr_confidence.low_confidence_words,
                            "totalWords": derived.ocr_confidence.total_words,
                        },
                    )
                if derived.unread_pages:
                    # The resource is indexed, and a search cannot see these pages.
                    LOG.info(
                        "Partial extraction coverage",
                        extra={"resourceId": resource, "contentType": content.content_type, "unreadPages": derived.unread_pages},
                    )
                text, machine_read = derived.text, derived.method == "ocr"
            case _:
                assert_never(source)
        if trimmed(text) == "":
            return _Declined(checksum, content.content_type, "empty")
        return _Text(text, checksum, content.content_type, machine_read)

    async def _derived(self, checksum: str, content: Content) -> ExtractionOutcome:
        """What deriving a PDF's text comes to, for bytes of this checksum: the stored outcome where there is one, or derived and stored.

        Bytes whose outcome is stored are not derived again, a decline no
        more than a text. An outcome that cannot be stored is still the
        outcome: the entry is found missing when the Smelter next starts.
        """
        held = await self._anchored.read(checksum)
        if held is not None:
            return held
        outcome = await self._extractor.extract(content.data)
        try:
            await self._anchored.write(checksum, outcome)
        except (OSError, ValueError) as failure:
            LOG.warning("An anchored-text entry could not be written", extra={"contentChecksum": checksum, "error": words_of(failure)})
        return outcome

    async def _settle(self, settled: SmeltSettled) -> None:
        """Signal a decision on `smelt:settled`.

        A signal that cannot be sent undoes nothing: whoever waits is left to the end of its own wait.
        """
        try:
            await self._bus.emit(SMELT_SETTLED, settled)
        except SemiontError as failure:
            LOG.warning(
                "Failed to emit smelt:settled",
                extra={"resourceId": settled.resource_id, "outcome": settled.outcome, "error": words_of(failure)},
            )

    async def _restamp(self, resource: ResourceId) -> None:
        """Rewrite the entity types on a resource's points to the resource's entity types as they now are. Nothing is embedded."""
        types = await self._record.entity_types(resource)
        await self._index.update_resource_entity_types(resource, types)
        LOG.info("Restamped resource entity types", extra={"resourceId": resource, "entityTypes": [*types]})

    async def _purge(self, resource: ResourceId) -> None:
        """Take out the points of a resource that is none of the catalog's resources with text, or what is remembered of its decline."""
        await self._index.delete_resource_vectors(resource)
        LOG.info("Reconcile deleted orphan resource vectors", extra={"resourceId": resource})

    async def _reanchor(self, resource: ResourceId) -> None:
        """Derive a resource's anchored text where the store has no entry for its bytes, and store it.

        The entry is filed under the checksum of the bytes read here, and
        not under the one the catalog stated: bytes that changed since are
        described by the entry they get. Nothing is embedded, the index is
        not touched and nothing is signalled. An entry that is there is kept.

        Raises where the bytes cannot be read and where the entry cannot be
        written: here the entry is the work, so a rebuild that could not
        store one says so.
        """
        content = await self._content.read(resource)
        if not yields_geometry_of(content.content_type):
            # Planned from what the catalog said, which the bytes no longer are: there is nothing to derive.
            LOG.info("Re-anchor found no text with places on a page", extra={"resourceId": resource, "contentType": content.content_type})
            return
        checksum = _checksum(content.data)
        if await self._anchored.read(checksum) is not None:
            return
        outcome = await self._extractor.extract(content.data)
        await self._anchored.write(checksum, outcome)
        LOG.info("Re-anchored resource", extra={"resourceId": resource, "contentChecksum": checksum, "outcome": outcome.kind})

    # ── Indexing an annotation ─────────────────────────────────────────

    async def _index_annotations(self, resource: ResourceId, annotations: Sequence[Annotation]) -> None:
        """Make the point of each annotation of one resource that quotes text. One that quotes none, or only white space, has no point.

        The quotes are embedded in one batch, and so in as few requests as
        the provider makes of them. Each point carries the mark of text read
        from pixels its resource's points carry now: an annotation quotes
        its resource's text, and the mark is not worked out again.
        """
        quoting = [annotation for annotation in annotations if quotes_text(annotation)]
        if not quoting:
            return
        quotes = [annotation_exact_text(annotation) for annotation in quoting]
        embeddings = await self._provider.embed_documents(quotes)
        stamp = await self._index.get_resource_stamp(resource)
        machine_read = stamp is not None and stamp.machine_read
        for annotation, quote, embedding in zip(quoting, quotes, embeddings, strict=True):
            await self._index.upsert_annotation_vector(
                embedding,
                AnnotationPayload(
                    annotation_id=annotation.id,
                    resource_id=resource,
                    motivation=annotation.motivation,
                    entity_types=entity_types(annotation),
                    exact_text=quote,
                    machine_read=machine_read,
                ),
            )
            LOG.info("Indexed annotation", extra={"annotationId": annotation.id})

    async def _restamp_annotations(self, resource: ResourceId, wanted: Collection[AnnotationId]) -> None:
        """Rewrite the entity types on the points of these annotations of one resource to those each one's body states now.

        Nothing is embedded: a body changes nothing an annotation quotes. An
        annotation the Archivist no longer answers is passed by, and one that
        has no point is left with none.
        """
        for annotation in await self._record.annotations(resource):
            if annotation.id in wanted:
                types = entity_types(annotation)
                await self._index.update_annotation_entity_types(annotation.id, types)
                LOG.info("Restamped annotation entity types", extra={"annotationId": annotation.id, "entityTypes": types})

    async def _unindex_annotation(self, annotation: AnnotationId) -> None:
        """Take an annotation's point out. Taking out one that is not there changes nothing."""
        await self._index.delete_annotation_vector(annotation)
        LOG.info("Deleted annotation vector", extra={"annotationId": annotation})

    # ── Reconcile ──────────────────────────────────────────────────────

    async def reconcile(self) -> ReconcileSummary:
        """Find what was missed while the Smelter was not running, and what either store lost, and mend it.

        `docs/protocol/SMELTER.md` § Reconcile states the rule.

        Run once it is following, so that nothing falls between what this
        reads and what arrives. What it plans is done in the lanes, in turn
        with what arrives, and a resource's bytes are read afresh when its
        turn comes: what was planned from an old read never puts back bytes
        a later event replaced. A piece planned for a resource that an event
        has arrived for since this began to read asks the record again at
        its turn, and is not done where the record no longer wants it.

        Raises what it failed with, having said so in `reconcile_state`.
        """
        self._reconcile = ReconcileState(phase="running")
        # Before anything is read: an event that arrives from here on may be one the reads did not see.
        self._moved = set()
        try:
            summary = await self._reconciled()
        except Exception as failure:
            self._reconcile = ReconcileState(phase="failed", error=str(failure))
            LOG.error("Reconcile failed", extra={"error": words_of(failure)})
            raise
        finally:
            self._moved = None
        self._reconcile = ReconcileState(phase="done", summary=summary)
        LOG.info("Reconcile complete", extra=summary.said())
        return summary

    async def _reconciled(self) -> ReconcileSummary:
        # The index is read before the catalog: a resource indexed while this runs is then never taken for one
        # that should not be there. The store's keys are one read, and no entry is opened.
        indexed_resources, declined, annotation_points, anchored_keys = await asyncio.gather(
            self._index.list_resource_stamps(), self._index.list_declined(), self._index.list_annotation_stamps(), self._anchored.list()
        )
        resources = await self._record.resources()
        LOG.info(
            "Reconcile started",
            extra={
                "indexedResources": len(indexed_resources),
                "declinedResources": len(declined),
                "indexedAnnotations": len(annotation_points),
                "anchoredEntries": len(anchored_keys),
                "liveResources": len(resources),
            },
        )
        embeddable = classify_embeddable(resources)
        # Every resource of the catalog is asked for its annotations, and not only those with text: a point is
        # taken out when its annotation is on none of them.
        live: list[tuple[ResourceId, Annotation]] = []
        for resource in resources:
            on_it = await self._record.annotations(resource.id)
            live.extend((resource.id, annotation) for annotation in on_it)

        work = plan_reconcile(
            indexed_resources=indexed_resources,
            declined=declined,
            indexed_annotations={annotation: point.entity_types for annotation, point in annotation_points.items()},
            anchored_keys=frozenset(anchored_keys),
            embeddable=embeddable,
            live_annotations=live,
        )
        pieces = self._pieces(work, annotation_points)
        came = await self._drain(pieces)

        embedded = unavailable = failed = 0
        skipped: dict[SmeltSettledReason, int] = {}
        for piece, result in zip(pieces, came, strict=True):
            # A piece that was not wanted when its turn came was not done, and is counted nowhere.
            if piece.kind != _EMBED or isinstance(result, _Unwanted):
                continue
            if result is None:
                embedded += 1
            elif isinstance(result, _Failed):
                failed += 1
            elif result.reason is None:
                unavailable += 1
            else:
                skipped[result.reason] = skipped.get(result.reason, 0) + 1

        return ReconcileSummary(
            resources_embedded=embedded,
            resources_skipped=skipped,
            resources_unavailable=unavailable,
            resources_failed=failed,
            resources_restamped=sum(isinstance(item, Restamp) for item in work),
            resources_reanchored=sum(isinstance(item, Reanchor) for item in work),
            resource_vectors_deleted=sum(isinstance(item, Purge) for item in work),
            annotations_embedded=sum(isinstance(item, EmbedAnnotation) for item in work),
            annotations_restamped=sum(isinstance(item, RestampAnnotation) for item in work),
            annotation_vectors_deleted=sum(isinstance(item, PurgeAnnotation) for item in work),
            resources_eligible=len(embeddable),
            resources_indexed=len(await self._index.list_resource_stamps()),
        )

    def _pieces(self, work: Sequence[Work], points: Mapping[AnnotationId, AnnotationStamp]) -> list[_Piece]:
        """The pieces a plan is done in, in the plan's order.

        `points` is what the index said of each annotation's point when the
        plan was made.

        Each item is a piece, but for the annotations of one resource that
        are indexed, and those whose entity types are rewritten: each of the
        two is one piece, where the first of them was planned. The quotes
        are then embedded in one batch, and the Archivist is asked once.
        """
        pieces: list[_Piece] = []
        indexed: dict[ResourceId, list[Annotation]] = {}
        restamped: dict[ResourceId, list[AnnotationId]] = {}
        for item in work:
            match item:
                case Embed(resource):
                    pieces.append(_Piece(_EMBED, resource, partial(self._index_planned, resource)))
                case Restamp(resource):
                    pieces.append(_Piece("restamp", resource, partial(self._restamp, resource)))
                case Reanchor(resource):
                    pieces.append(_Piece("reanchor", resource, partial(self._reanchor, resource)))
                case Purge(resource):
                    pieces.append(_Piece("purge", resource, partial(self._purge_planned, resource)))
                case EmbedAnnotation(resource, annotation):
                    if resource not in indexed:
                        indexed[resource] = []
                        indexing = partial(self._index_annotations_planned, resource, indexed[resource])
                        pieces.append(_Piece("embed-annotation", resource, indexing))
                    indexed[resource].append(annotation)
                case RestampAnnotation(resource, rewritten):
                    if resource not in restamped:
                        restamped[resource] = []
                        restamping = partial(self._restamp_annotations, resource, restamped[resource])
                        pieces.append(_Piece("restamp-annotation", resource, restamping))
                    restamped[resource].append(rewritten)
                case PurgeAnnotation(gone):
                    # It takes its turn among the events of the resource its point says it is on. A point that names
                    # no resource is no resource's to order it against, and the annotation's own id names its lane.
                    on = points[gone].resource_id
                    pieces.append(_Piece("purge-annotation", gone if on is None else on, partial(self._unindex_planned, on, gone)))
                case _:
                    assert_never(item)
        return pieces

    # ── Planned work, looked at again ──────────────────────────────────

    def _moved_since_planned(self, resource: ResourceId) -> bool:
        """Whether an event of this resource has arrived since the reconcile under way began to read.

        What was planned for a resource no event has arrived for is still
        what the record wants: an event that arrives later takes its turn
        after the piece, and mends what the piece did. What was planned for
        one an event has arrived for may be of a record that has moved.
        """
        return self._moved is not None and resource in self._moved

    def _unwanted(self, kind: str, about: str) -> _Unwanted:
        """Say that a piece of planned work was not done, the record having moved since it was planned, and answer that it was not."""
        LOG.info("Reconcile left planned work undone, which a later event made unwanted", extra={"kind": kind, "about": about})
        return _UNWANTED

    async def _index_planned(self, resource: ResourceId) -> _Concluded | _Unwanted | None:
        """Index a resource a reconcile set out to, unless it has been archived since: an archived resource has no points."""
        if self._moved_since_planned(resource) and await self._record.archived(resource):
            return self._unwanted(_EMBED, resource)
        return await self._index_resource(resource)

    async def _purge_planned(self, resource: ResourceId) -> _Unwanted | None:
        """Take out the points of a resource a reconcile found was none of the catalog's with text, unless it has become one since."""
        if self._moved_since_planned(resource):
            described = await self._record.described(resource)
            if described.archived is not True and classify_embeddable([described]):
                return self._unwanted("purge", resource)
        await self._purge(resource)
        return None

    async def _index_annotations_planned(self, resource: ResourceId, planned: Sequence[Annotation]) -> _Unwanted | None:
        """Index the annotations of one resource a reconcile set out to: those the record still has, on a resource it still lists."""
        if not self._moved_since_planned(resource):
            await self._index_annotations(resource, planned)
            return None
        if await self._record.archived(resource):
            return self._unwanted("embed-annotation", resource)
        wanted = {annotation.id for annotation in planned}
        # Each as the record has it now, which is what an event that arrived since would have indexed.
        still = [annotation for annotation in await self._record.annotations(resource) if annotation.id in wanted]
        for gone in wanted - {annotation.id for annotation in still}:
            self._unwanted("embed-annotation", gone)
        await self._index_annotations(resource, still)
        return None

    async def _unindex_planned(self, resource: ResourceId | None, annotation: AnnotationId) -> _Unwanted | None:
        """Take out the point of an annotation a reconcile found the catalog did not have, unless the catalog has it since."""
        if resource is not None and self._moved_since_planned(resource) and await self._quoting_on(resource, annotation):
            return self._unwanted("purge-annotation", annotation)
        await self._unindex_annotation(annotation)
        return None

    async def _quoting_on(self, resource: ResourceId, annotation: AnnotationId) -> bool:
        """Whether a resource of the catalog has this annotation now, quoting text: whether the annotation is to have a point."""
        if await self._record.archived(resource):
            return False
        return any(held.id == annotation and quotes_text(held) for held in await self._record.annotations(resource))

    async def _drain(self, pieces: Sequence[_Piece]) -> list[_Concluded | _Failed | _Unwanted | None]:
        """Do planned work, at most eight pieces at a time, each in its lane, and answer what each came to, in their order.

        One plan's work is done at a time: a rebuild that is commanded while
        a reconcile's work is being done waits for it, and the other way
        about.
        """
        async with self._draining:
            came: list[_Concluded | _Failed | _Unwanted | None] = []
            for start in range(0, len(pieces), _WAVE):
                came.extend(await asyncio.gather(*(self._do(piece) for piece in pieces[start : start + _WAVE])))
            return came

    async def _do(self, piece: _Piece) -> _Concluded | _Failed | _Unwanted | None:
        """Do one piece of planned work in its lane. One that fails is logged, as an event that fails is, and answered as failed."""
        # It takes its turn as an event of another kind does: a `mark:added` that arrives after it is applied after it.
        self._gathering.pop(piece.lane, None)
        try:
            return await self._lanes.run(piece.lane, piece.work)
        except Exception as failure:
            LOG.error("Smelter failed to do planned work", extra={"kind": piece.kind, "about": piece.lane, **failure_said(failure)})
            return _FAILED

    # ── Rebuild ────────────────────────────────────────────────────────

    async def _answer_rebuilds(self) -> None:
        """Answer each `smelt:rebuild-anchors`, one at a time: a rebuild is never done beside another."""
        while True:
            commanded = await self._commanded.get()
            try:
                await self._answer_rebuild(commanded)
            finally:
                self._commanded.task_done()

    async def _answer_rebuild(self, commanded: Frame) -> None:
        """Derive anchored text again where the store has none, and answer (`docs/protocol/SMELTER.md` § Rebuild).

        Nothing is deleted first, so a rebuild that fails part way has lost
        nothing. One that could not do every resource answers that it
        failed, and says how many of how many: the ones that could be done
        are done.
        """
        try:
            rebuild = decoded(SMELT_REBUILD_ANCHORS, commanded.payload)
        except ValidationError as unread:
            LOG.error("A smelt:rebuild-anchors that is no rebuild command was passed by", extra={"error": words_of(unread)})
            return
        try:
            if rebuild.resource_id is not None:
                resources = [rebuild.resource_id]
            else:
                catalog = classify_embeddable(await self._record.resources())
                resources = [resource for resource, said in catalog.items() if said.yields_geometry]
            LOG.info("Anchored-text rebuild started", extra={"scoped": rebuild.resource_id, "resources": len(resources)})
            came = await self._drain([_Piece("reanchor", resource, partial(self._reanchor, resource)) for resource in resources])
            failed = sum(1 for result in came if isinstance(result, _Failed))
            if failed:
                await self._bus.emit(
                    SMELT_REBUILD_ANCHORS_FAILED,
                    CommandError(message=f"{failed} of {len(resources)} resources failed to re-anchor: see the Smelter's log"),
                    correlation_id=commanded.correlation_id,
                )
                return
            await self._bus.emit(SMELT_REBUILD_ANCHORS_OK, Empty(), correlation_id=commanded.correlation_id)
            LOG.info("Anchored-text rebuild complete", extra={"scoped": rebuild.resource_id, "resources": len(resources)})
        except Exception as failure:
            LOG.error("Anchored-text rebuild failed", extra={"resourceId": rebuild.resource_id, "error": words_of(failure)})
            try:
                unsaid = CommandError(message=str(failure))
                await self._bus.emit(SMELT_REBUILD_ANCHORS_FAILED, unsaid, correlation_id=commanded.correlation_id)
            except SemiontError as unsent:
                LOG.error("The rebuild's failure could not be answered", extra={"error": words_of(unsent)})
