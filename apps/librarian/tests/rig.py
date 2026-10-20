"""What a Librarian is handed, for a test: a fake of each thing it reads by, and a few things said shortly.

A Librarian's code is handed what it reads by (`semiont_librarian.reads`, and
four protocols of the packages it is built on). Here is one fake of each. A
fake answers what a test states, keeps what it was asked in `asked`, in
order, and can be told to fail: whatever a test puts in `failing` is raised
by the next read, after it is kept as asked. The graph and the index have
more than one read, so theirs is a failure for each read, by the read's name.
Each read gives up one turn before it answers, as a real one does while it
waits.

The graph and the index answer from a store in the process (`store`), which
a test fills as a writer would, wherever a test states no answer of its own.
"""

import asyncio
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final, override

from pydantic import JsonValue
from semiont.identifiers import ResourceId
from semiont.types import (
    AnchoredTextAbsent,
    AnchoredTextAnswer,
    Annotation,
    Motivation,
    PersonProfile,
    ResourceAnnotations,
    ResourceDescriptor,
    ResourceView,
)
from semiont_graph.interface import EntityTypeCount, GraphConnection, ResourceListing, ResourceQuery
from semiont_graph.memory import MemoryGraphDatabase
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse
from semiont_inference.mock import MockInferenceClient
from semiont_service.content import Content, ContentReads, ContentUnread
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.mock import MockEmbeddingProvider
from semiont_vectors.store import ResourceStamp, SearchOptions, VectorReader, VectorSearchResult
from spec import JsonObject

from semiont_librarian.prompts import Prompt
from semiont_librarian.reads import (
    AnchoredText,
    Degraded,
    GraphReads,
    People,
    Projection,
    Settled,
    SmeltWaits,
    SmeltWaitTimedOut,
    Views,
    WeaveWaits,
    WeaveWaitTimedOut,
)
from semiont_librarian.record import ViewUnread

ADA_ID: Final = "did:web:example.org:users:ada"
"""The id of the one person a rig's builders name."""

ADA: Final[JsonObject] = {"@type": "Person", "@id": ADA_ID}

RECORDED: Final = "2020-03-04T05:06:07.000Z"
"""The moment everything a rig's builders make was recorded at, where a test states no other."""

LOVELACE: Final = {ADA_ID: PersonProfile(name="Ada Lovelace", since=RECORDED)}
"""A people projection in which Ada has a profile, and nobody else has."""

DIMENSIONS: Final = 8
"""How wide the vectors of a rig's embedding provider are."""

LIMITS: Final = InferenceLimits(context_tokens=200_000, max_output_tokens=8_192, output_tokens_per_hour=None, accepts_temperature=True)
"""The ceilings a rig's model states."""


async def _turn(failing: Exception | None) -> None:
    """Give up one turn, as a read does while it waits, and then fail as the fake was told to."""
    await asyncio.sleep(0)
    if failing is not None:
        raise failing


# ── Things said shortly ────────────────────────────────────────────────


def described(resource: str, **stated: JsonValue) -> ResourceDescriptor:
    """A resource's description, with no more said of it than a description must, and over that whatever a test states.

    What is stated is by the names the wire gives: `entityTypes`,
    `dateCreated`, `representations`.
    """
    said: JsonObject = {"@context": "https://schema.org", "@id": resource, "name": f"Name of {resource}", "representations": []}
    return ResourceDescriptor.model_validate({**said, **stated})


def tag(value: str) -> JsonObject:
    """A body item that tags an annotation with an entity type."""
    return {"type": "TextualBody", "value": value, "purpose": "tagging"}


def link(to: str) -> JsonObject:
    """A body item that links an annotation to a resource."""
    return {"type": "SpecificResource", "source": to, "purpose": "linking"}


def reference(annotation: str, on: str, *body: JsonValue, **stated: JsonValue) -> Annotation:
    """A reference on a resource, which quotes `some words` of it, with the body items given, and over that whatever a test states."""
    said: JsonObject = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": annotation,
        "motivation": "linking",
        "target": {"source": on, "selector": {"type": "TextQuoteSelector", "exact": "some words"}},
        "creator": ADA,
        "created": RECORDED,
    }
    if body:
        said["body"] = [*body]
    return Annotation.model_validate({**said, **stated})


def view(resource: ResourceDescriptor, *annotations: Annotation, last_sequence: int = 1) -> ResourceView:
    """The view the Archivist keeps of a resource: its description, the annotations on it, and the last event applied."""
    on_it = ResourceAnnotations(resource_id=resource.id, annotations=[*annotations], version=last_sequence, updated_at=RECORDED)
    return ResourceView(resource=resource, annotations=on_it, last_sequence=last_sequence)


# ── What the Archivist writes, and what it serves ──────────────────────


@final
class FakeViews(Views):
    """The views a test states. `held` is each, by its resource, and `asked` every resource a view was asked for.

    `failing` fails every read. `unread` is the resources whose view is
    there and cannot be read, as a file that is no view cannot.
    """

    def __init__(self, *held: ResourceView) -> None:
        self.held: Final[dict[ResourceId, ResourceView]] = {each.resource.id: each for each in held}
        self.asked: Final[list[ResourceId]] = []
        self.failing: Exception | None = None
        self.unread: Final[set[ResourceId]] = set()

    @override
    async def get(self, resource_id: ResourceId) -> ResourceView | None:
        self.asked.append(resource_id)
        await _turn(ViewUnread(f"the view of {resource_id} cannot be read") if resource_id in self.unread else self.failing)
        return self.held.get(resource_id)


@final
class FakePeople(People):
    """The people projection a test states. `people` is each profile, by DID, and `reads` how many times it was read."""

    def __init__(self, people: Mapping[str, PersonProfile] | None = None) -> None:
        self.people: Final[dict[str, PersonProfile]] = dict(people or {})
        self.reads = 0
        self.failing: Exception | None = None

    @override
    async def read(self) -> Mapping[str, PersonProfile]:
        self.reads += 1
        await _turn(self.failing)
        return dict(self.people)


@final
class FakeContent(ContentReads):
    """The bytes a test states. `held` is each resource's, and `asked` every resource whose bytes were asked for.

    A resource it holds no bytes of is unread, as one the Archivist has none
    of is.
    """

    def __init__(self) -> None:
        self.held: Final[dict[ResourceId, Content]] = {}
        self.asked: Final[list[ResourceId]] = []
        self.failing: Exception | None = None

    @override
    async def read(self, resource_id: ResourceId) -> Content:
        self.asked.append(resource_id)
        await _turn(self.failing)
        held = self.held.get(resource_id)
        if held is None:
            raise ContentUnread(f"the bytes of {resource_id} could not be read")
        return held


@final
class FakeAnchoredText(AnchoredText):
    """The anchored texts a test states. `answers` is each resource's, and `asked` every resource one was asked for.

    A resource a test stated none for is answered `unknown`, as a gateway
    answers for one it knows nothing of.
    """

    def __init__(self) -> None:
        self.answers: Final[dict[ResourceId, AnchoredTextAnswer]] = {}
        self.asked: Final[list[ResourceId]] = []
        self.failing: Exception | None = None

    @override
    async def ask(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        self.asked.append(resource_id)
        await _turn(self.failing)
        return self.answers.get(resource_id, AnchoredTextAbsent(kind="unknown"))


# ── The graph ──────────────────────────────────────────────────────────


@final
class FakeGraph(GraphReads):
    """The graph, as a test states it. `asked` is each read, by its name, with what it was asked. `failing` is by a read's name.

    A read is answered with what a test stated for it, and from `store`, a
    graph in the process, where a test stated nothing: `resources`,
    `annotations`, `referenced_by` and `connections` are each by resource,
    `entity_type_stats` is the whole answer, and `listing` answers a query.
    A resource stated as `None` is one the graph does not hold, whatever
    `store` holds. What is stated of `referenced_by` is answered for every
    motivation.
    """

    def __init__(self) -> None:
        self.store: Final = MemoryGraphDatabase()
        self.resources: Final[dict[ResourceId, ResourceDescriptor | None]] = {}
        self.annotations: Final[dict[ResourceId, list[Annotation]]] = {}
        self.referenced_by: Final[dict[ResourceId, list[Annotation]]] = {}
        self.connections: Final[dict[ResourceId, list[GraphConnection]]] = {}
        self.entity_type_stats: list[EntityTypeCount] | None = None
        self.listing: Callable[[ResourceQuery], ResourceListing] | None = None
        self.asked: Final[list[tuple[str, object]]] = []
        self.failing: Final[dict[str, Exception]] = {}

    async def _asked(self, read: str, of: object) -> None:
        self.asked.append((read, of))
        await _turn(self.failing.get(read))

    def asked_of(self, read: str) -> list[object]:
        """What one read was asked, each time it was, in order."""
        return [of for name, of in self.asked if name == read]

    @override
    async def get_resource(self, resource_id: ResourceId) -> ResourceDescriptor | None:
        await self._asked("get_resource", resource_id)
        if resource_id in self.resources:
            return self.resources[resource_id]
        return await self.store.get_resource(resource_id)

    @override
    async def list_resources(self, query: ResourceQuery) -> ResourceListing:
        await self._asked("list_resources", query)
        if self.listing is not None:
            return self.listing(query)
        return await self.store.list_resources(query)

    @override
    async def get_resource_annotations(self, resource_id: ResourceId) -> list[Annotation]:
        await self._asked("get_resource_annotations", resource_id)
        if resource_id in self.annotations:
            return [*self.annotations[resource_id]]
        return await self.store.get_resource_annotations(resource_id)

    @override
    async def get_resource_referenced_by(self, resource_id: ResourceId, motivation: Motivation | None) -> list[Annotation]:
        await self._asked("get_resource_referenced_by", (resource_id, motivation))
        if resource_id in self.referenced_by:
            return [*self.referenced_by[resource_id]]
        return await self.store.get_resource_referenced_by(resource_id, motivation)

    @override
    async def get_resource_connections(self, resource_id: ResourceId) -> list[GraphConnection]:
        await self._asked("get_resource_connections", resource_id)
        if resource_id in self.connections:
            return [*self.connections[resource_id]]
        return await self.store.get_resource_connections(resource_id)

    @override
    async def get_entity_type_stats(self) -> list[EntityTypeCount]:
        await self._asked("get_entity_type_stats", None)
        if self.entity_type_stats is not None:
            return [*self.entity_type_stats]
        return await self.store.get_entity_type_stats()


# ── The index, and the provider that makes a query's vector ────────────


@final
class FakeVectors(VectorReader):
    """The vector index, as a test states it. `asked` is each search: its name, what it searched by, and its options.

    A search is answered with what a test stated for it in `stated`, by the
    search's name and as it is stated, whatever its filter and its limit say.
    A search a test stated nothing for is answered from `store`, an index in
    the process. `failing` is by a read's name, `connect` among them.
    `connected` says whether it is reached. `stamps` is the stamp of each
    resource a test states one for, and `stamps_asked` every resource whose
    stamp was asked for; a resource a test stated none for is answered from
    `store`.
    """

    def __init__(self) -> None:
        self.store: Final = MemoryVectorStore()
        self.stated: Final[dict[str, list[VectorSearchResult]]] = {}
        self.stamps: Final[dict[ResourceId, ResourceStamp]] = {}
        self.stamps_asked: Final[list[ResourceId]] = []
        self.asked: Final[list[tuple[str, object, SearchOptions]]] = []
        self.failing: Final[dict[str, Exception]] = {}
        self.connected = False

    async def _asked(self, search: str, by: object, options: SearchOptions) -> None:
        self.asked.append((search, by, options))
        await _turn(self.failing.get(search))

    @override
    async def connect(self) -> None:
        await _turn(self.failing.get("connect"))
        self.connected = True

    @override
    async def disconnect(self) -> None:
        self.connected = False

    @override
    async def search_resources(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        await self._asked("search_resources", [*embedding], options)
        if "search_resources" in self.stated:
            return [*self.stated["search_resources"]]
        return await self.store.search_resources(embedding, options)

    @override
    async def search_annotations(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        await self._asked("search_annotations", [*embedding], options)
        if "search_annotations" in self.stated:
            return [*self.stated["search_annotations"]]
        return await self.store.search_annotations(embedding, options)

    @override
    async def search_by_resource(self, resource_id: ResourceId, options: SearchOptions) -> list[VectorSearchResult]:
        await self._asked("search_by_resource", resource_id, options)
        if "search_by_resource" in self.stated:
            return [*self.stated["search_by_resource"]]
        return await self.store.search_by_resource(resource_id, options)

    @override
    async def get_resource_stamp(self, resource_id: ResourceId) -> ResourceStamp | None:
        self.stamps_asked.append(resource_id)
        await _turn(self.failing.get("get_resource_stamp"))
        if resource_id in self.stamps:
            return self.stamps[resource_id]
        return await self.store.get_resource_stamp(resource_id)


@final
class FakeEmbedding(EmbeddingProvider):
    """A provider in the process that answers each text with the vector worked out from it. `asked` is every text, in order.

    The vector of a text is `semiont_vectors.mock.deterministic_vector` of
    it, `DIMENSIONS` wide.
    """

    def __init__(self) -> None:
        self._worked_out: Final = MockEmbeddingProvider(dimensions=DIMENSIONS)
        self.asked: Final[list[str]] = []
        self.failing: Exception | None = None

    @override
    async def embed_query(self, text: str) -> list[float]:
        self.asked.append(text)
        await _turn(self.failing)
        return await self._worked_out.embed_query(text)

    @override
    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        self.asked.extend(texts)
        await _turn(self.failing)
        return await self._worked_out.embed_documents(texts)

    @override
    async def dimensions(self) -> int:
        return DIMENSIONS


# ── A model ────────────────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Prompted:
    """One request of a model, as it was made."""

    prompt: str
    max_tokens: int
    temperature: float


def sent(prompt: Prompt) -> Prompted:
    """A prompt, as a model that was sent it records the request."""
    return Prompted(prompt.text, prompt.max_tokens, prompt.temperature)


@final
class FakeInference(InferenceClient):
    """A model that answers each request with the next reply a test stated, and with the last of them once they are used up.

    `asked` is every request, in order. With no reply stated it answers the
    empty text. Every reply ends as a model that had finished ends one
    (`end_turn`). `failing` fails every request, and `failing_on` each one
    whose prompt has that text in it. A request for elements is answered
    with the next reply read as a JSON array, and `schemas` is the schema of
    each such request, in order.
    """

    def __init__(self, *replies: str) -> None:
        said = replies or ("",)
        self._mock: Final = MockInferenceClient(said, stop_reasons=["end_turn"] * len(said), limits=LIMITS)
        self.asked: Final[list[Prompted]] = []
        self.schemas: Final[list[ElementSchema]] = []
        self.failing: Exception | None = None
        self.failing_on: str | None = None

    def _failure_of(self, prompt: str) -> Exception | None:
        if self.failing_on is not None and self.failing_on in prompt:
            return RuntimeError("the model failed on this prompt")
        return self.failing

    def say(self, *replies: str) -> None:
        """Answer from these replies from now on, beginning with the first."""
        self._mock.set_responses(replies, stop_reasons=["end_turn"] * len(replies))

    def say_as(self, reply: str, *, stopped: str) -> None:
        """Answer with this reply from now on, ended for the reason given: `max_tokens` is a reply cut off at its limit."""
        self._mock.set_responses([reply], stop_reasons=[stopped])

    @property
    @override
    def provider(self) -> str:
        return self._mock.provider

    @property
    @override
    def model_id(self) -> str:
        return self._mock.model_id

    @property
    @override
    def max_concurrency(self) -> int:
        return self._mock.max_concurrency

    @property
    @override
    def verify_detection_yield(self) -> bool:
        return self._mock.verify_detection_yield

    @override
    async def limits(self) -> InferenceLimits:
        return LIMITS

    @override
    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        self.asked.append(Prompted(prompt, max_tokens, temperature))
        await _turn(self._failure_of(prompt))
        return await self._mock.generate_text(prompt, max_tokens, temperature)

    @override
    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.asked.append(Prompted(prompt, max_tokens, temperature))
        self.schemas.append(element_schema)
        await _turn(self._failure_of(prompt))
        return await self._mock.generate_structured(prompt, max_tokens, temperature, element_schema)


# ── The two waits, and what counts a gather that went without ──────────


@final
class FakeWeave(WeaveWaits):
    """What the graph is signalled to have applied, as a test states it. `applied` is each resource's highest sequence number.

    A wait is answered after one turn and never waits out its bound: it
    returns where `applied` has reached the sequence, and raises
    `WeaveWaitTimedOut` where it has not. `asked` is each wait: the resource,
    the sequence and the bound. `then` is called as a wait is answered,
    before it returns or raises: what happened while it waited.
    """

    def __init__(self) -> None:
        self.applied: Final[dict[ResourceId, int]] = {}
        self.asked: Final[list[tuple[ResourceId, int, float]]] = []
        self.failing: Exception | None = None
        self.then: Callable[[], None] | None = None

    @override
    async def when_applied(self, resource_id: ResourceId, sequence: int, within: float) -> None:
        self.asked.append((resource_id, sequence, within))
        await _turn(self.failing)
        if self.then is not None:
            self.then()
        if self.applied.get(resource_id, 0) < sequence:
            raise WeaveWaitTimedOut(f"weave:applied did not reach {sequence} for {resource_id} within {within} seconds")


@final
class FakeSmelt(SmeltWaits):
    """What the index is signalled to have settled, as a test states it. `settled` is the decision of a resource's bytes, by checksum.

    A wait is answered after one turn and never waits out its bound: it
    answers the decision stated for the resource and the checksum, and raises
    `SmeltWaitTimedOut` where none is. `asked` is each wait: the resource,
    the checksum and the bound. `then` is called as a wait is answered,
    before it answers or raises: what happened while it waited.
    """

    def __init__(self) -> None:
        self.settled: Final[dict[tuple[ResourceId, str], Settled]] = {}
        self.asked: Final[list[tuple[ResourceId, str, float]]] = []
        self.failing: Exception | None = None
        self.then: Callable[[], None] | None = None

    @override
    async def when_settled(self, resource_id: ResourceId, checksum: str, within: float) -> Settled:
        self.asked.append((resource_id, checksum, within))
        await _turn(self.failing)
        if self.then is not None:
            self.then()
        decided = self.settled.get((resource_id, checksum))
        if decided is None:
            raise SmeltWaitTimedOut(f"smelt:settled did not state {checksum} for {resource_id} within {within} seconds")
        return decided


@final
class FakeDegraded(Degraded):
    """What counts a gather that went without something. `noted` is each one counted, in order."""

    def __init__(self) -> None:
        self.noted: Final[list[Projection]] = []

    @override
    def note(self, projection: Projection) -> None:
        self.noted.append(projection)
