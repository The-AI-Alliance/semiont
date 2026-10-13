"""A Smelter for a test: a real one, over a transport a test scripts, with its index, its provider and its bytes in the process.

What stands in for the Archivist is `World`: what the knowledge base holds,
which a test changes as the Archivist does when something is recorded. Each
change answers the event the Archivist records of it. A test that delivers
the event is a Smelter that was following when it happened, and one that
does not is a Smelter that missed it.

A checksum here is what the Archivist writes: the SHA-256 of the bytes, in
lower-case hex. The catalog states it of each resource's bytes as they are.
"""

import asyncio
import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Final, Self, final, override

from pydantic import JsonValue
from semiont.identifiers import ResourceId
from semiont.testing import FaultyTransport
from semiont.transport import Frame
from semiont_service.content import Content, ContentReads, ContentUnread
from semiont_vectors.embedding import EmbeddingProvider, EmbeddingProviderError
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.mock import MockEmbeddingProvider, deterministic_vector
from semiont_vectors.store import ResourceStamp, SearchFilter, SearchOptions
from spec import JsonObject

from semiont_smelter.anchored_text_store import AnchoredTextStore
from semiont_smelter.chunking import Chunking
from semiont_smelter.extraction import PdfExtractor
from semiont_smelter.ocr_engine import Box, OcrLine, OcrParagraph, OcrRead, OcrWord
from semiont_smelter.pdf_reader import Matrix, PdfEncrypted, PdfUnreadable, Pixels, Run
from semiont_smelter.scripted import ScriptedDocument, ScriptedImage, ScriptedOcrEngine, ScriptedPage, ScriptedPdfReader
from semiont_smelter.smelter import Smelter

ADA: Final[JsonObject] = {"@type": "Person", "@id": "did:web:example.org:users:ada"}

DIMENSIONS: Final = 8
"""How wide the vectors of a rig's provider are."""

STAMP: Final = "rig-stamp-1"
"""The stamp a rig's anchored-text store writes under."""

WHOLE_PAGE: Final[Matrix] = (612.0, 0.0, 0.0, 792.0, 0.0, 0.0)
"""The matrix that places an image over the whole of a US Letter page."""


def checksum_of(data: bytes) -> str:
    """The checksum of some bytes, as the Archivist writes one."""
    return hashlib.sha256(data).hexdigest()


# ── Stating a PDF ──────────────────────────────────────────────────────


def drawn(*lines: str) -> ScriptedDocument:
    """A document of one page that draws these lines: a document with text of its own."""
    runs: list[Run] = []
    for down, stated in enumerate(lines):
        words = stated.split()
        at = 72.0
        for index, each in enumerate(words):
            width = 6.0 * len(each)
            runs.append(Run(text=each, x=at, y=720.0 - 20.0 * down, width=width, height=12.0, ends_line=index == len(words) - 1))
            at += width + 3.0
    return ScriptedDocument(pages=[ScriptedPage(runs=runs)])


def scanned(mark: int, *words: str) -> tuple[ScriptedDocument, Mapping[bytes, OcrRead]]:
    """A document of one page that paints one image, and what an engine reads of that image: these words, on one line.

    `mark` is the byte the image's pixels are made of: images of two marks
    are two images to an engine. With no words the engine reads nothing.
    """
    pixels = Pixels(width=100, height=100, rgb=bytes([mark]) * 30_000)
    document = ScriptedDocument(pages=[ScriptedPage(images=[ScriptedImage(width=100, height=100, matrix=WHOLE_PAGE, pixels=pixels)])])
    if not words:
        return document, {pixels.rgb: OcrRead()}
    read = [
        OcrWord(text=each, confidence=96.0, box=Box(x0=10.0 + 12.0 * index, y0=10.0, x1=20.0 + 12.0 * index, y1=20.0))
        for index, each in enumerate(words)
    ]
    line = OcrLine(box=Box(x0=10.0, y0=10.0, x1=20.0 + 12.0 * (len(words) - 1), y1=20.0), words=tuple(read))
    return document, {pixels.rgb: OcrRead(paragraphs=(OcrParagraph(lines=(line,)),))}


# ── The knowledge base ─────────────────────────────────────────────────


@final
class World(ContentReads):
    """What the knowledge base holds, as the Archivist answers it: each resource's bytes and description, and the annotations on it.

    It is also what reads a resource's bytes for the Smelter. `unread` names
    the resources whose bytes cannot be read, and `read_of` every resource
    whose bytes were asked for, in order.
    """

    def __init__(self) -> None:
        self.described: Final[dict[str, JsonObject]] = {}
        """Each resource's description, as the catalog answers it. An archived one states `archived`."""
        self.content: Final[dict[str, Content]] = {}
        self.annotations: Final[dict[str, list[JsonObject]]] = {}
        """Each resource's annotations, as a view holds them."""
        self.unread: Final[set[str]] = set()
        self.read_of: Final[list[str]] = []
        self._recorded: Final[dict[str, int]] = {}

    @override
    async def read(self, resource_id: ResourceId) -> Content:
        self.read_of.append(resource_id)
        # A real read waits on a request, and so gives up its turn.
        await asyncio.sleep(0)
        held = self.content.get(resource_id)
        if held is None or resource_id in self.unread:
            raise ContentUnread(f"the bytes of {resource_id} could not be read")
        return held

    def _event(self, kind: str, resource: str, payload: JsonObject) -> JsonObject:
        """The event the Archivist records of a change, at the next place in its resource's record."""
        sequence = self._recorded.get(resource, 0) + 1
        self._recorded[resource] = sequence
        return {
            "id": f"evt-{resource}-{sequence}-{kind}",
            "type": kind,
            "timestamp": "2020-03-04T05:06:07.000Z",
            "userId": "did:web:example.org:users:ada",
            "resourceId": resource,
            "version": 1,
            "payload": payload,
            "metadata": {"sequenceNumber": sequence},
        }

    def _types(self, resource: str) -> list[str]:
        stated = self.described[resource].get("entityTypes")
        assert isinstance(stated, list)
        return [each for each in stated if isinstance(each, str)]

    def _set_types(self, resource: str, types: Sequence[str]) -> None:
        stated: list[JsonValue] = [*types]
        self.described[resource]["entityTypes"] = stated

    def put(self, resource: str, data: bytes, content_type: str = "text/markdown") -> JsonObject:
        """Give a resource these bytes: a new resource (`yield:created`), or new bytes for one there is (`yield:updated`)."""
        there = resource in self.described
        types = self._types(resource) if there else []
        archived = there and self.described[resource].get("archived") is True
        self.content[resource] = Content(data, content_type)
        representation: JsonObject = {"mediaType": content_type, "checksum": checksum_of(data), "byteSize": len(data)}
        representations: list[JsonValue] = [representation]
        self.described[resource] = {
            "@context": "https://schema.org",
            "@id": resource,
            "name": f"Name of {resource}",
            "representations": representations,
        }
        self._set_types(resource, types)
        if archived:
            self.described[resource]["archived"] = True
        if there:
            return self._event("yield:updated", resource, {"contentChecksum": checksum_of(data)})
        name = f"Name of {resource}"
        return self._event(
            "yield:created", resource, {"name": name, "format": content_type, "contentChecksum": checksum_of(data), "wasAttributedTo": ADA}
        )

    def forget(self, resource: str) -> None:
        """Take a resource and its annotations out of the knowledge base, with no event: a resource that is gone."""
        del self.described[resource]
        self.content.pop(resource, None)
        self.annotations.pop(resource, None)

    def tag(self, resource: str, entity_type: str) -> JsonObject:
        self._set_types(resource, [*self._types(resource), entity_type])
        return self._event("mark:entity-tag-added", resource, {"entityType": entity_type})

    def untag(self, resource: str, entity_type: str) -> JsonObject:
        self._set_types(resource, [each for each in self._types(resource) if each != entity_type])
        return self._event("mark:entity-tag-removed", resource, {"entityType": entity_type})

    def archive(self, resource: str) -> JsonObject:
        self.described[resource]["archived"] = True
        return self._event("mark:archived", resource, {})

    def unarchive(self, resource: str) -> JsonObject:
        self.described[resource].pop("archived", None)
        return self._event("mark:unarchived", resource, {})

    def annotate(
        self, resource: str, annotation: str, quote: str | None, *, motivation: str = "linking", tags: Sequence[str] = ()
    ) -> JsonObject:
        """Put an annotation on a resource (`mark:added`). It quotes `quote`, or annotates the resource whole when that is `None`."""
        target: JsonValue = resource if quote is None else {"source": resource, "selector": {"type": "TextQuoteSelector", "exact": quote}}
        stated: JsonObject = {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "type": "Annotation",
            "id": annotation,
            "motivation": motivation,
            "target": target,
            "creator": ADA,
            "created": "2020-03-04T05:06:07.000Z",
        }
        if tags:
            body: list[JsonValue] = [{"type": "TextualBody", "value": tag, "purpose": "tagging"} for tag in tags]
            stated["body"] = body
        self.annotations.setdefault(resource, []).append(stated)
        return self._event("mark:added", resource, {"annotation": stated})

    def unannotate(self, resource: str, annotation: str) -> JsonObject:
        """Take an annotation off a resource (`mark:removed`)."""
        self.annotations[resource] = [held for held in self.annotations.get(resource, []) if held["id"] != annotation]
        return self._event("mark:removed", resource, {"annotationId": annotation})

    def catalog(self, archived: JsonValue) -> list[JsonValue]:
        """The catalog's resources, by what a request states of `archived`: those that are, those that are not, or every one."""
        if archived is None:
            return [*self.described.values()]
        return [described for described in self.described.values() if (described.get("archived") is True) == archived]


# ── The provider ───────────────────────────────────────────────────────


@final
class Provider(EmbeddingProvider):
    """A provider in the process that answers each text with the vector worked out from it, and keeps what it was asked.

    `asked` is the texts of each request, in order. While `failing` it
    answers no request. While `held` is set to an event, a request waits for
    that event before it is answered: what a test holds a resource's work
    open with.
    """

    def __init__(self) -> None:
        self._worked_out: Final = MockEmbeddingProvider(dimensions=DIMENSIONS)
        self.asked: Final[list[list[str]]] = []
        self.failing = False
        self.held: asyncio.Event | None = None

    @override
    async def embed_query(self, text: str) -> list[float]:
        (vector,) = await self.embed_documents([text])
        return vector

    @override
    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        self.asked.append([*texts])
        if self.held is not None:
            await self.held.wait()
        if self.failing:
            raise EmbeddingProviderError(provider="ollama", status=500, reached=True, model="rig", body="the rig's provider is failing")
        return await self._worked_out.embed_documents(texts)

    @override
    async def dimensions(self) -> int:
        return DIMENSIONS

    def texts(self) -> list[str]:
        """Every text it was asked to embed, in order."""
        return [text for request in self.asked for text in request]


# ── What the index holds ───────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class AnnotationPoint:
    """What an annotation's point says: its resource, the text it quotes, its entity types, and whether that text was read from pixels."""

    resource: str
    text: str
    entity_types: tuple[str, ...]
    machine_read: bool


@final
@dataclass(frozen=True, slots=True)
class Held:
    """Everything an index holds, in a form two indexes can be compared by."""

    stamps: Mapping[str, ResourceStamp]
    """The stamp of each resource that has points."""
    chunks: Mapping[str, tuple[str, ...]]
    """The texts of each such resource's points, sorted."""
    annotations: Mapping[str, AnnotationPoint]
    """Each annotation's point, by the annotation's id."""


async def held_by(index: MemoryVectorStore) -> Held:
    """Everything an index holds, read through what a store answers."""
    everything = 100_000
    any_vector = deterministic_vector("anything", DIMENSIONS)
    stamps = await index.list_resource_stamps()
    by_name: dict[str, ResourceStamp] = {}
    chunks: dict[str, tuple[str, ...]] = {}
    for resource in stamps:
        by_name[resource] = stamps[resource]
        found = await index.search_resources(any_vector, SearchOptions(limit=everything, filter=SearchFilter(resource_id=resource)))
        chunks[resource] = tuple(sorted(result.text for result in found))
    annotations: dict[str, AnnotationPoint] = {}
    for result in await index.search_annotations(any_vector, SearchOptions(limit=everything)):
        assert result.annotation_id is not None
        annotations[result.annotation_id] = AnnotationPoint(result.resource_id, result.text, result.entity_types or (), result.machine_read)
    assert set(annotations) == await index.list_annotation_ids()
    return Held(stamps=by_name, chunks=chunks, annotations=annotations)


# ── The rig ────────────────────────────────────────────────────────────


@final
class Rig:
    """Held with `async with`: a Smelter that is following from the way in to the way out.

    `home` is the directory of its anchored-text store. `pdfs` is the
    documents its reader of PDFs opens, by their bytes, and `reads` what its
    OCR engine reads of an image, by the image's pixels. `after` is an
    earlier life of the Smelter, whose knowledge base, index and store go
    on: a Smelter that was stopped and started. `index` is the index it
    starts with, in place of the one it would have: an index that was
    cleared while the Smelter was stopped is a new one.
    """

    def __init__(
        self,
        home: Path,
        *,
        pdfs: Mapping[bytes, ScriptedDocument | PdfEncrypted | PdfUnreadable] | None = None,
        reads: Mapping[bytes, OcrRead] | None = None,
        chunking: Chunking | None = None,
        after: "Rig | None" = None,
        index: MemoryVectorStore | None = None,
    ) -> None:
        self.world: Final[World] = World() if after is None else after.world
        fresh = MemoryVectorStore() if after is None else after.index
        self.index: Final[MemoryVectorStore] = fresh if index is None else index
        self.provider: Final = Provider()
        self.reader: Final = ScriptedPdfReader(pdfs or {})
        self.engine: Final = ScriptedOcrEngine(reads)
        self.store: Final = AnchoredTextStore(home, stamp=STAMP)
        self.unanswered: Final[set[str]] = set()
        """The operations nobody answers: each is refused as a peer that is not there."""
        self.failing: Final[set[str]] = set()
        """The operations that are answered with a failure of the Archivist's own."""
        self.transport: Final = FaultyTransport(make_response=self._answer)
        self.transport.refuse_when(self._refuse)
        self.smelter: Final = Smelter(
            index=self.index,
            provider=self.provider,
            content=self.world,
            extractor=PdfExtractor(reader=self.reader, engine=self.engine),
            anchored=self.store,
            transport=self.transport,
            chunking=chunking or Chunking(chunk_size=512, overlap=64),
        )

    async def __aenter__(self) -> Self:
        await self.index.connect()
        await self.smelter.__aenter__()
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.smelter.__aexit__(kind, error, trace)
        await self.transport.close()

    # ── What the Archivist answers ─────────────────────────────────────

    def _refuse(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        if operation in self.unanswered:
            return {"code": "peer-unavailable", "message": "nothing answers"}
        if operation in self.failing:
            return {"code": "internal", "message": f"the Archivist could not answer {operation}"}
        if operation == "browse:resource-requested" and payload.get("resourceId") not in self.world.described:
            return {"code": "not-found", "message": f"no resource {payload.get('resourceId')}"}
        return None

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
        if operation == "browse:resources-requested":
            offset, limit = payload["offset"], payload["limit"]
            assert isinstance(offset, int)
            assert isinstance(limit, int)
            listed = self.world.catalog(payload.get("archived"))
            return {"resources": listed[offset : offset + limit], "total": len(listed), "offset": offset, "limit": limit}
        resource = payload.get("resourceId")
        assert isinstance(resource, str), operation
        on_it: list[JsonValue] = [*self.world.annotations.get(resource, [])]
        if operation == "browse:resource-requested":
            none: list[JsonValue] = []
            return {"resource": self.world.described[resource], "annotations": on_it, "entityReferences": none}
        if operation == "browse:annotations-requested":
            return {"annotations": on_it, "total": len(on_it)}
        raise AssertionError(f"the Smelter asked {operation}, which it is not to")

    # ── What happens ───────────────────────────────────────────────────

    def deliver(self, *events: JsonObject) -> None:
        """Deliver events to the Smelter, as the bus does: each on the channel of its type."""
        for stored in events:
            kind = stored["type"]
            assert isinstance(kind, str)
            self.transport.deliver(Frame(channel=kind, payload=stored))

    async def happened(self, *events: JsonObject) -> None:
        """Events that were recorded while the Smelter was following: delivered, and applied."""
        self.deliver(*events)
        await self.settled()

    async def settled(self) -> None:
        """Wait until the Smelter has applied every event delivered so far and answered what it was commanded."""
        for _ in range(3):
            # A command is taken up a turn or two after it is delivered, and a reply is delivered a turn after it is sent.
            for _ in range(20):
                await asyncio.sleep(0)
            await self.smelter.settled()

    def command(self, channel: str, payload: JsonObject, *, correlation_id: str) -> None:
        """Deliver a command to the Smelter, as the bus does."""
        self.transport.deliver(Frame(channel=channel, payload=payload, correlation_id=correlation_id))

    # ── What the Smelter did ───────────────────────────────────────────

    async def held(self) -> Held:
        """Everything the index holds."""
        return await held_by(self.index)

    def signalled(self) -> list[Mapping[str, JsonValue]]:
        """Each decision the Smelter signalled on `smelt:settled`, in the order it did."""
        return [frame.payload for frame in self.transport.emitted if frame.channel == "smelt:settled"]

    def answered(self, channel: str) -> Sequence[Frame]:
        """What the Smelter emitted on a channel."""
        return [frame for frame in self.transport.emitted if frame.channel == channel]

    def asked(self, operation: str) -> list[Mapping[str, JsonValue]]:
        """The payload of each request of an operation the Smelter made, in order."""
        return [entry.payload for entry in self.transport.request_log if entry.channel == operation]
