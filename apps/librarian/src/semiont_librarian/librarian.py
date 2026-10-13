"""The Librarian: what takes each request of the bus that needs the graph, the index or a model, and answers it.

`docs/protocol/LIBRARIAN.md` states what it does, rule by rule. Held with
`async with`: it takes frames from the way in to the way out. It reads
through what it is handed and through nothing else: it knows no address, no
directory and no database, and it asks nothing over the bus.

**One stream.** Every frame the transport delivers is taken as it is
delivered, whatever its channel, in the order of delivery (§ What it
answers). A signal, `weave:applied` or `smelt:settled`, is noted in its fold
at once, in that order, and never waits behind a request: a gather that is
waiting for one is in hand when it comes.

**The order it works in** (§ Order). A gather around an annotation takes its
turn in a lane of its resource's, and a gather around a resource in another
lane of its resource's (`semiont_service.lanes`): gathers of one kind for one
resource are handled one at a time, in the order they arrived, and the lanes
work beside each other. Reference searches take their turn in one lane, so
one is made at a time. A text search, a request for what refers to a
resource and a summary are each handled as they arrive, beside whatever else
is in hand. The two limits requests are answered as they arrive too, by what
every service that holds a model answers them with
(`semiont_inference.limits_report`), which listens for them itself.

**A request is answered once**, under its correlation id: on its result
channel, or on its failure channel where what handles it raises. A request
that fails ends nothing: the next is handled. A frame that is not its
channel's is logged, and answered as a failure where it states enough to be.

**Who is named.** The replies to a text search and to what refers to a
resource have their people named, each by what handles it (§ Names). The
reply to a reference search names no one.

**Stopping** (§ Stopping). On the way out no frame is taken any more, what is
in hand is given up, and the two folds are closed, which lets go of every
wait. Nothing else it was handed is closed: each is whoever made it's to
close.
"""

import asyncio
from collections.abc import Awaitable, Callable, Coroutine, Mapping
from datetime import datetime
from functools import partial
from types import TracebackType
from typing import Final, Self, final, override

from pydantic import JsonValue, ValidationError
from semiont import telemetry
from semiont.bus import Bus, decoded
from semiont.channel import Channel, Response
from semiont.channels import SMELT_SETTLED, WEAVE_APPLIED
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import WireModel
from semiont.operations import (
    GATHER_LIMITS_REQUESTED,
    GATHER_REFERENCED_BY_REQUESTED,
    GATHER_REQUESTED,
    GATHER_RESOURCE_REQUESTED,
    GATHER_SUMMARY_REQUESTED,
    MATCH_LIMITS_REQUESTED,
    MATCH_RESOURCES_REQUESTED,
    MATCH_SEARCH_REQUESTED,
)
from semiont.transport import Frame, FrameSink, Transport
from semiont.types import (
    CommandError,
    ContextualSummaryResponse,
    GatherAnnotationComplete,
    GatherAnnotationRequest,
    GatherFailed,
    GatherReferencedByRequest,
    GatherReferencedByResult,
    GatherResourceComplete,
    GatherResourceFailed,
    GatherResourceRequest,
    GatherSummaryRequest,
    MatchResourcesRequest,
    MatchResourcesResult,
    MatchSearchFailed,
    MatchSearchRequest,
    MatchSearchResult,
)
from semiont_inference.interface import InferenceClient
from semiont_inference.limits_report import answer_limits_requests
from semiont_service.content import ContentReads
from semiont_service.lanes import Lanes
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import VectorReader

from semiont_librarian.annotation_gather import gather as gather_annotation
from semiont_librarian.log import LOG
from semiont_librarian.progress import SmeltProgress, WeaveProgress
from semiont_librarian.reads import AnchoredText, Degraded, GraphReads, People, Views
from semiont_librarian.reference_search import search as search_references
from semiont_librarian.referenced_by import answer as answer_referenced_by
from semiont_librarian.resource_gather import gather as gather_resource
from semiont_librarian.summary import summarize
from semiont_librarian.text_search import answer as answer_text_search

__all__ = ["Librarian", "words_of"]

_SEARCHES: Final = "match:search-requested"
"""The one lane every reference search takes its turn in."""


def words_of(failure: BaseException) -> str:
    """A failure, in a line: what kind it is, and what it says."""
    return f"{type(failure).__name__}: {failure}"


def _lacking(unread: ValidationError) -> str:
    """What a payload that is not its channel's was refused for: each member refused, by its name, and nothing the payload held."""
    refusals = unread.errors(include_url=False, include_input=False)
    members = sorted({".".join(str(step) for step in refusal["loc"]) or "the payload" for refusal in refusals})
    return ", ".join(members)


def _annotation_named(payload: Mapping[str, JsonValue], member: str) -> AnnotationId | None:
    """The annotation a payload names under `member`, where it names one."""
    stated = payload.get(member)
    return AnnotationId.parse(stated) if isinstance(stated, str) else None


def _resource_named(payload: Mapping[str, JsonValue], member: str) -> ResourceId | None:
    """The resource a payload names under `member`, where it names one."""
    stated = payload.get(member)
    return ResourceId.parse(stated) if isinstance(stated, str) else None


def _search_unread(payload: Mapping[str, JsonValue], said: str) -> MatchSearchFailed | None:
    """The failure of a reference search that could not be read: it names the reference, so it is none where no reference is named."""
    reference = _annotation_named(payload, "referenceId")
    return None if reference is None else MatchSearchFailed(reference_id=reference, error=said)


def _gather_unread(payload: Mapping[str, JsonValue], said: str) -> GatherFailed | None:
    """The failure of a gather around an annotation that could not be read: none where no annotation is named."""
    annotation = _annotation_named(payload, "annotationId")
    return None if annotation is None else GatherFailed(annotation_id=annotation, message=said)


def _resource_gather_unread(payload: Mapping[str, JsonValue], said: str) -> GatherResourceFailed | None:
    """The failure of a gather around a resource that could not be read: none where no resource is named."""
    resource = _resource_named(payload, "resourceId")
    return None if resource is None else GatherResourceFailed(resource_id=resource, message=said)


def _command_unread(payload: Mapping[str, JsonValue], said: str) -> CommandError | None:
    """The failure of a request that could not be read, where a failure names nothing of its request."""
    return CommandError(message=said)


@final
class _Delivered(FrameSink):
    """Where a Librarian's transport delivers every frame: to the Librarian, as each is delivered."""

    def __init__(self, librarian: "Librarian") -> None:
        self._librarian: Final = librarian

    @override
    def deliver(self, frame: Frame) -> None:
        self._librarian.delivered(frame)


@final
class Librarian:
    """A Librarian over what it is handed to read by, reaching the bus through `transport`.

    `views` and `people` are what the Archivist writes; `graph` the six reads
    of the graph; `vectors` the index, connected, and `embedding` what makes
    a query's vector; `matcher` and `gatherer` the models of its two actors;
    `content` what reads a resource's bytes, and `anchored` what asks for its
    anchored text; `weave` and `smelt` the two folds, which it tells of each
    signal and closes on the way out; `degraded` what counts a gather that
    went without something; `now` the clock a reference search counts
    recency by; `settle_within` the settle bound, in seconds; and
    `semantic_floor` the least score a resource needs to be found by
    meaning.

    The transport's stream names the eight request channels and the two
    signals before it is entered.
    """

    def __init__(
        self,
        *,
        views: Views,
        people: People,
        graph: GraphReads,
        vectors: VectorReader,
        embedding: EmbeddingProvider,
        matcher: InferenceClient,
        gatherer: InferenceClient,
        content: ContentReads,
        anchored: AnchoredText,
        weave: WeaveProgress,
        smelt: SmeltProgress,
        degraded: Degraded,
        now: Callable[[], datetime],
        settle_within: float,
        semantic_floor: float,
        transport: Transport,
    ) -> None:
        self._views: Final = views
        self._people: Final = people
        self._graph: Final = graph
        self._vectors: Final = vectors
        self._embedding: Final = embedding
        self._matcher: Final = matcher
        self._gatherer: Final = gatherer
        self._content: Final = content
        self._anchored: Final = anchored
        self._weave: Final = weave
        self._smelt: Final = smelt
        self._degraded: Final = degraded
        self._now: Final = now
        self._settle_within: Final = settle_within
        self._semantic_floor: Final = semantic_floor
        self._transport: Final = transport
        self._bus: Final = Bus(transport)
        self._lanes: Final = Lanes()
        self._answering: Final[list[asyncio.Task[None]]] = []
        """What answers the two limits requests, each for as long as the Librarian is held."""
        self._doing: Final[set[asyncio.Task[None]]] = set()
        """What is handled beside everything else, each until it is answered."""
        self._stopping = False

    # ── From the way in to the way out ─────────────────────────────────

    async def __aenter__(self) -> Self:
        # Every frame the transport delivers from here on is handed over as it is delivered, whatever its channel:
        # one stream, in the order of delivery.
        self._transport.bridge_into(_Delivered(self))
        loop = asyncio.get_running_loop()
        # Each actor holds its model's key, so each answers for its model's limits.
        self._answering.append(loop.create_task(answer_limits_requests(self._bus, MATCH_LIMITS_REQUESTED, (self._matcher,))))
        self._answering.append(loop.create_task(answer_limits_requests(self._bus, GATHER_LIMITS_REQUESTED, (self._gatherer,))))
        # One turn, in which each of the two begins to listen: entered, a Librarian is taking every frame it answers.
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._stopping = True
        owned = [*self._answering, *self._doing]
        for task in owned:
            task.cancel()
        await asyncio.gather(*owned, return_exceptions=True)
        await self._lanes.aclose()
        await self._weave.aclose()
        await self._smelt.aclose()

    async def settled(self) -> None:
        """Wait until every request it was handed is answered, but for the limits requests.

        What a test waits on. Nothing of the service does: a Librarian that
        is taking frames is never done.
        """
        await asyncio.gather(*self._doing, return_exceptions=True)
        await self._lanes.settled()

    # ── Taking a frame ─────────────────────────────────────────────────

    def delivered(self, frame: Frame) -> None:
        """Take a frame the transport delivered: a signal is noted at once, and a request is handed to what answers it, in its order.

        A frame of any other channel is passed by: a transport that delivers
        what was emitted through it delivers a Librarian its own replies.
        """
        if self._stopping:
            return
        match frame.channel:
            case "weave:applied":
                applied = self._signalled(frame, WEAVE_APPLIED)
                if applied is not None:
                    self._weave.noted(applied.resource_id, applied.sequence_number)
            case "smelt:settled":
                decided = self._signalled(frame, SMELT_SETTLED)
                if decided is not None:
                    self._smelt.noted(decided.resource_id, decided.content_checksum, decided.outcome)
            case "gather:requested":
                around = self._asked(frame, GATHER_REQUESTED.request, GATHER_REQUESTED.failure, _gather_unread)
                if around is not None:
                    self._lanes.put(f"{frame.channel} {around.resource_id}", partial(self._gather_annotation, frame, around))
            case "gather:resource-requested":
                whole = self._asked(frame, GATHER_RESOURCE_REQUESTED.request, GATHER_RESOURCE_REQUESTED.failure, _resource_gather_unread)
                if whole is not None:
                    self._lanes.put(f"{frame.channel} {whole.resource_id}", partial(self._gather_resource, frame, whole))
            case "match:search-requested":
                reference = self._asked(frame, MATCH_SEARCH_REQUESTED.request, MATCH_SEARCH_REQUESTED.failure, _search_unread)
                if reference is not None:
                    self._lanes.put(_SEARCHES, partial(self._search_references, frame, reference))
            case "match:resources-requested":
                text = self._asked(frame, MATCH_RESOURCES_REQUESTED.request, MATCH_RESOURCES_REQUESTED.failure, _command_unread)
                if text is not None:
                    self._beside(self._search_text(frame, text))
            case "gather:referenced-by-requested":
                referring = self._asked(
                    frame, GATHER_REFERENCED_BY_REQUESTED.request, GATHER_REFERENCED_BY_REQUESTED.failure, _command_unread
                )
                if referring is not None:
                    self._beside(self._refer(frame, referring))
            case "gather:summary-requested":
                passage = self._asked(frame, GATHER_SUMMARY_REQUESTED.request, GATHER_SUMMARY_REQUESTED.failure, _command_unread)
                if passage is not None:
                    self._beside(self._summarize(frame, passage))
            case _:
                # The two limits requests among them: what answers those listens for them itself.
                return

    def _signalled[P: WireModel](self, frame: Frame, channel: Channel[P]) -> P | None:
        """A signal's payload as its channel types it. Nothing for one that is not its channel's, which is logged and passed by."""
        try:
            return decoded(channel, frame.payload)
        except ValidationError as unread:
            LOG.error("A signal that is not its channel's was passed by", extra={"channel": frame.channel, "lacking": _lacking(unread)})
            return None

    def _asked[Q: WireModel, F: WireModel](
        self, frame: Frame, request: Channel[Q], failure: Channel[F], unread_as: Callable[[Mapping[str, JsonValue], str], F | None]
    ) -> Q | None:
        """A request's payload as its channel types it.

        Nothing for one that is not its channel's. It is logged, and where
        it has a correlation id and states what its failure names, it is
        answered on its failure channel. The failure says which members were
        refused, and nothing of what they held.
        """
        try:
            return decoded(request, frame.payload)
        except ValidationError as unread:
            lacking = _lacking(unread)
            LOG.error(
                "A request that is not its channel's was not handled",
                extra={"channel": frame.channel, "correlationId": frame.correlation_id, "lacking": lacking},
            )
            said = f"The request on {frame.channel} is not what that channel carries: {lacking}"
            refusal = None if frame.correlation_id is None else unread_as(frame.payload, said)
            if refusal is not None:
                self._beside(self._say(failure, refusal, frame.correlation_id))
            return None

    def _beside(self, work: Coroutine[None, None, None]) -> None:
        """Begin a piece of work beside whatever else is in hand. The Librarian keeps it until it is done, and gives it up when it stops."""
        task = asyncio.get_running_loop().create_task(work)
        self._doing.add(task)
        task.add_done_callback(self._doing.discard)

    # ── Answering ──────────────────────────────────────────────────────

    async def _answer[R: WireModel, F: WireModel](
        self, frame: Frame, result: Channel[R], failure: Channel[F], handle: Callable[[], Awaitable[R]], failed: Callable[[str], F]
    ) -> None:
        """Handle one request, and answer it: on `result` with what `handle` answers, or on `failure` with what it raised.

        It is handled in the trace its frame was sent under. It raises
        nothing but its being cancelled: what handling a request failed
        with is that request's answer, and no other request's.
        """
        with telemetry.continuing(frame.trace):
            try:
                reply = await handle()
            except Exception as raised:
                LOG.error(
                    "A request failed, and is answered on its failure channel",
                    extra={"channel": frame.channel, "correlationId": frame.correlation_id, "error": words_of(raised)},
                )
                await self._say(failure, failed(str(raised)), frame.correlation_id)
                return
            await self._say(result, reply, frame.correlation_id)

    async def _say[P: WireModel](self, channel: Channel[P], payload: P, correlation_id: str | None) -> None:
        """Send a reply, under the correlation id of its request.

        One that cannot be sent is logged, and ends nothing: whoever asked
        is left to the end of its own wait.
        """
        try:
            await self._bus.emit(channel, payload, correlation_id=correlation_id)
        except Exception as unsent:
            LOG.error(
                "A reply could not be sent", extra={"channel": channel.name, "correlationId": correlation_id, "error": words_of(unsent)}
            )

    async def _gather_annotation(self, frame: Frame, request: GatherAnnotationRequest) -> None:
        """Answer a `gather:requested`: the context gathered around an annotation, with the annotation it was asked for."""

        async def gathered() -> GatherAnnotationComplete:
            context = await gather_annotation(
                request,
                views=self._views,
                content=self._content,
                anchored=self._anchored,
                graph=self._graph,
                vectors=self._vectors,
                weave=self._weave,
                embedding=self._embedding,
                inference=self._gatherer,
                degraded=self._degraded,
            )
            return GatherAnnotationComplete(annotation_id=request.annotation_id, response=context)

        def failed(said: str) -> GatherFailed:
            return GatherFailed(annotation_id=request.annotation_id, message=said)

        await self._answer(frame, GATHER_REQUESTED.result, GATHER_REQUESTED.failure, gathered, failed)

    async def _gather_resource(self, frame: Frame, request: GatherResourceRequest) -> None:
        """Answer a `gather:resource-requested`: the context gathered around a resource, with the resource it was asked for."""

        async def gathered() -> GatherResourceComplete:
            context = await gather_resource(
                request,
                views=self._views,
                content=self._content,
                anchored=self._anchored,
                graph=self._graph,
                vectors=self._vectors,
                weave=self._weave,
                smelt=self._smelt,
                inference=self._gatherer,
                degraded=self._degraded,
                settle_within=self._settle_within,
            )
            return GatherResourceComplete(resource_id=request.resource_id, response=context)

        def failed(said: str) -> GatherResourceFailed:
            return GatherResourceFailed(resource_id=request.resource_id, message=said)

        await self._answer(frame, GATHER_RESOURCE_REQUESTED.result, GATHER_RESOURCE_REQUESTED.failure, gathered, failed)

    async def _search_references(self, frame: Frame, request: MatchSearchRequest) -> None:
        """Answer a `match:search-requested`: the candidates of a reference, by score. Its failure names the reference, under `error`."""

        async def searched() -> MatchSearchResult:
            return await search_references(
                request,
                graph=self._graph,
                views=self._views,
                vectors=self._vectors,
                embedding=self._embedding,
                inference=self._matcher,
                people=self._people,
                now=self._now,
            )

        def failed(said: str) -> MatchSearchFailed:
            return MatchSearchFailed(reference_id=request.reference_id, error=said)

        await self._answer(frame, MATCH_SEARCH_REQUESTED.result, MATCH_SEARCH_REQUESTED.failure, searched, failed)

    async def _search_text(self, frame: Frame, request: MatchResourcesRequest) -> None:
        """Answer a `match:resources-requested`: the page a text finds, its people named."""

        async def searched() -> MatchResourcesResult:
            return await answer_text_search(
                request,
                graph=self._graph,
                views=self._views,
                vectors=self._vectors,
                embedding=self._embedding,
                semantic_floor=self._semantic_floor,
                content=self._content,
                people=self._people,
            )

        def failed(said: str) -> CommandError:
            return CommandError(message=said)

        await self._answer(frame, MATCH_RESOURCES_REQUESTED.result, MATCH_RESOURCES_REQUESTED.failure, searched, failed)

    async def _refer(self, frame: Frame, request: GatherReferencedByRequest) -> None:
        """Answer a `gather:referenced-by-requested`: what refers to a resource, its people named."""

        async def referred() -> GatherReferencedByResult:
            return await answer_referenced_by(request, graph=self._graph, views=self._views, people=self._people)

        def failed(said: str) -> CommandError:
            return CommandError(message=said)

        await self._answer(frame, GATHER_REFERENCED_BY_REQUESTED.result, GATHER_REFERENCED_BY_REQUESTED.failure, referred, failed)

    async def _summarize(self, frame: Frame, request: GatherSummaryRequest) -> None:
        """Answer a `gather:summary-requested`: what the Gatherer's model says of a passage where it stands."""

        async def summarized() -> Response[ContextualSummaryResponse]:
            summary = await summarize(request, views=self._views, content=self._content, anchored=self._anchored, inference=self._gatherer)
            return Response[ContextualSummaryResponse](response=summary)

        def failed(said: str) -> CommandError:
            return CommandError(message=said)

        await self._answer(frame, GATHER_SUMMARY_REQUESTED.result, GATHER_SUMMARY_REQUESTED.failure, summarized, failed)
