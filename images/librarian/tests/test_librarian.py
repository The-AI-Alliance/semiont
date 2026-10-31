"""The Librarian, over a transport a test delivers frames through and fakes of what it reads by.

`docs/protocol/LIBRARIAN.md` § What it answers, § Order, § Limits and §
Stopping state the rules. What each request is answered with is its own
module's, and has its own tests. Here is what the Librarian adds: each
request is answered once, under its correlation id, on its result channel
or its failure channel; a failure names what the protocol says it names; a
signal is noted while a request is in hand; gathers and reference searches
take their turns, and everything else is handled as it arrives; a request
that fails ends nothing; and a stopped Librarian takes nothing more.

A frame is delivered as the bus delivers one. The two folds are the real
ones, so a wait in a gather is ended by a signal a test delivers.
"""

import asyncio
import logging
import time
from datetime import UTC, datetime
from types import TracebackType
from typing import Final, Self, final, override

import pytest
from aio import run, soon
from pydantic import JsonValue
from rig import (
    FakeAnchoredText,
    FakeContent,
    FakeDegraded,
    FakeEmbedding,
    FakeGraph,
    FakeInference,
    FakeProfiles,
    FakeRecord,
    FakeVectors,
    described,
    reference,
    view,
)
from semiont.identifiers import AnnotationId, ResourceId
from semiont.testing import FaultyTransport
from semiont.transport import Frame
from semiont.types import Annotation, EngineProvider, ResourceView
from semiont_graph.interface import ResourceListing
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse
from semiont_service.content import Content
from spec import JsonObject, objects, thing

from semiont_librarian.librarian import Librarian
from semiont_librarian.progress import SmeltProgress, WeaveProgress
from semiont_librarian.reads import Described, Record

QUAY: Final = ResourceId("res-quay")
FERRY: Final = ResourceId("res-ferry")
FORT: Final = ResourceId("res-fort")
ROCK: Final = ResourceId("res-rock")
NOWHERE: Final = ResourceId("res-nowhere")
MAIN: Final = ResourceId("res-main")

CROSSING: Final = AnnotationId("ann-crossing")
LANDING: Final = AnnotationId("ann-landing")
REFERENCE: Final = AnnotationId("ann-ref")

NOW: Final = datetime(2026, 3, 31, tzinfo=UTC)
"""The moment every reference search here is made at."""

LONG: Final = 1000.0
"""A bound, in seconds, that no test waits out."""

SETTLE: Final = 15.0
"""The settle bound a rig's Librarian is handed, in seconds."""

FLOOR: Final = 0.6
"""The semantic floor a rig's Librarian is handed."""

QUIET: Final[JsonObject] = {"includeSourceContext": False, "includeTargetContext": False}
"""What a gather around an annotation is asked for where a test wants no text read."""

WHOLE: Final[JsonObject] = {"depth": 1, "maxResources": 10, "includeContent": False, "includeSummary": False}
"""What a gather around a resource is asked for where a test wants no text read and no model asked."""

UNREAD: Final = "A request that is not its channel's was not handled"


async def turns() -> None:
    """Give up some turns: long enough for whatever could be answered to be, and no time at all."""
    for _ in range(60):
        await asyncio.sleep(0)


@final
class HeldRecord(Record):
    """A record that holds no resource, and that answers for a resource a test holds only once the test lets it.

    `asked` is every resource whose description was asked for, in order:
    what shows that a request has begun to be handled.
    """

    def __init__(self) -> None:
        self.asked: Final[list[ResourceId]] = []
        self._holding: Final[dict[ResourceId, asyncio.Event]] = {}

    def hold(self, resource_id: ResourceId) -> asyncio.Event:
        """Hold every read of a resource's description until the event answered is set."""
        self._holding[resource_id] = asyncio.Event()
        return self._holding[resource_id]

    @override
    async def described(self, resource_id: ResourceId) -> Described | None:
        self.asked.append(resource_id)
        held = self._holding.get(resource_id)
        if held is None:
            await asyncio.sleep(0)
        else:
            await held.wait()
        return None

    @override
    async def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Annotation | None:
        raise AssertionError(f"an annotation was asked of {resource_id}, which the record does not hold")


@final
class Model(InferenceClient):
    """A model with a name of its own, which answers as a rig's model does: what tells one actor's model from the other's."""

    def __init__(self, model: str) -> None:
        self._model: Final = model
        self._answers: Final = FakeInference()

    @property
    @override
    def provider(self) -> EngineProvider:
        return "ollama"

    @property
    @override
    def model_id(self) -> str:
        return self._model

    @property
    @override
    def max_concurrency(self) -> int:
        return self._answers.max_concurrency

    @property
    @override
    def verify_detection_yield(self) -> bool:
        return self._answers.verify_detection_yield

    @override
    async def limits(self) -> InferenceLimits:
        return await self._answers.limits()

    @override
    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        return await self._answers.generate_text(prompt, max_tokens, temperature)

    @override
    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        return await self._answers.generate_structured(prompt, max_tokens, temperature, element_schema)


@final
class World:
    """Held with `async with`: a Librarian that takes frames from the way in to the way out, over a fake of each thing it reads by.

    The graph lists nothing and the index answers nothing, until a test
    states otherwise. `record` is the record it reads in place of the one
    made of what a test holds, and `matcher` and `gatherer` the models of
    its two actors in place of two that answer the empty text.
    """

    def __init__(
        self,
        *held: ResourceView,
        record: Record | None = None,
        matcher: InferenceClient | None = None,
        gatherer: InferenceClient | None = None,
    ) -> None:
        self.profiles: Final = FakeProfiles()
        self.content: Final = FakeContent()
        self.graph: Final = FakeGraph()
        self.vectors: Final = FakeVectors()
        self.embedding: Final = FakeEmbedding()
        self.degraded: Final = FakeDegraded()
        self.weave: Final = WeaveProgress(time.monotonic)
        self.smelt: Final = SmeltProgress(time.monotonic)
        self.transport: Final = FaultyTransport()
        self.graph.listing = lambda query: ResourceListing(resources=[], total=0)
        self.graph.entity_type_stats = []
        self.vectors.stated["search_resources"] = []
        self.vectors.stated["search_by_resource"] = []
        self.librarian: Final = Librarian(
            record=FakeRecord(*held) if record is None else record,
            profiles=self.profiles,
            graph=self.graph,
            vectors=self.vectors,
            embedding=self.embedding,
            matcher=FakeInference() if matcher is None else matcher,
            gatherer=FakeInference() if gatherer is None else gatherer,
            content=self.content,
            anchored=FakeAnchoredText(),
            weave=self.weave,
            smelt=self.smelt,
            degraded=self.degraded,
            now=lambda: NOW,
            settle_within=SETTLE,
            semantic_floor=FLOOR,
            transport=self.transport,
        )

    async def __aenter__(self) -> Self:
        await self.librarian.__aenter__()
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.librarian.__aexit__(kind, error, trace)
        await self.transport.close()

    def weave_in(self, resource_id: ResourceId) -> None:
        """Make the graph hold a resource, with nothing on it, nothing it is connected to and nothing that refers to it."""
        self.graph.resources[resource_id] = described(resource_id)
        self.graph.annotations[resource_id] = []
        self.graph.referenced_by[resource_id] = []
        self.graph.connections[resource_id] = []

    def ask(self, channel: str, payload: JsonObject, correlation_id: str) -> None:
        """Deliver a request to the Librarian, as the bus does."""
        self.transport.deliver(Frame(channel=channel, payload=payload, correlation_id=correlation_id))

    def tell(self, channel: str, payload: JsonObject) -> None:
        """Deliver a signal to the Librarian, as the bus does."""
        self.transport.deliver(Frame(channel=channel, payload=payload))

    def answered(self, channel: str) -> list[Frame]:
        """What the Librarian emitted on a channel, in the order it did."""
        return [frame for frame in self.transport.emitted if frame.channel == channel]

    def answered_for(self, channel: str) -> list[str | None]:
        """The correlation id of each frame the Librarian emitted on a channel, in the order it did."""
        return [frame.correlation_id for frame in self.answered(channel)]


def searching(*, around_a_resource: bool = False, neighbours: tuple[ResourceId, ...] = ()) -> JsonObject:
    """A request to search for what `REFERENCE`, on `MAIN`, could refer to, with no model asked.

    Its context is gathered around the reference, which selects the words
    `Black Hawk`, or around `MAIN` itself, which no reference search
    answers. The context's graph connects `MAIN` to each of `neighbours`.
    """
    source: JsonObject = {"@context": "https://schema.org/", "@id": MAIN, "name": "Sauk history", "representations": []}
    focus: JsonObject = {"kind": "resource", "resource": source}
    if not around_a_resource:
        focus = {
            "kind": "annotation",
            "annotation": {
                "@context": "http://www.w3.org/ns/anno.jsonld",
                "type": "Annotation",
                "id": REFERENCE,
                "motivation": "linking",
                "target": {"source": MAIN},
                "created": "2025-06-01T00:00:00.000Z",
            },
            "sourceResource": source,
            "selected": {"text": "Black Hawk"},
        }
    nodes: list[JsonValue] = [{"id": resource, "type": "resource", "label": resource} for resource in (MAIN, *neighbours)]
    edges: list[JsonValue] = [{"source": MAIN, "target": resource, "type": "link"} for resource in neighbours]
    context: JsonObject = {"focus": focus, "graph": {"nodes": nodes, "edges": edges}, "metadata": {}}
    return {"resourceId": MAIN, "referenceId": REFERENCE, "useSemanticScoring": False, "context": context}


# ── Each request, answered and failed ──────────────────────────────────


def test_a_gather_around_an_annotation_is_answered_with_its_annotation_and_a_failure_names_it_too() -> None:
    async def scenario() -> None:
        async with World(view(described(QUAY), reference(CROSSING, QUAY))) as world:
            world.weave_in(QUAY)
            world.ask("gather:requested", {"annotationId": CROSSING, "resourceId": QUAY, "options": QUIET}, "c-1")
            world.ask("gather:requested", {"annotationId": LANDING, "resourceId": NOWHERE}, "c-2")
            await world.librarian.settled()

            (complete,) = world.answered("gather:complete")
            assert complete.correlation_id == "c-1"
            assert sorted(complete.payload) == ["annotationId", "response"]
            assert complete.payload["annotationId"] == CROSSING
            assert thing(thing(complete.payload["response"], "the context")["focus"], "its focus")["kind"] == "annotation"

            (failed,) = world.answered("gather:failed")
            assert failed.correlation_id == "c-2"
            assert dict(failed.payload) == {"annotationId": LANDING, "message": "Source resource not found"}

    run(scenario())


def test_a_gather_around_a_resource_is_answered_with_its_resource_and_a_failure_names_it_too() -> None:
    async def scenario() -> None:
        async with World(view(described(QUAY))) as world:
            world.weave_in(QUAY)
            world.ask("gather:resource-requested", {"resourceId": QUAY, "options": WHOLE}, "c-1")
            world.ask("gather:resource-requested", {"resourceId": NOWHERE, "options": WHOLE}, "c-2")
            await world.librarian.settled()

            (complete,) = world.answered("gather:resource-complete")
            assert complete.correlation_id == "c-1"
            assert sorted(complete.payload) == ["resourceId", "response"]
            assert complete.payload["resourceId"] == QUAY
            assert thing(thing(complete.payload["response"], "the context")["focus"], "its focus")["kind"] == "resource"

            (failed,) = world.answered("gather:resource-failed")
            assert failed.correlation_id == "c-2"
            assert dict(failed.payload) == {"resourceId": NOWHERE, "message": "Resource not found"}

    run(scenario())


def test_a_reference_search_is_answered_with_its_reference_and_a_failure_names_it_under_error() -> None:
    async def scenario() -> None:
        async with World() as world:
            world.graph.listing = lambda query: ResourceListing(resources=[described(ROCK, name="Black Hawk")], total=1)
            world.ask("match:search-requested", searching(), "c-1")
            world.ask("match:search-requested", searching(around_a_resource=True), "c-2")
            await world.librarian.settled()

            (results,) = world.answered("match:search-results")
            assert results.correlation_id == "c-1"
            assert sorted(results.payload) == ["referenceId", "response"]
            assert results.payload["referenceId"] == REFERENCE
            (candidate,) = objects(results.payload["response"], "the candidates")
            assert candidate["@id"] == ROCK
            assert candidate["matchReason"] == "exact name match"

            (failed,) = world.answered("match:search-failed")
            assert failed.correlation_id == "c-2"
            # The one failure that says why under `error`, and states no `message`.
            assert dict(failed.payload) == {"referenceId": REFERENCE, "error": "Matcher expected annotation focus, received 'resource'"}

    run(scenario())


def test_a_text_search_is_answered_with_its_page_and_fails_with_a_message() -> None:
    async def scenario() -> None:
        async with World() as world:
            world.ask("match:resources-requested", {"search": "   "}, "c-1")
            await world.librarian.settled()
            world.graph.failing["list_resources"] = RuntimeError("the graph is down")
            world.ask("match:resources-requested", {"search": "quay"}, "c-2")
            await world.librarian.settled()

            (result,) = world.answered("match:resources-result")
            assert result.correlation_id == "c-1"
            assert dict(result.payload) == {"response": {"resources": [], "total": 0, "offset": 0, "limit": 50, "matchKind": "lexical"}}

            (failed,) = world.answered("match:resources-failed")
            assert failed.correlation_id == "c-2"
            assert dict(failed.payload) == {"message": "the graph is down"}

    run(scenario())


def test_what_refers_to_a_resource_is_answered_and_fails_with_a_message() -> None:
    async def scenario() -> None:
        async with World(view(described(QUAY))) as world:
            world.graph.referenced_by[QUAY] = []
            world.ask("gather:referenced-by-requested", {"resourceId": QUAY}, "c-1")
            await world.librarian.settled()
            world.graph.failing["get_resource_referenced_by"] = RuntimeError("the graph is down")
            world.ask("gather:referenced-by-requested", {"resourceId": QUAY}, "c-2")
            await world.librarian.settled()

            (result,) = world.answered("gather:referenced-by-result")
            assert result.correlation_id == "c-1"
            assert dict(result.payload) == {"response": {"referencedBy": []}}

            (failed,) = world.answered("gather:referenced-by-failed")
            assert failed.correlation_id == "c-2"
            assert dict(failed.payload) == {"message": "the graph is down"}

    run(scenario())


def test_a_summary_is_answered_by_the_gatherers_model_and_fails_with_a_message() -> None:
    async def scenario() -> None:
        stored: JsonObject = {"mediaType": "text/plain", "storageUri": "file://quay", "checksum": "sum-of-the-quay"}
        passage: JsonObject = {"type": "TextPositionSelector", "start": 2, "end": 7}
        crossing = reference(CROSSING, QUAY, target={"source": QUAY, "selector": passage})
        gatherer = FakeInference("The ferry is the only way over.")
        async with World(view(described(QUAY, representations=[stored]), crossing), gatherer=gatherer) as world:
            world.content.held[QUAY] = Content(b"A ferry leaves the quay at dawn.", "text/plain")
            world.ask("gather:summary-requested", {"annotationId": CROSSING, "resourceId": QUAY}, "c-1")
            world.ask("gather:summary-requested", {"annotationId": CROSSING, "resourceId": NOWHERE}, "c-2")
            await world.librarian.settled()

            (result,) = world.answered("gather:summary-result")
            assert result.correlation_id == "c-1"
            assert sorted(result.payload) == ["response"]
            summary = thing(result.payload["response"], "the summary")
            assert summary["summary"] == "The ferry is the only way over."
            assert thing(summary["context"], "its context")["selected"] == "ferry"
            assert len(gatherer.asked) == 1

            (failed,) = world.answered("gather:summary-failed")
            assert failed.correlation_id == "c-2"
            assert dict(failed.payload) == {"message": "Resource res-nowhere not found in view storage"}

    run(scenario())


def test_each_limits_request_is_answered_with_the_limits_of_its_own_actors_engine() -> None:
    async def scenario() -> None:
        async with World(matcher=Model("the-matchers"), gatherer=Model("the-gatherers")) as world:
            world.ask("match:limits-requested", {}, "c-1")
            world.ask("gather:limits-requested", {}, "c-2")
            await turns()

            asked = (("match:limits-result", "c-1", "the-matchers"), ("gather:limits-result", "c-2", "the-gatherers"))
            for channel, correlation_id, model in asked:
                (result,) = world.answered(channel)
                assert result.correlation_id == correlation_id
                (reported,) = objects(thing(result.payload["response"], "the report")["limits"], "its limits")
                assert thing(reported["engine"], "the engine") == {"provider": "ollama", "model": model}
                assert thing(reported["limits"], "the engine's limits")["contextTokens"] == 200_000
            assert world.answered("match:limits-failed") == []
            assert world.answered("gather:limits-failed") == []

    run(scenario())


# ── A frame that is not its channel's ──────────────────────────────────


def test_a_request_that_is_not_its_channels_is_logged_and_failed_where_it_states_what_its_failure_names(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        async with World() as world:
            # It names its annotation, and no resource.
            world.ask("gather:requested", {"annotationId": CROSSING}, "c-1")
            # It names no annotation, so there is nothing its failure could name.
            world.ask("gather:requested", {"resourceId": 7}, "c-2")
            world.ask("match:resources-requested", {}, "c-3")
            # Nobody waits on a request with no correlation id.
            world.tell("gather:summary-requested", {})
            await world.librarian.settled()

            (gather,) = world.answered("gather:failed")
            assert gather.correlation_id == "c-1"
            assert sorted(gather.payload) == ["annotationId", "message"]
            assert gather.payload["annotationId"] == CROSSING
            message = gather.payload["message"]
            assert isinstance(message, str)
            assert message.startswith("The request on gather:requested is not what that channel carries: ")

            (search,) = world.answered("match:resources-failed")
            assert search.correlation_id == "c-3"
            assert dict(search.payload) == {"message": "The request on match:resources-requested is not what that channel carries: search"}

            assert world.answered("gather:summary-failed") == []
            assert world.answered("gather:complete") == []

    with caplog.at_level(logging.ERROR, logger="semiont_librarian"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records].count(UNREAD) == 4


def test_a_signal_that_is_not_its_channels_is_logged_and_passed_by(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with World() as world:
            world.tell("weave:applied", {"resourceId": QUAY})
            world.tell("smelt:settled", {"resourceId": QUAY, "contentChecksum": "sum", "outcome": "smelted"})
            # The next of each is noted.
            world.tell("weave:applied", {"resourceId": QUAY, "sequenceNumber": 4})
            world.tell("smelt:settled", {"resourceId": QUAY, "contentChecksum": "sum", "outcome": "indexed"})

            await soon(world.weave.when_applied(QUAY, 4, LONG))
            assert await soon(world.smelt.when_settled(QUAY, "sum", LONG)) == "indexed"

    with caplog.at_level(logging.ERROR, logger="semiont_librarian"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records].count("A signal that is not its channel's was passed by") == 2


# ── Signals, beside what is in hand ────────────────────────────────────


def test_a_signal_is_noted_while_the_gather_that_waits_for_it_is_in_hand() -> None:
    async def scenario() -> None:
        async with World(view(described(QUAY), last_sequence=3)) as world:
            # The view holds the quay, and the graph does not yet: the gather waits for the Weaver.
            world.graph.resources[QUAY] = None
            world.ask("gather:resource-requested", {"resourceId": QUAY, "options": WHOLE}, "c-1")
            await turns()
            assert world.answered("gather:resource-complete") == []

            world.weave_in(QUAY)
            world.tell("weave:applied", {"resourceId": QUAY, "sequenceNumber": 3})
            # No time passes: the signal ended the wait, and no bound ran out.
            await turns()

            assert world.answered_for("gather:resource-complete") == ["c-1"]
            assert world.answered("gather:resource-failed") == []
            assert world.degraded.noted == []

    run(scenario())


# ── The order it works in ──────────────────────────────────────────────


def test_gathers_of_one_kind_for_one_resource_take_turns_and_no_other_gather_waits_on_them() -> None:
    async def scenario() -> None:
        record = HeldRecord()
        let_go = record.hold(QUAY)
        async with World(record=record) as world:
            world.ask("gather:requested", {"annotationId": CROSSING, "resourceId": QUAY}, "c-1")
            world.ask("gather:requested", {"annotationId": LANDING, "resourceId": QUAY}, "c-2")
            world.ask("gather:requested", {"annotationId": CROSSING, "resourceId": FERRY}, "c-3")
            world.ask("gather:resource-requested", {"resourceId": QUAY, "options": WHOLE}, "c-4")
            await turns()

            # The first gather around an annotation of the quay is in hand, and the second has not begun. The gather
            # around the quay itself is in hand beside it, and the gather for the ferry is answered.
            assert record.asked.count(QUAY) == 2
            assert record.asked.count(FERRY) == 1
            assert world.answered_for("gather:failed") == ["c-3"]
            assert world.answered("gather:resource-failed") == []

            let_go.set()
            await world.librarian.settled()

            assert world.answered_for("gather:failed") == ["c-3", "c-1", "c-2"]
            assert world.answered_for("gather:resource-failed") == ["c-4"]
            assert record.asked.count(QUAY) == 3

    run(scenario())


def test_reference_searches_are_made_one_at_a_time_and_everything_else_is_handled_as_it_arrives() -> None:
    async def scenario() -> None:
        record = HeldRecord()
        let_go = record.hold(FORT)
        async with World(record=record) as world:
            # The graph does not hold the neighbour, so each search reads its view, which is held.
            world.graph.resources[FORT] = None
            world.graph.referenced_by[QUAY] = []
            world.ask("match:search-requested", searching(neighbours=(FORT,)), "c-1")
            world.ask("match:search-requested", searching(neighbours=(FORT,)), "c-2")
            await turns()
            assert record.asked == [FORT]
            assert len(world.graph.asked_of("list_resources")) == 1

            # While a search is in hand, what takes no turn is answered.
            world.ask("match:resources-requested", {"search": " "}, "c-3")
            world.ask("gather:referenced-by-requested", {"resourceId": QUAY}, "c-4")
            world.ask("gather:summary-requested", {"annotationId": CROSSING, "resourceId": NOWHERE}, "c-5")
            await turns()
            assert world.answered_for("match:resources-result") == ["c-3"]
            # This record holds no resource, so what refers to one fails: it is answered all the same.
            assert world.answered_for("gather:referenced-by-failed") == ["c-4"]
            assert world.answered_for("gather:summary-failed") == ["c-5"]
            assert world.answered("match:search-results") == []
            assert len(world.graph.asked_of("list_resources")) == 1

            let_go.set()
            await world.librarian.settled()

            assert world.answered_for("match:search-results") == ["c-1", "c-2"]
            assert len(world.graph.asked_of("list_resources")) == 2

    run(scenario())


def test_a_request_that_fails_ends_nothing_and_the_next_is_handled() -> None:
    async def scenario() -> None:
        async with World(view(described(QUAY))) as world:
            world.weave_in(QUAY)
            world.graph.failing["get_resource_referenced_by"] = RuntimeError("the graph is down")
            world.ask("gather:referenced-by-requested", {"resourceId": QUAY}, "c-1")
            world.ask("gather:resource-requested", {"resourceId": QUAY, "options": WHOLE}, "c-2")
            world.ask("match:search-requested", searching(around_a_resource=True), "c-3")
            await world.librarian.settled()
            assert world.answered_for("gather:referenced-by-failed") == ["c-1"]
            assert world.answered_for("gather:resource-failed") == ["c-2"]
            assert world.answered_for("match:search-failed") == ["c-3"]

            del world.graph.failing["get_resource_referenced_by"]
            world.ask("gather:referenced-by-requested", {"resourceId": QUAY}, "c-4")
            world.ask("gather:resource-requested", {"resourceId": QUAY, "options": WHOLE}, "c-5")
            world.ask("match:search-requested", searching(), "c-6")
            await world.librarian.settled()

            assert world.answered_for("gather:referenced-by-result") == ["c-4"]
            assert world.answered_for("gather:resource-complete") == ["c-5"]
            assert world.answered_for("match:search-results") == ["c-6"]

    run(scenario())


# ── Stopping ───────────────────────────────────────────────────────────


def test_a_stopped_librarian_gives_up_what_is_in_hand_takes_nothing_more_and_lets_go_of_every_wait() -> None:
    async def scenario() -> None:
        record = HeldRecord()
        record.hold(QUAY)
        async with World(record=record) as world:
            world.ask("gather:requested", {"annotationId": CROSSING, "resourceId": QUAY}, "c-1")
            world.ask("gather:summary-requested", {"annotationId": CROSSING, "resourceId": QUAY}, "c-2")
            waiting = asyncio.ensure_future(world.weave.when_applied(FERRY, 9, LONG))
            deciding = asyncio.ensure_future(world.smelt.when_settled(FERRY, "sum", LONG))
            await turns()
            assert record.asked == [QUAY, QUAY]
            assert not waiting.done()

            await world.librarian.__aexit__(None, None, None)

            # What was in hand is given up, unanswered, and both folds are closed: each wait is let go.
            assert world.transport.emitted == []
            await soon(waiting)
            assert await soon(deciding) == "inert"

            # Nothing more is taken: not a request, not a signal, not a request for limits.
            world.ask("gather:requested", {"annotationId": CROSSING, "resourceId": FERRY}, "c-3")
            world.ask("match:resources-requested", {"search": "quay"}, "c-4")
            world.ask("match:limits-requested", {}, "c-5")
            world.tell("smelt:settled", {"resourceId": FERRY, "contentChecksum": "sum", "outcome": "indexed"})
            await turns()
            assert record.asked == [QUAY, QUAY]
            assert world.graph.asked == []
            assert world.transport.emitted == []
            assert await soon(world.smelt.when_settled(FERRY, "sum", LONG)) == "inert"

    run(scenario())
