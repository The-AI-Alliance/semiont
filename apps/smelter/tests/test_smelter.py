"""The Smelter through a rig, rule by rule of `docs/protocol/SMELTER.md`.

The sections here are the page's, in its order, and each test is named for
the rule it holds. The Smelter is a real one (`rig.Rig`), over a transport a
test scripts, an index in the process, a provider that keeps what it was
asked, and an anchored-text store in a directory of the test's. What stands
in for the Archivist is the rig's `World`. A test changes it as a record is
changed, and each change answers its event: delivered, it is a change the
Smelter followed, and kept back, one it missed.

The work a start plans is the table's to hold (`test_reconcile_cases.py`),
and what is so of every history is `test_properties.py`'s. Here each rule is
held once, by the one history that shows it.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import final

import pytest
from aio import hurried, run
from pydantic import JsonValue
from rig import DIMENSIONS, AnnotationPoint, Held, Rig, checksum_of, drawn, scanned
from semiont.errors import BusRequestError, TransportError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.transport import ConnectionState, Frame
from semiont.types import ExtractedText, ExtractionDeclined, SmeltSettledReason
from semiont_service.content import Content
from semiont_vectors.mock import deterministic_vector
from semiont_vectors.store import AnnotationStamp, Declined, EmbeddingChunk, ResourceStamp, SearchFilter, SearchOptions
from spec import JsonObject

from semiont_smelter.chunking import Chunking, chunk_text
from semiont_smelter.extraction import LARGEST_PDF_BYTES
from semiont_smelter.ocr_engine import OcrRead
from semiont_smelter.pdf_reader import PdfEncrypted, PdfUnreadable
from semiont_smelter.reconcile import ReconcileSummary
from semiont_smelter.scripted import ScriptedDocument
from semiont_smelter.smelter import ReconcileState

TEXT = b"Ada Lovelace wrote the first program."
LATER = b"Charles Babbage designed the engine it was for."
NEWER = b"Neither of them saw it run."
LONG = b"Ada Lovelace wrote the first program. Charles Babbage designed the engine it was for. Neither of them saw it run."
"""A text of more than one chunk, when it is cut by `SMALL`."""

SMALL = Chunking(chunk_size=8, overlap=2)

PNG = b"\x89PNG and the bytes of a picture"
PDF = b"%PDF the bytes of a document"
OTHER_PDF = b"%PDF the bytes of another document"
SCAN = b"%PDF the bytes of a scan"
NO_PDF = b"%PDF bytes the reader was told nothing of"
"""Bytes stored as a PDF that are none: a rig's reader opens only the bytes it was told of."""

WRITTEN = drawn("Ada Lovelace wrote the first program")
"""A document with text of its own."""

type Signal = tuple[str, str, str, str | None]
"""A decision as `smelt:settled` says it: the resource, the checksum of its bytes, the outcome, and why, of one that was skipped."""


# ── Reading what a Smelter did ─────────────────────────────────────────


def stamp(data: bytes, *entity_types: str, machine_read: bool = False, media_type: str = "text/markdown") -> ResourceStamp:
    """What a resource's points say of it, when they were made from `data`, read as `media_type`."""
    return ResourceStamp(content_checksum=checksum_of(data), entity_types=entity_types, machine_read=machine_read, media_type=media_type)


def indexed(resource: str, data: bytes) -> Signal:
    """The signal that a resource was indexed from `data`."""
    return (resource, checksum_of(data), "indexed", None)


def skipped(resource: str, data: bytes, reason: str) -> Signal:
    """The signal that a resource whose bytes are `data` was skipped, and why."""
    return (resource, checksum_of(data), "skipped", reason)


def signals(rig: Rig) -> list[Signal]:
    """Each decision the rig's Smelter signalled, in the order it did. A signal says these four things and no other."""
    said: list[Signal] = []
    for payload in rig.signalled():
        assert set(payload) <= {"resourceId", "contentChecksum", "outcome", "reason"}
        resource, checksum = payload["resourceId"], payload["contentChecksum"]
        outcome, reason = payload["outcome"], payload.get("reason")
        assert isinstance(resource, str)
        assert isinstance(checksum, str)
        assert isinstance(outcome, str)
        assert reason is None or isinstance(reason, str)
        said.append((resource, checksum, outcome, reason))
    return said


def applied(rig: Rig) -> int:
    """How many events the rig's Smelter says it has applied."""
    return rig.smelter.events_processed


def lines(caplog: pytest.LogCaptureFixture, level: int) -> list[dict[str, object]]:
    """The facts of each line the Smelter logged at `level`, in order: what was said beside the message, by name."""
    return [dict(vars(record)) for record in caplog.records if record.name == "semiont_smelter" and record.levelno == level]


def came_to(
    *,
    embedded: int = 0,
    skipped: Mapping[SmeltSettledReason, int] | None = None,
    unavailable: int = 0,
    failed: int = 0,
    restamped: int = 0,
    reanchored: int = 0,
    resources_purged: int = 0,
    annotations: int = 0,
    annotations_restamped: int = 0,
    annotations_purged: int = 0,
    eligible: int,
    indexed: int,
) -> ReconcileSummary:
    """What a reconcile came to: none of whatever is not stated."""
    return ReconcileSummary(
        resources_embedded=embedded,
        resources_skipped=skipped or {},
        resources_unavailable=unavailable,
        resources_failed=failed,
        resources_restamped=restamped,
        resources_reanchored=reanchored,
        resource_vectors_deleted=resources_purged,
        annotations_embedded=annotations,
        annotations_restamped=annotations_restamped,
        annotation_vectors_deleted=annotations_purged,
        resources_eligible=eligible,
        resources_indexed=indexed,
    )


# ── Saying what a scenario needs ───────────────────────────────────────


def representation_added(updated: JsonObject) -> JsonObject:
    """The event recorded when a resource is given another representation, made of the one a `put` answered: `World` makes none."""
    representation: JsonObject = {"mediaType": "text/markdown"}
    payload: JsonObject = {"representation": representation}
    return {**updated, "type": "yield:representation-added", "payload": payload}


def rebuild(rig: Rig, correlation: str, resource: str | None = None) -> None:
    """Command the rig's Smelter to rebuild anchored text: one resource's, or every resource's when none is named."""
    rig.command("smelt:rebuild-anchors", {} if resource is None else {"resourceId": resource}, correlation_id=correlation)


async def until(holds: Callable[[], bool]) -> None:
    """Give the Smelter its turns until `holds`: a scenario waits on what is to happen, and on no clock. It fails if that never comes."""
    for _ in range(100_000):
        if holds():
            return
        await asyncio.sleep(0)
    raise AssertionError("what the scenario waited on did not come")


async def a_while() -> None:
    """Give the Smelter turns enough to go on with whatever it could: what a scenario does before it says something did not happen."""
    for _ in range(200):
        await asyncio.sleep(0)


def before_each_signal(rig: Rig, monkeypatch: pytest.MonkeyPatch, first: Callable[[], Awaitable[None]]) -> None:
    """Have `first` done before each `smelt:settled` of the rig's Smelter is sent. Where `first` raises, the signal is not sent."""
    emit = rig.transport.emit

    async def emitting(
        channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if channel == "smelt:settled":
            await first()
        return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

    monkeypatch.setattr(rig.transport, "emit", emitting)


def failing_to_write(rig: Rig, monkeypatch: pytest.MonkeyPatch, resource: str) -> None:
    """Have the rig's index fail to write one resource's points, as a database that does not answer."""
    upsert = rig.index.upsert_resource_vectors

    async def refusing(
        resource_id: ResourceId,
        chunks: Sequence[EmbeddingChunk],
        checksum: str,
        types: Sequence[str],
        *,
        machine_read: bool,
        media_type: str,
    ) -> None:
        if resource_id == resource:
            raise ConnectionError("the database did not answer")
        await upsert(resource_id, chunks, checksum, types, machine_read=machine_read, media_type=media_type)

    monkeypatch.setattr(rig.index, "upsert_resource_vectors", refusing)


def holding_the_first_read(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> tuple[asyncio.Event, asyncio.Event]:
    """Have the first read of a resource's bytes wait: the event that is set when that read begins, and the one that lets it go.

    Every read after it is answered as it comes. It is how a scenario holds
    one piece of work open, and sees what is done beside it.
    """
    began, let_go = asyncio.Event(), asyncio.Event()
    read = rig.world.read

    async def reading(resource_id: ResourceId) -> Content:
        if not began.is_set():
            began.set()
            await let_go.wait()
        return await read(resource_id)

    monkeypatch.setattr(rig.world, "read", reading)
    return began, let_go


UNWANTED = "Reconcile left planned work undone, which a later event made unwanted"
"""What the Smelter logs of a piece of planned work it did not do."""


def left_undone(caplog: pytest.LogCaptureFixture) -> list[tuple[str, str]]:
    """Each piece of planned work the Smelter said it left undone, in order: its kind, and what it was about."""
    return [(str(said["kind"]), str(said["about"])) for said in lines(caplog, logging.INFO) if said["msg"] == UNWANTED]


async def planned_and_waiting(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> tuple[asyncio.Future[ReconcileSummary], asyncio.Event]:
    """Begin a reconcile, and hold it where it has read and planned and done none of its work: the reconcile, and what lets its work begin.

    A rebuild of one document's anchored text is begun first and held at the
    read of the document's bytes, and a reconcile's work waits for a
    rebuild's. So an event delivered before the work is let go is one that
    arrived after the reconcile read. The document, `pdf-held`, is a
    resource the reconcile indexes. The rig's reader of PDFs is to know
    `PDF`.
    """
    rig.world.put("pdf-held", PDF, "application/pdf")
    began, let_go = holding_the_first_read(rig, monkeypatch)
    rebuild(rig, "c-held", "pdf-held")
    await until(began.is_set)
    # The last thing a reconcile reads is the annotations of each resource of the catalog, one request for each.
    read_last = len(rig.asked("browse:annotations-requested")) + len(rig.world.catalog(False))
    reconciling = asyncio.ensure_future(rig.smelter.reconcile())
    await until(lambda: len(rig.asked("browse:annotations-requested")) == read_last)
    await a_while()
    return reconciling, let_go


@final
@dataclass(frozen=True, slots=True)
class DeclinedBytes:
    """Bytes a Smelter declines, the type they are stored under, and what a rig's reader and its engine are told of them."""

    data: bytes
    content_type: str
    pdfs: Mapping[bytes, ScriptedDocument | PdfEncrypted | PdfUnreadable]
    reads: Mapping[bytes, OcrRead]


def declined_for(reason: str) -> DeclinedBytes:
    """Bytes that are declined for one of the six reasons."""
    match reason:
        case "no-extractor":
            return DeclinedBytes(PNG, "image/png", {}, {})
        case "empty":
            # Nothing but white space, which U+0085 and U+3000 are.
            return DeclinedBytes(" \n\t\u0085\u3000".encode(), "text/plain", {}, {})
        case "no-text-layer":
            # A scan in which the engine reads nothing.
            document, reads = scanned(3)
            return DeclinedBytes(PDF, "application/pdf", {PDF: document}, reads)
        case "encrypted":
            return DeclinedBytes(PDF, "application/pdf", {PDF: PdfEncrypted("the document asks for a password")}, {})
        case "corrupt":
            return DeclinedBytes(PDF, "application/pdf", {PDF: PdfUnreadable("the bytes are no PDF")}, {})
        case "too-large":
            # Declined by its size alone, before a reader is handed it: the reader is told nothing.
            return DeclinedBytes(bytes(LARGEST_PDF_BYTES + 1), "application/pdf", {}, {})
        case _:
            raise AssertionError(f"{reason} is no reason a resource is skipped for")


# ── What it follows ────────────────────────────────────────────────────


def test_it_reads_what_the_record_holds_from_the_archivist_over_the_bus(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.archive("res-1"),
                rig.world.unarchive("res-1"),
            )
            rig.world.put("res-2", LATER)
            await rig.smelter.reconcile()

            # A resource's description, a resource's annotations and the catalog, and nothing else of the record.
            assert {entry.channel for entry in rig.transport.request_log} == {
                "browse:resource-requested",
                "browse:annotations-requested",
                "browse:resources-requested",
            }
            # The catalog it asks for is of the resources that are not archived, 200 to a page.
            (catalog,) = rig.asked("browse:resources-requested")
            assert catalog["archived"] is False
            assert catalog["offset"] == 0
            assert catalog["limit"] == 200

    run(scenario())


def test_it_answers_one_command_and_emits_one_signal(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.tag("res-1", "Person"),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.put("img-1", PNG, "image/png"),
            )
            rig.world.put("pdf-1", PDF, "application/pdf")
            await rig.smelter.reconcile()
            rebuild(rig, "c-1")
            await rig.settled()

            # Beside what it asks of the Archivist, it says a decision and the answer to a rebuild, and records nothing.
            asked = {entry.channel for entry in rig.transport.request_log}
            assert {frame.channel for frame in rig.transport.emitted} - asked == {"smelt:settled", "smelt:rebuild-anchors-ok"}

    run(scenario())


# ── What each event does ───────────────────────────────────────────────


def test_yield_created_indexes_the_resource(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT)}
            assert held.chunks == {"res-1": (TEXT.decode(),)}
            assert rig.provider.asked == [[TEXT.decode()]]
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


@pytest.mark.parametrize("kind", ["yield:updated", "yield:representation-added"])
def test_an_event_that_gives_a_resource_new_bytes_indexes_it_again(kind: str, tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            updated = rig.world.put("res-1", LATER)

            await rig.happened(updated if kind == "yield:updated" else representation_added(updated))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(LATER)}
            assert held.chunks == {"res-1": (LATER.decode(),)}
            assert signals(rig) == [indexed("res-1", TEXT), indexed("res-1", LATER)]

    run(scenario())


def test_nothing_in_an_events_payload_changes_what_is_indexed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            rig.world.put("res-1", TEXT)
            rig.world.tag("res-1", "Person")
            updated = rig.world.put("res-1", LATER)
            # The event states another checksum, another type and other entity types than the record holds.
            types: list[JsonValue] = ["Nobody"]
            lies: JsonObject = {"contentChecksum": "0" * 64, "format": "image/png", "entityTypes": types, "archived": True}
            lying: JsonObject = {**updated, "payload": lies}

            await rig.happened(lying)

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(LATER, "Person")}
            assert held.chunks == {"res-1": (LATER.decode(),)}
            assert signals(rig) == [indexed("res-1", LATER)]

    run(scenario())


def test_mark_archived_takes_out_the_resources_points_and_those_of_every_annotation_on_it(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
                rig.world.put("res-2", LATER),
                rig.world.annotate("res-2", "ann-3", "Charles Babbage"),
            )

            await rig.happened(rig.world.archive("res-1"))

            held = await rig.held()
            assert held.stamps == {"res-2": stamp(LATER)}
            assert held.annotations == {"ann-3": AnnotationPoint("res-2", "Charles Babbage", (), False)}

    run(scenario())


def test_mark_unarchived_indexes_the_resource_and_then_each_annotation_the_archivist_answers(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
                rig.world.annotate("res-1", "ann-3", None),
                rig.world.archive("res-1"),
            )
            assert await rig.index.count() == 0
            rig.provider.asked.clear()

            await rig.happened(rig.world.unarchive("res-1"))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT)}
            assert held.annotations == {
                "ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False),
                "ann-2": AnnotationPoint("res-1", "the first program", (), False),
            }
            # The resource's chunks first, and then the annotations' quotes, in one request of the provider.
            assert rig.provider.asked == [[TEXT.decode()], ["Ada Lovelace", "the first program"]]
            assert [asked["resourceId"] for asked in rig.asked("browse:annotations-requested")] == ["res-1"]
            assert signals(rig) == [indexed("res-1", TEXT), indexed("res-1", TEXT)]

    run(scenario())


def test_mark_unarchived_indexes_the_annotations_of_a_resource_whose_bytes_it_could_not_read(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.archive("res-1"),
            )
            assert await rig.index.count() == 0
            rig.world.unread.add("res-1")

            await rig.happened(rig.world.unarchive("res-1"))

            held = await rig.held()
            # Nothing is decided of the resource, and it has no points. The annotation the record holds on it has its own.
            assert held.stamps == {}
            assert held.annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


def test_mark_added_indexes_the_annotation_the_event_carries(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            added = rig.world.annotate("res-1", "ann-1", "Ada Lovelace")
            # The Archivist would answer no such annotation by now: what is indexed is what the event carries.
            rig.world.annotations["res-1"].clear()

            await rig.happened(added)

            assert (await rig.held()).annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}
            assert rig.asked("browse:annotations-requested") == []

    run(scenario())


def test_mark_added_makes_no_point_of_an_annotation_on_an_archived_resource(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.archive("res-1"))
            rig.provider.asked.clear()

            await rig.happened(rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))

            # What a start would take out is not put in, and nothing is embedded for it.
            assert (await rig.held()).annotations == {}
            assert rig.provider.asked == []
            assert applied(rig) == 3

            # Unarchived, the resource is indexed with each annotation the Archivist answers, this one among them.
            await rig.happened(rig.world.unarchive("res-1"))

            assert (await rig.held()).annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}

    run(scenario())


def test_mark_added_asks_nothing_of_the_record_for_an_annotation_that_quotes_no_text(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            described = len(rig.asked("browse:resource-requested"))

            await rig.happened(rig.world.annotate("res-1", "ann-1", None))

            assert len(rig.asked("browse:resource-requested")) == described
            assert (await rig.held()).annotations == {}

    run(scenario())


def test_yield_cloned_indexes_the_copy_as_a_resource_of_its_own(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.tag("res-1", "Person"))

            await rig.happened(rig.world.clone("res-2", "res-1"))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT, "Person"), "res-2": stamp(TEXT, "Person")}
            assert held.chunks["res-2"] == (TEXT.decode(),)
            # Its own bytes were read, and what was decided of them is signalled of it.
            assert rig.world.read_of == ["res-1", "res-2"]
            assert signals(rig) == [indexed("res-1", TEXT), indexed("res-2", TEXT)]
            assert applied(rig) == 3

    run(scenario())


def test_mark_body_updated_rewrites_the_entity_types_on_the_annotations_point_and_asks_the_provider_nothing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.annotate("res-1", "ann-1", "Ada Lovelace", tags=["Person"]))
            rig.provider.asked.clear()

            await rig.happened(rig.world.retag("res-1", "ann-1", ["Mathematician", "Person"]))

            # The same point of the same text, with the entity types its body states now, in the body's order.
            assert (await rig.held()).annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", ("Mathematician", "Person"), False)}
            assert rig.provider.asked == []
            # What the body states is asked of the Archivist then.
            assert [asked["resourceId"] for asked in rig.asked("browse:annotations-requested")] == ["res-1"]

            # A body that states none leaves the point with none.
            await rig.happened(rig.world.retag("res-1", "ann-1", []))

            assert (await rig.held()).annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}
            assert applied(rig) == 4

    run(scenario())


def test_mark_body_updated_reads_what_the_body_states_from_the_archivist_and_nothing_of_it_from_the_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))
            first = rig.world.retag("res-1", "ann-1", ["Person"])
            # The body is changed again before the first change's event is applied: the event says less than the record.
            rig.world.retag("res-1", "ann-1", ["Person", "Mathematician"])

            await rig.happened(first)

            assert (await rig.held()).annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", ("Person", "Mathematician"), False)}

    run(scenario())


def test_mark_body_updated_makes_no_point_and_passes_by_an_annotation_the_archivist_no_longer_answers(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", None),
                rig.world.annotate("res-1", "ann-2", "Ada Lovelace"),
            )
            # One quotes no text, and so has no point. The other is removed before its body's event is applied.
            whole, gone = rig.world.retag("res-1", "ann-1", ["Person"]), rig.world.retag("res-1", "ann-2", ["Person"])
            removed = rig.world.unannotate("res-1", "ann-2")
            before = await rig.held()

            await rig.happened(whole, gone)

            # Neither is a failure, and neither changes the index: the removed one keeps its point until its removal arrives.
            assert await rig.held() == before
            assert applied(rig) == 5

            await rig.happened(removed)

            assert (await rig.held()).annotations == {}

    run(scenario())


def test_mark_removed_takes_the_annotations_point_out_and_removing_one_that_is_not_there_changes_nothing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
            )
            removed = rig.world.unannotate("res-1", "ann-1")

            await rig.happened(removed)

            left = await rig.held()
            assert left.annotations == {"ann-2": AnnotationPoint("res-1", "the first program", (), False)}

            # Its point is gone, and it is removed again: an event the Smelter applies, and one that changes nothing.
            await rig.happened(removed)

            assert await rig.held() == left
            assert applied(rig) == 5

    run(scenario())


def test_a_tag_added_or_removed_rewrites_the_entity_types_on_the_points_and_asks_the_provider_nothing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.provider.asked.clear()

            await rig.happened(rig.world.tag("res-1", "Person"))
            assert (await rig.held()).stamps == {"res-1": stamp(TEXT, "Person")}
            await rig.happened(rig.world.tag("res-1", "Author"))
            assert (await rig.held()).stamps == {"res-1": stamp(TEXT, "Person", "Author")}
            await rig.happened(rig.world.untag("res-1", "Person"))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT, "Author")}
            # The points are otherwise as they were: nothing was embedded, and nothing new was decided of the bytes.
            assert held.chunks == {"res-1": (TEXT.decode(),)}
            assert rig.provider.asked == []
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


def test_a_tag_on_a_resource_with_no_points_leaves_it_with_none(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            # The Smelter missed the resource's making, and has no points of it.
            rig.world.put("res-1", TEXT)

            await rig.happened(rig.world.tag("res-1", "Person"))

            assert await rig.index.count() == 0
            assert rig.provider.asked == []
            assert applied(rig) == 1

            # Its entity types are written when it is next indexed.
            await rig.happened(rig.world.put("res-1", LATER))

            assert (await rig.held()).stamps == {"res-1": stamp(LATER, "Person")}

    run(scenario())


# ── Indexing a resource ────────────────────────────────────────────────


def test_the_checksum_on_the_points_and_in_the_signal_is_of_the_bytes_it_read(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            created = rig.world.put("res-1", TEXT)
            # By the time they are read the bytes are others, and the resource's description states the checksum of the first.
            rig.world.content["res-1"] = Content(LATER, "text/markdown")

            await rig.happened(created)

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(LATER)}
            assert held.chunks == {"res-1": (LATER.decode(),)}
            assert signals(rig) == [indexed("res-1", LATER)]

    run(scenario())


@pytest.mark.parametrize("content_type", ["text/plain", "application/json", "text/x-no-registry-lists-it"])
def test_a_type_whose_bytes_are_its_text_is_decoded(content_type: str, tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT, content_type))

            assert (await rig.held()).chunks == {"res-1": (TEXT.decode(),)}
            assert rig.reader.opened == []

    run(scenario())


def test_a_pdfs_text_is_derived_from_the_document(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"))

            derived = await rig.store.read(checksum_of(PDF))
            assert isinstance(derived, ExtractedText)
            assert "Ada Lovelace wrote the first program" in derived.text
            held = await rig.held()
            # Read from the document's own text, and so with no mark of pixels.
            assert held.stamps == {"pdf-1": stamp(PDF, media_type="application/pdf")}
            assert held.chunks == {"pdf-1": (derived.text,)}
            assert rig.reader.opened == [PDF]

    run(scenario())


def test_a_text_is_cut_by_the_two_numbers_of_its_settings_and_every_chunk_is_a_point(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, chunking=SMALL) as rig:
            await rig.happened(rig.world.put("res-1", LONG))

            cut = chunk_text(LONG.decode(), SMALL)
            assert len(cut) > 2
            assert rig.provider.asked == [cut]
            assert (await rig.held()).chunks == {"res-1": tuple(sorted(cut))}
            assert await rig.index.count() == len(cut)

    run(scenario())


def test_a_resource_whose_chunks_could_not_be_embedded_keeps_the_points_it_had_and_nothing_is_signalled(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, chunking=SMALL) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            had = await rig.held()
            rig.provider.failing = True

            await rig.happened(rig.world.put("res-1", LONG))

            # The provider was asked for every chunk of the new text, gave none, and no point was written.
            assert rig.provider.asked[-1] == chunk_text(LONG.decode(), SMALL)
            assert await rig.held() == had
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


def test_a_resource_whose_text_grew_shorter_keeps_no_point_of_the_longer_text(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, chunking=SMALL) as rig:
            await rig.happened(rig.world.put("res-1", LONG))
            assert await rig.index.count() > 2

            await rig.happened(rig.world.put("res-1", b"Ada Lovelace."))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(b"Ada Lovelace.")}
            assert held.chunks == {"res-1": ("Ada Lovelace.",)}
            assert await rig.index.count() == 1

    run(scenario())


def test_a_point_carries_its_chunks_text_the_checksum_of_the_bytes_and_the_resources_entity_types(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            created = rig.world.put("res-1", TEXT)
            rig.world.tag("res-1", "Person")
            rig.world.tag("res-1", "Author")

            await rig.happened(created)

            # The point is found by the vector of its chunk's text, which is what was embedded.
            (point,) = await rig.index.search_resources(deterministic_vector(TEXT.decode(), DIMENSIONS), SearchOptions(limit=10))
            assert point.score == pytest.approx(1.0)
            assert point.resource_id == "res-1"
            assert point.text == TEXT.decode()
            assert point.entity_types == ("Person", "Author")
            assert point.machine_read is False
            assert await rig.index.get_resource_stamp(ResourceId("res-1")) == stamp(TEXT, "Person", "Author")

    run(scenario())


def test_text_read_from_pixels_is_marked_on_every_point_made_from_it(tmp_path: Path) -> None:
    async def scenario() -> None:
        document, reads = scanned(7, "Ada", "Lovelace", "wrote", "it")
        async with Rig(tmp_path, pdfs={SCAN: document}, reads=reads, chunking=Chunking(chunk_size=2, overlap=0)) as rig:
            await rig.happened(rig.world.put("scan-1", SCAN, "application/pdf"))

            derived = await rig.store.read(checksum_of(SCAN))
            assert isinstance(derived, ExtractedText)
            assert derived.method == "ocr"
            assert (await rig.held()).stamps == {"scan-1": stamp(SCAN, machine_read=True, media_type="application/pdf")}
            every = await rig.index.search_resources(deterministic_vector("Ada", DIMENSIONS), SearchOptions(limit=100))
            assert len(every) > 1
            assert all(point.machine_read for point in every)

    run(scenario())


def test_only_a_resource_whose_bytes_gave_text_has_points(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.put("img-1", PNG, "image/png"),
                rig.world.put("res-2", b"  \n\t  ", "text/plain"),
                rig.world.put("pdf-1", NO_PDF, "application/pdf"),
            )

            assert (await rig.held()).stamps == {"res-1": stamp(TEXT)}
            assert await rig.index.count() == 1
            assert rig.provider.asked == [[TEXT.decode()]]

    run(scenario())


# ── Indexing an annotation ─────────────────────────────────────────────


def test_an_annotations_point_is_the_embedding_of_the_text_it_quotes_and_says_what_the_annotation_is(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace", motivation="tagging", tags=["Person", "Author"]),
            )

            assert rig.provider.asked == [[TEXT.decode()], ["Ada Lovelace"]]
            quoted = deterministic_vector("Ada Lovelace", DIMENSIONS)
            (point,) = await rig.index.search_annotations(quoted, SearchOptions(limit=10, filter=SearchFilter(motivation="tagging")))
            assert point.score == pytest.approx(1.0)
            assert point.annotation_id == "ann-1"
            assert point.resource_id == "res-1"
            assert point.text == "Ada Lovelace"
            assert point.entity_types == ("Person", "Author")
            # It is an annotation of that motivation and of no other.
            assert await rig.index.search_annotations(quoted, SearchOptions(limit=10, filter=SearchFilter(motivation="linking"))) == []

    run(scenario())


def test_an_annotation_that_quotes_no_text_or_only_white_space_has_no_point(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.provider.asked.clear()

            await rig.happened(
                rig.world.annotate("res-1", "ann-1", None),
                rig.world.annotate("res-1", "ann-2", ""),
                rig.world.annotate("res-1", "ann-3", " \n\t\u0085\u3000"),
            )

            assert (await rig.held()).annotations == {}
            assert rig.provider.asked == []
            # Each was an event the Smelter applied: an annotation with nothing to embed is no failure.
            assert applied(rig) == 4

    run(scenario())


def test_an_annotation_takes_the_mark_of_pixels_from_its_resources_points_and_works_nothing_out_again(tmp_path: Path) -> None:
    async def scenario() -> None:
        document, reads = scanned(7, "Ada", "Lovelace", "wrote", "it")
        async with Rig(tmp_path, pdfs={SCAN: document}, reads=reads) as rig:
            await rig.happened(rig.world.put("scan-1", SCAN, "application/pdf"), rig.world.annotate("scan-1", "ann-1", "Ada Lovelace"))
            # The same scan under another name, which the Smelter has made no points of: there is no mark to read.
            rig.world.put("scan-2", SCAN, "application/pdf")
            await rig.happened(rig.world.annotate("scan-2", "ann-2", "Ada Lovelace"))

            assert (await rig.held()).annotations == {
                "ann-1": AnnotationPoint("scan-1", "Ada Lovelace", (), True),
                "ann-2": AnnotationPoint("scan-2", "Ada Lovelace", (), False),
            }
            # The bytes were read once, for the resource that was indexed, and for neither annotation.
            assert rig.world.read_of == ["scan-1"]
            assert rig.reader.opened == [SCAN]

    run(scenario())


# ── Order ──────────────────────────────────────────────────────────────


def test_the_events_of_one_resource_are_applied_one_at_a_time_in_the_order_they_arrive(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.put("res-1", TEXT), rig.world.put("res-1", LATER), rig.world.archive("res-1"))

            await until(lambda: len(rig.provider.asked) == 1)
            await a_while()

            # The first is in the provider's hands, and the second has not so much as read the bytes.
            assert rig.world.read_of == ["res-1"]
            assert applied(rig) == 0

            let_go.set()
            await rig.settled()

            assert rig.world.read_of == ["res-1", "res-1"]
            assert len(rig.provider.asked) == 2
            # The archiving arrived last and was applied last: applied before either of the others, it would have left points.
            assert await rig.index.count() == 0
            assert applied(rig) == 3

    run(scenario())


def test_the_mark_added_events_of_a_resource_that_wait_together_have_one_turn_and_one_request_of_the_provider(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.put("res-2", LATER))
            rig.provider.asked.clear()
            described = len(rig.asked("browse:resource-requested"))

            await rig.happened(
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-2", "ann-2", "Charles Babbage"),
                rig.world.annotate("res-1", "ann-3", None),
                rig.world.annotate("res-1", "ann-4", "the first program"),
            )

            # The quotes of one resource's annotations in one request, in the order they arrived; another resource's in its own.
            assert sorted(rig.provider.asked) == [["Ada Lovelace", "the first program"], ["Charles Babbage"]]
            # Each resource is asked once whether it is archived, however many of its annotations waited.
            assert len(rig.asked("browse:resource-requested")) == described + 2
            assert (await rig.held()).annotations == {
                "ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False),
                "ann-2": AnnotationPoint("res-2", "Charles Babbage", (), False),
                "ann-4": AnnotationPoint("res-1", "the first program", (), False),
            }
            # Each was an event the Smelter applied.
            assert applied(rig) == 6

    run(scenario())


def test_an_event_of_another_kind_between_two_mark_added_events_keeps_them_in_turns_of_their_own(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.provider.asked.clear()

            await rig.happened(
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.tag("res-1", "Person"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
            )

            # The tag arrived between them and is applied between them: what arrived after it is not applied before it.
            assert rig.provider.asked == [["Ada Lovelace"], ["the first program"]]
            assert applied(rig) == 4

    run(scenario())


def test_a_mark_added_that_arrives_once_a_turn_has_begun_waits_for_a_turn_of_its_own(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.provider.asked.clear()
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))
            await until(lambda: len(rig.provider.asked) == 1)

            # The first is in the provider's hands. Two more arrive: nothing waited for them, and they wait together.
            rig.deliver(rig.world.annotate("res-1", "ann-2", "the first program"), rig.world.annotate("res-1", "ann-3", "wrote"))
            await a_while()
            assert rig.provider.asked == [["Ada Lovelace"]]

            let_go.set()
            await rig.settled()

            assert rig.provider.asked == [["Ada Lovelace"], ["the first program", "wrote"]]
            assert applied(rig) == 4

    run(scenario())


def test_a_turn_of_several_mark_added_events_that_fails_logs_each_event_and_counts_none(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.provider.failing = True

            await rig.happened(
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
            )

            assert (await rig.held()).annotations == {}
            assert applied(rig) == 1

    with caplog.at_level(logging.ERROR, logger="semiont_smelter"):
        run(scenario())
    assert [(said["type"], said["resourceId"]) for said in lines(caplog, logging.ERROR)] == [("mark:added", "res-1")] * 2


def test_the_work_of_two_resources_is_under_way_at_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.put("res-1", TEXT), rig.world.put("res-2", LATER))

            await until(lambda: len(rig.provider.asked) == 2)

            # Neither is done, and each has been read and handed to the provider.
            assert sorted(rig.world.read_of) == ["res-1", "res-2"]
            assert sorted(rig.provider.texts()) == sorted([TEXT.decode(), LATER.decode()])
            assert await rig.index.count() == 0

            let_go.set()
            await rig.settled()

            assert (await rig.held()).stamps == {"res-1": stamp(TEXT), "res-2": stamp(LATER)}

    run(scenario())


def test_the_index_ends_the_same_whichever_resources_events_are_delivered_first(tmp_path: Path) -> None:
    async def ends(home: Path, *, first: str, second: str) -> Held:
        async with Rig(home) as rig:
            events: dict[str, list[JsonObject]] = {}
            for resource, data in (("res-1", TEXT), ("res-2", LATER)):
                events[resource] = [
                    rig.world.put(resource, data),
                    rig.world.tag(resource, "Person"),
                    rig.world.annotate(resource, f"ann-of-{resource}", "the"),
                ]
            await rig.happened(*events[first], *events[second])
            return await rig.held()

    async def scenario() -> None:
        one_way = await ends(tmp_path / "one", first="res-1", second="res-2")
        the_other = await ends(tmp_path / "other", first="res-2", second="res-1")

        assert one_way == the_other
        assert one_way.stamps == {"res-1": stamp(TEXT, "Person"), "res-2": stamp(LATER, "Person")}
        assert sorted(one_way.annotations) == ["ann-of-res-1", "ann-of-res-2"]

    run(scenario())


def test_an_event_delivered_twice_in_a_row_changes_nothing_the_second_time(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            events = [
                rig.world.put("res-1", TEXT),
                rig.world.tag("res-1", "Person"),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.unannotate("res-1", "ann-1"),
                rig.world.archive("res-1"),
                rig.world.unarchive("res-1"),
            ]
            for event in events:
                await rig.happened(event)
                once = await rig.held()
                points = await rig.index.count()

                await rig.happened(event)

                assert await rig.held() == once
                assert await rig.index.count() == points

    run(scenario())


def test_an_event_that_fails_is_logged_and_passed_by_and_the_next_is_applied(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-2", TEXT))
            rig.provider.failing = True

            # One resource's event fails at the provider. Another resource's, which asks the provider nothing, is applied.
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.tag("res-2", "Person"))

            assert (await rig.held()).stamps == {"res-2": stamp(TEXT, "Person")}
            assert signals(rig) == [indexed("res-2", TEXT)]
            assert applied(rig) == 2

            rig.provider.failing = False
            await rig.happened(rig.world.put("res-1", LATER))

            assert (await rig.held()).stamps == {"res-2": stamp(TEXT, "Person"), "res-1": stamp(LATER)}
            assert applied(rig) == 3

    with caplog.at_level(logging.ERROR, logger="semiont_smelter"):
        run(scenario())
    (failed,) = lines(caplog, logging.ERROR)
    assert failed["type"] == "yield:created"
    assert failed["resourceId"] == "res-1"
    assert "the rig's provider is failing" in str(failed["error"])


def test_planned_work_takes_its_turn_among_a_resources_events_and_puts_back_nothing_a_later_event_changed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            # A resource the Smelter missed the making of, which its start plans to index.
            rig.world.put("res-1", TEXT)
            let_go = asyncio.Event()
            rig.provider.held = let_go
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())
            await until(lambda: len(rig.provider.asked) == 1)

            # The planned work is in the provider's hands with the bytes it read. New bytes are recorded, and their event arrives.
            rig.deliver(rig.world.put("res-1", LATER))
            await a_while()
            assert rig.world.read_of == ["res-1"]

            let_go.set()
            await reconciling
            await rig.settled()

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(LATER)}
            assert held.chunks == {"res-1": (LATER.decode(),)}
            assert signals(rig) == [indexed("res-1", TEXT), indexed("res-1", LATER)]

    run(scenario())


# ── What it decides ────────────────────────────────────────────────────


def test_every_decision_is_signalled_with_the_resource_the_checksum_and_the_outcome(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            await rig.happened(rig.world.put("img-1", PNG, "image/png"))
            await rig.happened(rig.world.put("res-1", LATER))

            assert signals(rig) == [indexed("res-1", TEXT), skipped("img-1", PNG, "no-extractor"), indexed("res-1", LATER)]

    run(scenario())


def test_indexed_is_signalled_once_the_points_are_written(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            at_the_signal: list[Held] = []

            async def look() -> None:
                at_the_signal.append(await rig.held())

            before_each_signal(rig, monkeypatch, look)

            await rig.happened(rig.world.put("res-1", TEXT))

            (held,) = at_the_signal
            assert held.stamps == {"res-1": stamp(TEXT)}
            assert held.chunks == {"res-1": (TEXT.decode(),)}
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


@pytest.mark.parametrize("reason", ["no-extractor", "empty", "no-text-layer", "encrypted", "corrupt", "too-large"])
def test_a_skipped_resource_has_no_points_and_its_reason_is_said(reason: str, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    declined = declined_for(reason)
    checksum = checksum_of(declined.data)

    async def scenario() -> None:
        async with Rig(tmp_path, pdfs=declined.pdfs, reads=declined.reads) as rig:
            # Bytes that give text first: the points made from them are taken out when the resource's bytes give none.
            await rig.happened(rig.world.put("res-1", TEXT))
            assert await rig.index.count() == 1
            rig.provider.asked.clear()

            await rig.happened(rig.world.put("res-1", declined.data, declined.content_type))

            assert await rig.index.count() == 0
            # A decline of a type that has text is remembered, by the bytes and the type. One of a type with none is
            # not: the catalog says that much of it.
            kept = Declined(content_checksum=checksum, media_type=declined.content_type, reason=reason)
            assert (await rig.held()).declined == ({} if reason == "no-extractor" else {"res-1": kept})
            assert signals(rig) == [indexed("res-1", TEXT), ("res-1", checksum, "skipped", reason)]
            assert rig.provider.asked == []

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    (said,) = lines(caplog, logging.WARNING)
    assert said["resourceId"] == "res-1"
    assert said["reason"] == reason
    assert said["contentType"] == declined.content_type
    assert said["contentChecksum"] == checksum


def test_a_decline_is_forgotten_when_the_resource_is_indexed_and_when_it_is_archived(tmp_path: Path) -> None:
    blank = b"  \n\t  "

    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", blank, "text/plain"), rig.world.put("res-2", blank, "text/plain"))
            kept = Declined(content_checksum=checksum_of(blank), media_type="text/plain", reason="empty")
            assert (await rig.held()).declined == {"res-1": kept, "res-2": kept}

            # One is given bytes that have text, and the other is archived: neither is a declined resource of the catalog.
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.archive("res-2"))

            held = await rig.held()
            assert held.declined == {}
            assert held.stamps == {"res-1": stamp(TEXT)}

    run(scenario())


def test_a_skipped_resource_keeps_the_points_of_its_annotations(tmp_path: Path) -> None:
    declined = declined_for("empty")

    async def scenario() -> None:
        async with Rig(tmp_path, pdfs=declined.pdfs, reads=declined.reads) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))

            await rig.happened(rig.world.put("res-1", declined.data, declined.content_type))

            held = await rig.held()
            # The resource's own points are gone. The annotation is still in the record, and quotes what it quotes.
            assert held.stamps == {}
            assert held.annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}

    run(scenario())


def test_bytes_that_could_not_be_read_are_no_decision(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.world.unread.add("res-1")

            await rig.happened(rig.world.put("res-1", LATER), rig.world.put("res-2", LATER))

            held = await rig.held()
            # The points it had are as they were, and nothing was signalled of it. The other resource was indexed.
            assert held.stamps == {"res-1": stamp(TEXT), "res-2": stamp(LATER)}
            assert held.chunks == {"res-1": (TEXT.decode(),), "res-2": (LATER.decode(),)}
            assert signals(rig) == [indexed("res-1", TEXT), indexed("res-2", LATER)]

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    (said,) = lines(caplog, logging.WARNING)
    assert said["resourceId"] == "res-1"
    # It is not said to be skipped: no reason is given for what was not decided.
    assert "reason" not in said


def test_a_signal_that_cannot_be_sent_does_not_undo_what_was_indexed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            refused: list[str] = []

            async def refuse() -> None:
                refused.append("smelt:settled")
                raise TransportError("unavailable", "the gateway did not take the signal")

            before_each_signal(rig, monkeypatch, refuse)

            await rig.happened(rig.world.put("res-1", TEXT))

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT)}
            assert held.chunks == {"res-1": (TEXT.decode(),)}
            # The signal was tried and was not sent, and the event is one the Smelter applied all the same.
            assert refused == ["smelt:settled"]
            assert signals(rig) == []
            assert applied(rig) == 1

    run(scenario())


# ── The anchored-text store ────────────────────────────────────────────


def test_what_deriving_a_pdfs_text_came_to_is_stored_under_the_checksum_a_decline_as_well_as_a_text(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"), rig.world.put("pdf-2", NO_PDF, "application/pdf"))

            text = await rig.store.read(checksum_of(PDF))
            assert isinstance(text, ExtractedText)
            assert "Ada Lovelace wrote the first program" in text.text
            assert await rig.store.read(checksum_of(NO_PDF)) == ExtractionDeclined(kind="declined", declined="corrupt")
            assert await rig.store.list() == sorted([checksum_of(PDF), checksum_of(NO_PDF)])

    run(scenario())


def test_an_entry_is_stored_before_the_decision_is_signalled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            stored: list[list[str]] = []

            async def look() -> None:
                stored.append(await rig.store.list())

            before_each_signal(rig, monkeypatch, look)

            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"))
            await rig.happened(rig.world.put("pdf-2", NO_PDF, "application/pdf"))

            # At each signal the entry of the bytes it speaks of was there: a text's, and then a decline's.
            assert stored == [[checksum_of(PDF)], sorted([checksum_of(PDF), checksum_of(NO_PDF)])]
            assert signals(rig) == [indexed("pdf-1", PDF), skipped("pdf-2", NO_PDF, "corrupt")]

    run(scenario())


def test_text_that_has_no_places_on_a_page_has_no_entry(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.put("res-2", b"  \n\t  ", "text/plain"),
                rig.world.put("img-1", PNG, "image/png"),
            )

            assert await rig.store.list() == []
            assert rig.reader.opened == []

    run(scenario())


def test_bytes_whose_outcome_is_stored_are_not_derived_again_and_the_stored_outcome_is_what_is_indexed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as first:
            await first.happened(first.world.put("pdf-1", PDF, "application/pdf"))
            # The same bytes under another name are opened no second time.
            await first.happened(first.world.put("pdf-2", PDF, "application/pdf"))

            assert first.reader.opened == [PDF]
            derived = (await first.held()).chunks["pdf-1"]
            assert (await first.held()).chunks["pdf-2"] == derived

        # A Smelter over the same store whose reader would make nothing of the bytes: it indexes what the store holds.
        async with Rig(tmp_path, after=first) as later:
            await later.happened(later.world.put("pdf-3", PDF, "application/pdf"))

            assert later.reader.opened == []
            assert (await later.held()).chunks["pdf-3"] == derived
            assert signals(later) == [indexed("pdf-3", PDF)]

    run(scenario())


def test_an_entry_that_cannot_be_written_does_not_stop_the_indexing(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    # Where the store's directory is to be there is a file, so nothing can be written under it.
    home = tmp_path / "taken"
    home.write_bytes(b"")

    async def scenario() -> None:
        async with Rig(home, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"))

            held = await rig.held()
            assert held.stamps == {"pdf-1": stamp(PDF, media_type="application/pdf")}
            assert "Ada Lovelace wrote the first program" in held.chunks["pdf-1"][0]
            assert signals(rig) == [indexed("pdf-1", PDF)]
            assert await rig.store.read(checksum_of(PDF)) is None

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    (said,) = lines(caplog, logging.WARNING)
    assert said["contentChecksum"] == checksum_of(PDF)


# ── Reconcile ──────────────────────────────────────────────────────────


def test_an_empty_index_is_filled_whole_and_a_later_start_plans_nothing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as first:
            world = first.world
            world.put("res-1", TEXT)
            world.tag("res-1", "Person")
            world.put("res-2", LATER)
            world.put("pdf-1", PDF, "application/pdf")
            world.put("img-1", PNG, "image/png")
            world.annotate("res-1", "ann-1", "Ada Lovelace")
            world.annotate("res-2", "ann-2", None)
            # An annotation that quotes text is indexed on any resource of the catalog, one with no text of its own too.
            world.annotate("img-1", "ann-3", "a caption")

            summary = await first.smelter.reconcile()

            assert summary == came_to(embedded=3, annotations=2, eligible=3, indexed=3)
            held = await first.held()
            assert held.stamps == {"res-1": stamp(TEXT, "Person"), "res-2": stamp(LATER), "pdf-1": stamp(PDF, media_type="application/pdf")}
            assert held.annotations == {
                "ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False),
                "ann-3": AnnotationPoint("img-1", "a caption", (), False),
            }
            assert await first.store.list() == [checksum_of(PDF)]
            # Each resource it indexed is signalled, as one indexed by an event is.
            assert set(signals(first)) == {indexed("res-1", TEXT), indexed("res-2", LATER), indexed("pdf-1", PDF)}
            assert len(signals(first)) == 3
            read = len(world.read_of)

        async with Rig(tmp_path, after=first, pdfs={PDF: WRITTEN}) as later:
            assert await later.smelter.reconcile() == came_to(eligible=3, indexed=3)

            assert await later.held() == held
            assert later.provider.asked == []
            assert later.reader.opened == []
            assert len(later.world.read_of) == read
            assert signals(later) == []

    run(scenario())


def test_a_resource_whose_points_carry_another_checksum_than_the_catalog_states_is_indexed_again(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.put("res-2", LATER))
            # New bytes, recorded where the Smelter did not follow.
            rig.world.put("res-1", NEWER)
            rig.provider.asked.clear()

            assert await rig.smelter.reconcile() == came_to(embedded=1, eligible=2, indexed=2)

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(NEWER), "res-2": stamp(LATER)}
            assert held.chunks == {"res-1": (NEWER.decode(),), "res-2": (LATER.decode(),)}
            assert rig.provider.asked == [[NEWER.decode()]]
            assert signals(rig)[2:] == [indexed("res-1", NEWER)]

    run(scenario())


def test_points_that_carry_other_entity_types_have_them_rewritten_and_nothing_is_embedded(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            # A tag, recorded where the Smelter did not follow. It changes no byte.
            rig.world.tag("res-1", "Person")
            rig.provider.asked.clear()

            assert await rig.smelter.reconcile() == came_to(restamped=1, eligible=1, indexed=1)

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(TEXT, "Person")}
            assert held.chunks == {"res-1": (TEXT.decode(),)}
            assert rig.provider.asked == []
            assert rig.world.read_of == ["res-1"]
            assert signals(rig) == [indexed("res-1", TEXT)]

    run(scenario())


def test_a_lost_anchored_text_entry_is_derived_again_and_nothing_is_embedded_or_signalled(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path / "first", pdfs={PDF: WRITTEN}) as first:
            await first.happened(first.world.put("pdf-1", PDF, "application/pdf"))
            had = await first.held()
            derived = await first.store.read(checksum_of(PDF))
            assert isinstance(derived, ExtractedText)

        # The store was cleared while the Smelter was stopped: it starts over a directory with nothing in it.
        async with Rig(tmp_path / "cleared", after=first, pdfs={PDF: WRITTEN}) as later:
            assert await later.store.list() == []

            assert await later.smelter.reconcile() == came_to(reanchored=1, eligible=1, indexed=1)

            assert await later.store.read(checksum_of(PDF)) == derived
            assert later.reader.opened == [PDF]
            assert later.provider.asked == []
            assert await later.held() == had
            assert signals(later) == []

    run(scenario())


def test_points_of_a_resource_that_is_archived_or_gone_or_has_no_text_are_taken_out(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            world = rig.world
            await rig.happened(
                world.put("res-1", TEXT),
                world.put("res-2", TEXT),
                world.put("res-3", TEXT),
                world.put("res-4", TEXT),
                world.annotate("res-1", "ann-1", "Ada Lovelace"),
            )
            # Where the Smelter did not follow: one was archived, one is gone, and one was given bytes of a type that has no text.
            world.archive("res-1")
            world.forget("res-2")
            world.put("res-3", PNG, "image/png")

            assert await rig.smelter.reconcile() == came_to(resources_purged=3, annotations_purged=1, eligible=1, indexed=1)

            held = await rig.held()
            assert held.stamps == {"res-4": stamp(TEXT)}
            # The point of an annotation on the archived resource went with it.
            assert held.annotations == {}

    run(scenario())


def test_an_annotation_with_no_point_is_indexed_and_a_point_with_no_annotation_is_taken_out(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            world = rig.world
            await rig.happened(
                world.put("res-1", TEXT),
                world.annotate("res-1", "ann-1", "Ada Lovelace"),
                world.annotate("res-1", "ann-2", "the first program"),
            )
            # Where the Smelter did not follow: one was removed and three were made, of which one quotes text.
            world.unannotate("res-1", "ann-1")
            world.annotate("res-1", "ann-3", "wrote")
            world.annotate("res-1", "ann-4", " \n\u0085")
            world.annotate("res-1", "ann-5", None)
            rig.provider.asked.clear()

            assert await rig.smelter.reconcile() == came_to(annotations=1, annotations_purged=1, eligible=1, indexed=1)

            assert (await rig.held()).annotations == {
                "ann-2": AnnotationPoint("res-1", "the first program", (), False),
                "ann-3": AnnotationPoint("res-1", "wrote", (), False),
            }
            assert rig.provider.asked == [["wrote"]]

    run(scenario())


def test_where_a_start_indexes_a_resource_and_an_annotation_on_it_the_resource_comes_first(tmp_path: Path) -> None:
    async def scenario() -> None:
        document, reads = scanned(7, "Ada", "Lovelace", "wrote", "it")
        async with Rig(tmp_path, pdfs={SCAN: document}, reads=reads) as rig:
            rig.world.put("scan-1", SCAN, "application/pdf")
            rig.world.annotate("scan-1", "ann-1", "Ada Lovelace")
            rig.world.annotate("scan-1", "ann-2", "wrote it")

            assert await rig.smelter.reconcile() == came_to(embedded=1, annotations=2, eligible=1, indexed=1)

            # Each annotation's point took the mark of pixels from the resource's points, which were there by then.
            assert (await rig.held()).annotations == {
                "ann-1": AnnotationPoint("scan-1", "Ada Lovelace", (), True),
                "ann-2": AnnotationPoint("scan-1", "wrote it", (), True),
            }
            # The resource's chunks were embedded first, and then the two quotes, in one request of the provider.
            assert len(rig.provider.asked) == 2
            assert rig.provider.asked[1] == ["Ada Lovelace", "wrote it"]

    run(scenario())


def test_a_point_that_carries_other_entity_types_than_its_annotations_body_states_has_them_rewritten_and_nothing_is_embedded(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(
                rig.world.put("res-1", TEXT),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program", tags=["Work"]),
            )
            # One body is given an entity type and the other loses its own, and the Smelter misses both events.
            rig.world.retag("res-1", "ann-1", ["Person"])
            rig.world.retag("res-1", "ann-2", [])
            rig.provider.asked.clear()
            asked = len(rig.asked("browse:annotations-requested"))

            assert await rig.smelter.reconcile() == came_to(annotations_restamped=2, eligible=1, indexed=1)

            assert (await rig.held()).annotations == {
                "ann-1": AnnotationPoint("res-1", "Ada Lovelace", ("Person",), False),
                "ann-2": AnnotationPoint("res-1", "the first program", (), False),
            }
            assert rig.provider.asked == []
            # The resource's annotations were asked for to plan, and once more to do the work of both.
            assert len(rig.asked("browse:annotations-requested")) == asked + 2

    run(scenario())


def test_planned_work_whose_resource_no_event_arrived_for_is_done_as_planned_and_asks_the_archivist_nothing_more(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            rig.world.annotate("res-1", "ann-1", "Ada Lovelace")
            described = len(rig.asked("browse:resource-requested"))

            assert await rig.smelter.reconcile() == came_to(annotations=1, eligible=1, indexed=1)

            # Its annotations were asked for once, to plan, and its description not at all.
            assert len(rig.asked("browse:annotations-requested")) == 1
            assert len(rig.asked("browse:resource-requested")) == described

    run(scenario())


def test_an_annotation_removed_after_a_reconcile_read_is_not_put_back_by_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            # Two annotations the Smelter missed the making of: its start plans to index both.
            rig.world.annotate("res-1", "ann-1", "Ada Lovelace")
            rig.world.annotate("res-1", "ann-2", "the first program")
            reconciling, let_go = await planned_and_waiting(rig, monkeypatch)

            # One is removed, and the event arrives before the planned work's turn comes.
            rig.deliver(rig.world.unannotate("res-1", "ann-1"))
            await a_while()
            let_go.set()
            summary = await reconciling
            await rig.settled()

            assert (await rig.held()).annotations == {"ann-2": AnnotationPoint("res-1", "the first program", (), False)}
            # Two were planned, and that is what is counted: the one left undone is counted nowhere.
            assert summary.annotations_embedded == 2

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    assert left_undone(caplog) == [("embed-annotation", "ann-1")]


def test_a_resource_archived_after_a_reconcile_read_is_not_indexed_by_it_and_neither_are_its_annotations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            # A resource and an annotation on it that the Smelter missed the making of: its start plans to index both.
            rig.world.put("res-1", TEXT)
            rig.world.annotate("res-1", "ann-1", "Ada Lovelace")
            reconciling, let_go = await planned_and_waiting(rig, monkeypatch)

            # It is archived, and the event arrives before the planned work's turn comes.
            rig.deliver(rig.world.archive("res-1"))
            await a_while()
            let_go.set()
            summary = await reconciling
            await rig.settled()

            held = await rig.held()
            assert set(held.stamps) == {"pdf-held"}
            assert held.annotations == {}
            assert rig.world.read_of == ["pdf-held", "pdf-held"]
            # The document was indexed. The archived resource is none of the four things an indexing comes to.
            assert (summary.resources_embedded, summary.resources_unavailable, summary.resources_failed) == (1, 0, 0)
            assert summary.resources_skipped == {}

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    assert left_undone(caplog) == [("embed", "res-1"), ("embed-annotation", "res-1")]


def test_points_a_reconcile_planned_to_take_out_are_kept_where_the_catalog_has_their_resource_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))
            # It is archived, and the Smelter misses the event: its start plans to take out its points and its annotation's.
            rig.world.archive("res-1")
            reconciling, let_go = await planned_and_waiting(rig, monkeypatch)

            # It is unarchived, and the event arrives, and is applied, before the planned work's turn comes.
            rig.deliver(rig.world.unarchive("res-1"))
            await a_while()
            let_go.set()
            summary = await reconciling
            await rig.settled()

            held = await rig.held()
            assert held.stamps["res-1"] == stamp(TEXT)
            assert held.annotations == {"ann-1": AnnotationPoint("res-1", "Ada Lovelace", (), False)}
            # What was planned is what is counted.
            assert (summary.resource_vectors_deleted, summary.annotation_vectors_deleted) == (1, 1)

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    assert sorted(left_undone(caplog)) == [("purge", "res-1"), ("purge-annotation", "ann-1")]


def test_a_point_whose_annotation_the_catalog_does_not_have_is_taken_out_in_its_resources_turn(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT), rig.world.annotate("res-1", "ann-1", "Ada Lovelace"))
            # The annotation is removed, and the Smelter misses the event: its start plans to take the point out.
            rig.world.unannotate("res-1", "ann-1")
            let_go = asyncio.Event()
            rig.provider.held = let_go
            # New bytes for the resource, whose indexing is held in the provider's hands when the reconcile begins.
            rig.deliver(rig.world.put("res-1", LATER))
            await until(lambda: len(rig.provider.asked) == 3)
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())
            await until(lambda: rig.asked("browse:resources-requested") != [])
            await a_while()

            # The point is still there: taking it out waits its turn behind the resource's event.
            assert set((await rig.held()).annotations) == {"ann-1"}

            let_go.set()
            await reconciling
            await rig.settled()

            assert (await rig.held()).annotations == {}

    run(scenario())


def test_a_start_does_not_read_again_a_resource_it_remembers_declining(tmp_path: Path) -> None:
    blank = b"  \n\t  "

    async def scenario() -> None:
        async with Rig(tmp_path) as first:
            await first.happened(first.world.put("res-1", blank, "text/plain"), first.world.put("pdf-1", NO_PDF, "application/pdf"))
            had = await first.held()
            assert set(had.declined) == {"res-1", "pdf-1"}
            read = len(first.world.read_of)

        async with Rig(tmp_path, after=first) as later:
            # Each has a type with text, and so is a resource a start would index. Neither is read: each is as it was declined.
            assert await later.smelter.reconcile() == came_to(eligible=2, indexed=0)

            assert await later.held() == had
            assert len(later.world.read_of) == read
            assert signals(later) == []

    run(scenario())


def test_a_start_indexes_a_declined_resource_whose_bytes_changed_and_a_resource_recorded_again_as_another_type(tmp_path: Path) -> None:
    blank = b"  \n\t  "

    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", blank, "text/plain"), rig.world.put("res-2", TEXT, "text/plain"))
            # One is given bytes that have text. The other is recorded again with the bytes it had, as another type.
            # The Smelter misses both.
            rig.world.put("res-1", LATER)
            rig.world.put("res-2", TEXT)
            rig.provider.asked.clear()

            assert await rig.smelter.reconcile() == came_to(embedded=2, eligible=2, indexed=2)

            held = await rig.held()
            assert held.stamps == {"res-1": stamp(LATER), "res-2": stamp(TEXT)}
            assert held.declined == {}
            assert len(rig.provider.asked) == 2

    run(scenario())


def test_a_declined_document_whose_anchored_text_entry_was_lost_has_it_derived_again_and_is_not_indexed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path / "first") as first:
            await first.happened(first.world.put("pdf-1", NO_PDF, "application/pdf"))
            had = await first.held()
            stored = await first.store.read(checksum_of(NO_PDF))
            assert isinstance(stored, ExtractionDeclined)

        # The store was cleared while the Smelter was stopped: it starts over a directory with nothing in it.
        async with Rig(tmp_path / "cleared", after=first) as later:
            assert await later.store.list() == []

            assert await later.smelter.reconcile() == came_to(reanchored=1, eligible=1, indexed=0)

            assert await later.store.read(checksum_of(NO_PDF)) == stored
            assert await later.held() == had
            assert later.provider.asked == []
            assert signals(later) == []

    run(scenario())


def test_reconcile_reads_the_index_before_it_reads_the_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            rig.world.put("res-1", TEXT)
            stamps_read, points_read = rig.index.list_resource_stamps, rig.index.list_annotation_stamps
            catalog_asked: list[int] = []

            async def stamps() -> dict[ResourceId, ResourceStamp]:
                catalog_asked.append(len(rig.asked("browse:resources-requested")))
                return await stamps_read()

            async def points() -> dict[AnnotationId, AnnotationStamp]:
                catalog_asked.append(len(rig.asked("browse:resources-requested")))
                return await points_read()

            monkeypatch.setattr(rig.index, "list_resource_stamps", stamps)
            monkeypatch.setattr(rig.index, "list_annotation_stamps", points)

            await rig.smelter.reconcile()

            # Its two reads of what the index holds came before it asked for the catalog. What it read of the index
            # after is its count of the resources that have points when it ends.
            assert catalog_asked[:2] == [0, 0]
            assert len(rig.asked("browse:resources-requested")) == 1

    run(scenario())


def test_the_work_of_a_reconcile_is_done_at_most_eight_pieces_at_a_time(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            for number in range(1, 13):
                rig.world.put(f"res-{number}", f"The text of resource {number}.".encode())
            let_go = asyncio.Event()
            rig.provider.held = let_go
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())

            await until(lambda: len(rig.provider.asked) >= 8)
            await a_while()

            # Eight are in the provider's hands, and the bytes of no ninth have been read.
            assert len(rig.provider.asked) == 8
            assert len(rig.world.read_of) == 8

            let_go.set()

            assert await reconciling == came_to(embedded=12, eligible=12, indexed=12)
            assert len(rig.world.read_of) == 12

    run(scenario())


def test_a_reconcile_works_on_one_pdf_at_a_time_and_indexes_a_text_beside_it(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")
            rig.world.put("res-1", TEXT)
            let_go = asyncio.Event()
            rig.provider.held = let_go
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())

            await until(lambda: len(rig.provider.asked) == 2)
            await a_while()

            # One PDF's text and the text's are in the provider's hands. The other PDF waits for its turn, and holds
            # nothing of itself while it waits: its bytes have not been read.
            assert len(rig.provider.asked) == 2
            assert len(rig.reader.opened) == 1
            assert len(rig.world.read_of) == 2
            assert "res-1" in rig.world.read_of

            let_go.set()

            assert await reconciling == came_to(embedded=3, eligible=3, indexed=3)
            assert sorted(rig.reader.opened) == sorted([PDF, OTHER_PDF])
            assert sorted(rig.world.read_of) == ["pdf-1", "pdf-2", "res-1"]

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    indexed = [said for said in lines(caplog, logging.INFO) if said["msg"] == "Indexed resource"]
    assert len(indexed) == 3
    # Each line says what the process held as that resource was indexed, where the kernel states it.
    stated = Path("/proc/self/status").exists()
    assert all(isinstance(said["residentBytes"], int) == stated for said in indexed)


def test_pdfs_that_arrive_together_are_indexed_one_at_a_time_and_a_text_beside_them(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(
                rig.world.put("pdf-1", PDF, "application/pdf"),
                rig.world.put("pdf-2", OTHER_PDF, "application/pdf"),
                rig.world.put("res-1", TEXT),
            )

            await until(lambda: len(rig.provider.asked) == 2)
            await a_while()

            assert len(rig.provider.asked) == 2
            assert len(rig.reader.opened) == 1
            assert len(rig.world.read_of) == 2

            let_go.set()
            await rig.settled()

            assert (await rig.held()).stamps == {
                "pdf-1": stamp(PDF, media_type="application/pdf"),
                "pdf-2": stamp(OTHER_PDF, media_type="application/pdf"),
                "res-1": stamp(TEXT),
            }
            assert sorted(rig.reader.opened) == sorted([PDF, OTHER_PDF])

    run(scenario())


def test_bytes_that_are_a_pdf_where_the_description_said_otherwise_are_read_again_in_the_pdf_turn(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.put("pdf-1", PDF, "application/pdf"))
            await until(lambda: len(rig.provider.asked) == 1)

            # Its description says it is a text, and its bytes are a PDF's: they were replaced between the two reads.
            created = rig.world.put("res-1", TEXT)
            rig.world.content["res-1"] = Content(OTHER_PDF, "application/pdf")
            rig.deliver(created)
            await a_while()

            # Read once, found to be a PDF's, and let go of: the PDF in the turn is the only one opened.
            assert rig.world.read_of == ["pdf-1", "res-1"]
            assert rig.reader.opened == [PDF]

            let_go.set()
            await rig.settled()

            assert rig.world.read_of == ["pdf-1", "res-1", "res-1"]
            assert rig.reader.opened == [PDF, OTHER_PDF]
            assert (await rig.held()).stamps["res-1"] == stamp(OTHER_PDF, media_type="application/pdf")

    run(scenario())


def test_a_rebuild_waits_for_the_pdf_an_event_is_indexing(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.put("pdf-1", PDF, "application/pdf"))
            await until(lambda: len(rig.provider.asked) == 1)

            rebuild(rig, "c-1", "pdf-2")
            await a_while()

            # The rebuild's document waits for its turn, and its bytes are read when the turn comes.
            assert rig.reader.opened == [PDF]
            assert rig.world.read_of == ["pdf-1"]
            assert rig.answered("smelt:rebuild-anchors-ok") == []

            let_go.set()
            await rig.settled()

            assert len(rig.answered("smelt:rebuild-anchors-ok")) == 1
            assert rig.reader.opened == [PDF, OTHER_PDF]
            assert sorted(await rig.store.list()) == sorted([checksum_of(PDF), checksum_of(OTHER_PDF)])

    run(scenario())


def test_a_reconcile_reports_what_the_resources_it_set_out_to_index_came_to(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            world = rig.world
            world.put("res-indexed", TEXT)
            world.put("res-empty", b"  \n\t  ", "text/plain")
            world.put("res-corrupt", NO_PDF, "application/pdf")
            world.put("res-unread", LATER)
            world.unread.add("res-unread")
            world.put("res-failed", NEWER)
            failing_to_write(rig, monkeypatch, "res-failed")
            # A resource whose type has no text is none it sets out to index.
            world.put("img-1", PNG, "image/png")

            summary = await rig.smelter.reconcile()

            assert summary == came_to(embedded=1, skipped={"empty": 1, "corrupt": 1}, unavailable=1, failed=1, eligible=5, indexed=1)
            assert (await rig.held()).stamps == {"res-indexed": stamp(TEXT)}
            # A decision is signalled, of a resource a start set out to index as of one an event named. The two that
            # were not decided, the one unread and the one that failed, are not signalled.
            assert set(signals(rig)) == {
                indexed("res-indexed", TEXT),
                skipped("res-empty", b"  \n\t  ", "empty"),
                skipped("res-corrupt", NO_PDF, "corrupt"),
            }
            assert len(signals(rig)) == 3

    run(scenario())


def test_a_reconcile_that_fails_says_so_and_the_smelter_goes_on_following(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            rig.world.put("res-1", TEXT)
            rig.failing.add("browse:resources-requested")

            with pytest.raises(BusRequestError, match="could not answer browse:resources-requested"):
                await rig.smelter.reconcile()

            state = rig.smelter.reconcile_state
            assert state.phase == "failed"
            assert state.summary is None
            assert state.error is not None
            assert "could not answer browse:resources-requested" in state.error

            await rig.happened(rig.world.put("res-2", LATER))

            assert (await rig.held()).stamps == {"res-2": stamp(LATER)}
            assert applied(rig) == 1

    with caplog.at_level(logging.ERROR, logger="semiont_smelter"):
        run(scenario())
    (said,) = lines(caplog, logging.ERROR)
    assert "could not answer browse:resources-requested" in str(said["error"])


def test_reconcile_asks_for_the_catalog_again_while_the_archivist_is_not_there(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            rig.world.put("res-1", TEXT)
            rig.unanswered.add("browse:resources-requested")
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())

            await until(lambda: len(rig.asked("browse:resources-requested")) == 1)
            await a_while()

            assert not reconciling.done()
            assert rig.smelter.reconcile_state == ReconcileState(phase="running")

            # The Archivist is there now. The wait before the catalog is asked for again is by the loop's clock.
            rig.unanswered.clear()

            assert await hurried(reconciling) == came_to(embedded=1, eligible=1, indexed=1)
            assert len(rig.asked("browse:resources-requested")) == 2
            assert (await rig.held()).stamps == {"res-1": stamp(TEXT)}

    run(scenario())


# ── Rebuild ────────────────────────────────────────────────────────────


def test_a_rebuild_naming_a_resource_derives_that_resources_anchored_text_and_no_others(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")

            rebuild(rig, "c-1", "pdf-1")
            await rig.settled()

            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"
            assert rig.answered("smelt:rebuild-anchors-failed") == []
            assert await rig.store.list() == [checksum_of(PDF)]
            assert rig.reader.opened == [PDF]
            assert rig.world.read_of == ["pdf-1"]

    run(scenario())


def test_a_rebuild_naming_none_derives_the_anchored_text_of_every_resource_whose_text_has_places_on_a_page(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")
            rig.world.put("res-1", TEXT)
            rig.world.put("img-1", PNG, "image/png")

            rebuild(rig, "c-all")
            await rig.settled()

            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-all"
            assert rig.answered("smelt:rebuild-anchors-failed") == []
            assert await rig.store.list() == sorted([checksum_of(PDF), checksum_of(OTHER_PDF)])
            assert sorted(rig.world.read_of) == ["pdf-1", "pdf-2"]

    run(scenario())


def test_a_rebuild_keeps_an_entry_that_is_there_and_derives_nothing_for_it(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"))
            entry = await rig.store.read(checksum_of(PDF))
            assert isinstance(entry, ExtractedText)

            rebuild(rig, "c-1", "pdf-1")
            rebuild(rig, "c-2")
            await rig.settled()

            assert [answer.correlation_id for answer in rig.answered("smelt:rebuild-anchors-ok")] == ["c-1", "c-2"]
            # The document was opened once, when the resource was indexed, and by neither rebuild.
            assert rig.reader.opened == [PDF]
            assert await rig.store.read(checksum_of(PDF)) == entry

    run(scenario())


def test_a_rebuild_embeds_nothing_and_does_not_touch_the_index(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path / "first", pdfs={PDF: WRITTEN}) as first:
            await first.happened(first.world.put("pdf-1", PDF, "application/pdf"), first.world.annotate("pdf-1", "ann-1", "Ada Lovelace"))
            had = await first.held()

        # A Smelter over a store with nothing in it, and an index that holds the document's points.
        async with Rig(tmp_path / "cleared", after=first, pdfs={PDF: WRITTEN}) as later:
            rebuild(later, "c-1")
            await later.settled()

            (answer,) = later.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"
            assert await later.store.list() == [checksum_of(PDF)]
            assert later.provider.asked == []
            assert await later.held() == had
            assert signals(later) == []

    run(scenario())


def test_a_rebuild_of_a_document_that_is_declined_is_done_and_its_decline_is_what_is_stored(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: PdfEncrypted("the document asks for a password")}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")

            rebuild(rig, "c-1", "pdf-1")
            await rig.settled()

            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"
            assert rig.answered("smelt:rebuild-anchors-failed") == []
            assert await rig.store.read(checksum_of(PDF)) == ExtractionDeclined(kind="declined", declined="encrypted")

    run(scenario())


def test_a_rebuild_that_could_not_do_every_resource_answers_that_it_failed_and_says_how_many_of_how_many(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")
            rig.world.unread.add("pdf-2")
            # A resource with no such text is none of those a rebuild of everything sets out to do.
            rig.world.put("res-1", TEXT)

            rebuild(rig, "c-1")
            await rig.settled()

            assert rig.answered("smelt:rebuild-anchors-ok") == []
            (answer,) = rig.answered("smelt:rebuild-anchors-failed")
            assert answer.correlation_id == "c-1"
            message = answer.payload["message"]
            assert isinstance(message, str)
            assert "1 of 2" in message
            # The one that could be done is done.
            assert await rig.store.list() == [checksum_of(PDF)]

    run(scenario())


def test_a_rebuild_that_cannot_read_the_catalog_answers_that_it_failed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.failing.add("browse:resources-requested")

            rebuild(rig, "c-1")
            await rig.settled()

            assert rig.answered("smelt:rebuild-anchors-ok") == []
            (answer,) = rig.answered("smelt:rebuild-anchors-failed")
            assert answer.correlation_id == "c-1"
            assert isinstance(answer.payload["message"], str)
            # What it could not list, it did not set out to do.
            assert await rig.store.list() == []

    run(scenario())


def test_rebuilds_are_done_one_at_a_time(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN, OTHER_PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("pdf-2", OTHER_PDF, "application/pdf")
            began, let_go = holding_the_first_read(rig, monkeypatch)

            rebuild(rig, "c-1", "pdf-1")
            await until(began.is_set)
            rebuild(rig, "c-2", "pdf-2")
            await a_while()

            # The second names another resource, whose lane is idle, and still nothing of it is read.
            assert rig.world.read_of == []
            assert rig.answered("smelt:rebuild-anchors-ok") == []

            let_go.set()
            await rig.settled()

            assert [answer.correlation_id for answer in rig.answered("smelt:rebuild-anchors-ok")] == ["c-1", "c-2"]
            assert rig.world.read_of == ["pdf-1", "pdf-2"]

    run(scenario())


def test_a_rebuild_is_not_done_while_the_work_of_a_reconcile_is(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            # A PDF that is indexed already, and a text the reconcile is to index.
            await rig.happened(rig.world.put("pdf-1", PDF, "application/pdf"))
            rig.world.put("res-1", TEXT)
            asked = len(rig.provider.asked)
            let_go = asyncio.Event()
            rig.provider.held = let_go
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())
            await until(lambda: len(rig.provider.asked) == asked + 1)

            # The rebuild names the PDF, whose lane is idle, and still it waits: the reconcile's work is being done.
            rebuild(rig, "c-1", "pdf-1")
            await a_while()

            assert rig.answered("smelt:rebuild-anchors-ok") == []

            let_go.set()

            assert await reconciling == came_to(embedded=1, eligible=2, indexed=2)
            await rig.settled()
            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"

    run(scenario())


def test_the_work_of_a_reconcile_is_not_done_while_a_rebuild_is(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.put("res-1", TEXT)
            began, let_go = holding_the_first_read(rig, monkeypatch)

            # The rebuild's work is under way, held at the read of its resource's bytes.
            rebuild(rig, "c-1", "pdf-1")
            await until(began.is_set)
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())
            await until(lambda: rig.asked("browse:resources-requested") != [])
            await a_while()

            # The reconcile has read the catalog and does none of its work: the text is in another lane, which is
            # idle, and its bytes are not read.
            assert rig.world.read_of == []
            assert rig.provider.asked == []

            let_go.set()

            assert await reconciling == came_to(embedded=2, eligible=2, indexed=2)
            await rig.settled()
            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"

    run(scenario())


def test_a_rebuild_naming_a_resource_with_no_such_text_is_done_with_nothing_derived(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))

            rebuild(rig, "c-1", "res-1")
            await rig.settled()

            (answer,) = rig.answered("smelt:rebuild-anchors-ok")
            assert answer.correlation_id == "c-1"
            assert rig.answered("smelt:rebuild-anchors-failed") == []
            assert await rig.store.list() == []
            assert rig.reader.opened == []

    run(scenario())


def test_a_rebuild_command_that_is_no_command_is_passed_by(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            # It names a resource by a number, which is no id.
            rig.command("smelt:rebuild-anchors", {"resourceId": 7}, correlation_id="c-none")
            rebuild(rig, "c-1")
            await rig.settled()

            # Nothing answers what was no command, and the command after it is answered.
            assert [answer.correlation_id for answer in rig.answered("smelt:rebuild-anchors-ok")] == ["c-1"]
            assert rig.answered("smelt:rebuild-anchors-failed") == []

    with caplog.at_level(logging.ERROR, logger="semiont_smelter"):
        run(scenario())
    assert len(lines(caplog, logging.ERROR)) == 1


# ── Health ─────────────────────────────────────────────────────────────


def test_events_processed_counts_the_events_applied_since_this_start(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as first:
            assert applied(first) == 0

            await first.happened(
                first.world.put("res-1", TEXT),
                first.world.tag("res-1", "Person"),
                first.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                first.world.put("res-2", LATER),
            )

            assert applied(first) == 4

        async with Rig(tmp_path, after=first) as later:
            assert applied(later) == 0

            await later.happened(later.world.untag("res-1", "Person"))

            assert applied(later) == 1

    run(scenario())


def test_events_failed_counts_each_event_delivered_that_could_not_be_applied(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await rig.happened(rig.world.put("res-1", TEXT))
            assert rig.smelter.events_failed == 0

            # One event fails at the provider, and then two that wait for one turn fail together.
            rig.provider.failing = True
            await rig.happened(rig.world.put("res-2", LATER))
            await rig.happened(
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"), rig.world.annotate("res-1", "ann-2", "the first program")
            )

            assert rig.smelter.events_failed == 3

            # A frame that carries no recorded event, and an event that names no resource, are passed by: each is one more.
            rig.provider.failing = False
            unnamed = {name: value for name, value in rig.world.tag("res-1", "Person").items() if name != "resourceId"}
            rig.transport.deliver(Frame(channel="yield:created", payload={"type": "yield:created"}))
            await rig.happened(unnamed)

            assert rig.smelter.events_failed == 5
            assert rig.smelter.events_waiting == 0
            assert applied(rig) == 1

    run(scenario())


def test_events_waiting_counts_what_was_delivered_and_is_neither_applied_nor_failed_yet(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            assert rig.smelter.events_waiting == 0
            let_go = asyncio.Event()
            rig.provider.held = let_go
            rig.deliver(rig.world.put("res-1", TEXT))
            await until(lambda: len(rig.provider.asked) == 1)

            # The first is in the provider's hands. One waits behind it in its resource's lane, and two wait together for one turn.
            rig.deliver(
                rig.world.tag("res-1", "Person"),
                rig.world.annotate("res-1", "ann-1", "Ada Lovelace"),
                rig.world.annotate("res-1", "ann-2", "the first program"),
            )

            assert rig.smelter.events_waiting == 4
            assert applied(rig) == 0

            let_go.set()
            await rig.settled()

            assert rig.smelter.events_waiting == 0
            assert applied(rig) == 4

            # One that fails waits no longer either.
            rig.provider.held = None
            rig.provider.failing = True
            await rig.happened(rig.world.put("res-2", LATER))

            assert (rig.smelter.events_waiting, rig.smelter.events_failed, applied(rig)) == (0, 1, 4)

    run(scenario())


def test_stream_drops_counts_each_time_its_stream_drops_and_says_so(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def becomes(rig: Rig, *states: ConnectionState) -> None:
        for state in states:
            rig.transport.set_state(state)
            await a_while()

    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await a_while()
            assert rig.smelter.stream_drops == 0

            # It drops, is down for long enough to be called degraded, and opens again: one drop, counted when it dropped.
            await becomes(rig, "reconnecting")
            assert rig.smelter.stream_drops == 1
            await becomes(rig, "degraded", "connecting", "open")
            assert rig.smelter.stream_drops == 1

            # One that drops and opens again before the Smelter has looked is a drop too: open, and open again.
            rig.transport.set_state("reconnecting")
            rig.transport.set_state("connecting")
            rig.transport.set_state("open")
            await a_while()
            assert rig.smelter.stream_drops == 2

            # A token that is refused ends the stream as a drop does.
            await becomes(rig, "reconnecting", "unauthenticated")
            assert rig.smelter.stream_drops == 3

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    assert [said["streamDrops"] for said in lines(caplog, logging.WARNING)] == [1, 2, 3]


def test_a_stream_that_is_closed_has_not_dropped(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            await a_while()
            rig.transport.set_state("closed")
            await a_while()

            assert rig.smelter.stream_drops == 0

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    assert lines(caplog, logging.WARNING) == []


def test_reconcile_state_says_how_far_the_reconcile_of_this_start_has_got(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path) as rig:
            rig.world.put("res-1", TEXT)
            assert rig.smelter.reconcile_state == ReconcileState(phase="pending")
            assert rig.smelter.reconcile_state.said() == {"phase": "pending"}

            let_go = asyncio.Event()
            rig.provider.held = let_go
            reconciling = asyncio.ensure_future(rig.smelter.reconcile())
            await until(lambda: len(rig.provider.asked) == 1)

            assert rig.smelter.reconcile_state == ReconcileState(phase="running")

            let_go.set()
            summary = await reconciling

            assert summary == came_to(embedded=1, eligible=1, indexed=1)
            assert rig.smelter.reconcile_state == ReconcileState(phase="done", summary=summary)
            assert rig.smelter.reconcile_state.said() == {"phase": "done", "summary": summary.said()}

    run(scenario())


def test_the_work_of_reconcile_and_of_a_rebuild_is_not_counted_among_the_events_processed(tmp_path: Path) -> None:
    async def scenario() -> None:
        async with Rig(tmp_path, pdfs={PDF: WRITTEN}) as rig:
            rig.world.put("res-1", TEXT)
            rig.world.put("pdf-1", PDF, "application/pdf")
            rig.world.annotate("res-1", "ann-1", "Ada Lovelace")

            await rig.smelter.reconcile()
            rebuild(rig, "c-1")
            await rig.settled()

            assert (await rig.held()).stamps == {"res-1": stamp(TEXT), "pdf-1": stamp(PDF, media_type="application/pdf")}
            assert len(rig.answered("smelt:rebuild-anchors-ok")) == 1
            assert applied(rig) == 0

            await rig.happened(rig.world.tag("res-1", "Person"))

            assert applied(rig) == 1

    run(scenario())
