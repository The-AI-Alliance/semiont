"""Browse: reads, and this viewer's own signals.

The queries (`Cached`) answer from the client's cache: one read with `fresh`,
or held with `async with` and watched. The one-shot reads are asked once. The
signals are this viewer's own, with the one report among them going over the
wire.
"""

import asyncio
import codecs
from collections.abc import AsyncIterator, Callable, Hashable
from dataclasses import dataclass
from typing import Final, Self, final, override

from semiont.cache import Cache, CacheState, Ready
from semiont.cached import Cached, Keyed, Source, itself, shown
from semiont.channels import BROWSE_CLICK, BROWSE_RESOURCE_OPEN, BROWSE_RESOURCE_VIEWED
from semiont.errors import SemiontError, TransportError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.namespaces.live import LIMITS_HOLDERS, WHOLE, Live, ResourceFilters
from semiont.operations import (
    BROWSE_ANCHORED_TEXT_REQUESTED,
    BROWSE_ANNOTATION_HISTORY_REQUESTED,
    BROWSE_DIRECTORY_REQUESTED,
    BROWSE_KB_REQUESTED,
)
from semiont.transport import Content, ContentStream, ContentTransport, ResourceHold
from semiont.types import (
    AgentSoftware,
    AnchoredTextAnswer,
    Annotation,
    AttributedEvent,
    BrowseAnchoredTextRequest,
    BrowseAnnotationHistoryRequest,
    BrowseClickEvent,
    BrowseDirectoryRequest,
    BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse,
    BrowseKbRequest,
    BrowseResourceOpenEvent,
    BrowseResourceViewedEvent,
    CollaboratorEntry,
    GetAnnotationHistoryResponse,
    GetAnnotationsResponse,
    GetResourceResponse,
    InferenceLimits,
    InferencePairLimits,
    KbDescription,
    ListResourcesResponse,
    ResourceDescriptor,
    TagSchema,
)

__all__ = ["BrowseNamespace", "Collaborator"]

# How many resources a list asks for when its caller states no limit. Every
# SDK asks for as many: the cases of specs/src/client/surface.json hold each to it.
_LIST_LIMIT: Final = 100

# What a browser reads these labels as: the Encoding Standard gives them to
# windows-1252, of which each is a part.
_READ_AS_WINDOWS_1252: Final = frozenset({"iso-8859-1", "iso8859-1", "latin1", "l1", "ascii", "us-ascii"})


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Collaborator:
    """One of the knowledge base's collaborators.

    Its entry in the directory, and its model's limits when the service
    holding that model's credentials reported them.
    """

    entry: CollaboratorEntry
    limits: InferenceLimits | None = None


def _joined(directory: list[CollaboratorEntry], reported: list[InferencePairLimits]) -> list[Collaborator]:
    """The directory with each reported model's limits on its entries."""
    by_model = {(pair.provider, pair.model): pair.limits for pair in reversed(reported)}
    return [
        Collaborator(
            entry=entry,
            limits=by_model.get((entry.agent.provider, entry.agent.model))
            if isinstance(entry.agent, AgentSoftware) and entry.agent.provider is not None and entry.agent.model is not None
            else None,
        )
        for entry in directory
    ]


def _listed(answer: GetAnnotationsResponse) -> list[Annotation]:
    return answer.annotations


async def _next[S](states: AsyncIterator[S]) -> S | None:
    """The next state, or nothing when there will be no other."""
    return await anext(states, None)


@final
class _Joined:
    """The directory's state, with what the key holders have reported so far.

    A holder that has not answered delays only its own models' limits.
    """

    def __init__(
        self,
        directory: AsyncIterator[CacheState[list[CollaboratorEntry]]],
        reports: list[AsyncIterator[CacheState[list[InferencePairLimits]]]],
    ) -> None:
        self._directory: Final = directory
        self._reports: Final = reports
        self._entries: CacheState[list[CollaboratorEntry]] | None = None
        self._reported: Final[list[list[InferencePairLimits]]] = [[] for _ in reports]
        self._shown: CacheState[list[Collaborator]] | None = None
        """The state last given: a report that changes nothing a watcher is shown is not a state."""

    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> CacheState[list[Collaborator]]:
        while True:
            directory = asyncio.ensure_future(_next(self._directory))
            reports = [asyncio.ensure_future(_next(report)) for report in self._reports]
            waits: list[asyncio.Task[object]] = [directory, *reports]
            try:
                await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            finally:
                # One that has not answered has taken nothing: it is asked again the next time.
                for wait in waits:
                    wait.cancel()
            changed = False
            if directory.done():
                entries = directory.result()
                if entries is None:
                    raise StopAsyncIteration
                self._entries, changed = entries, True
            for index, report in enumerate(reports):
                if report.done():
                    state = report.result()
                    if state is None:
                        # The caches end together, when their client closes.
                        raise StopAsyncIteration
                    # A holder's report is pending, then what it reported: it never fails (`Live`).
                    if isinstance(state, Ready):
                        self._reported[index], changed = state.value, True
            if self._entries is not None and changed:
                joined = shown(self._entries, self._with_limits)
                if joined != self._shown:
                    self._shown = joined
                    return joined

    def _with_limits(self, entries: list[CollaboratorEntry]) -> list[Collaborator]:
        return _joined(entries, [pair for report in self._reported for pair in report])


@final
class _Collaborators(Source[list[Collaborator]]):
    """The collaborator directory with each key holder's limits joined on."""

    def __init__(self, live: Live) -> None:
        self._live: Final = live

    @override
    async def fresh(self) -> list[Collaborator]:
        try:
            async with asyncio.TaskGroup() as asking:
                # The directory is asked for first; each key holder's limits after it.
                directory = asking.create_task(self._live.agents.fetch(WHOLE))
                reports = [asking.create_task(self._live.limits.fetch(holder)) for holder in LIMITS_HOLDERS]
        except* SemiontError as failed:
            # The directory's failure, or the client's closing: a holder that fails reports none, and fails nothing.
            raise failed.exceptions[0] from None
        return _joined(directory.result(), [pair for report in reports for pair in report.result()])

    @override
    def watch(self) -> AsyncIterator[CacheState[list[Collaborator]]]:
        directory = self._live.agents.observe(WHOLE)
        return _Joined(directory, [self._live.limits.observe(holder) for holder in LIMITS_HOLDERS])

    @override
    def invalidate(self) -> None:
        self._live.invalidate_agents()

    @override
    def hold(self) -> ResourceHold | None:
        return None


def _charset(media_type: str) -> str | None:
    """The charset a media type states, in lower case."""
    lower = media_type.lower()
    _, found, stated = lower.partition("charset=")
    if found == "":
        return None
    for index, character in enumerate(stated):
        if character.isspace() or character == ";":
            return stated[:index]
    return stated


def _text(content: Content) -> str:
    """Bytes as the text their media type says they are.

    In the encoding the charset names, UTF-8 when none is stated; a leading
    byte-order mark is not part of the text; and a sequence the encoding does
    not have becomes U+FFFD. A charset there is no decoder for is refused by
    name rather than read as something it is not: the bytes are there to
    decode (`resource_representation`).
    """
    label = (_charset(content.content_type) or "utf-8").strip("\"'")
    try:
        decoder = codecs.lookup("windows-1252" if label in _READ_AS_WINDOWS_1252 else label)
    except LookupError:
        raise TransportError(
            "error", f"The resource's text is {label}, which this build decodes no text from: read its bytes instead"
        ) from None
    return decoder.decode(content.data, "replace")[0].removeprefix("\ufeff")


@final
class BrowseNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links, content: ContentTransport, live: Live) -> None:
        self._links: Final = links
        self._content: Final = content
        self._live: Final = live

    # ── Queries ─────────────────────────────────────────────────────────

    def _of[K: Hashable, V, T](self, resource_id: ResourceId, cache: Cache[K, V], key: K, view: Callable[[V], T]) -> Cached[T]:
        """A query of one resource: watching it holds the resource's scope."""
        return self._live.query(Keyed(cache, key, view, scope=(self._links.wire.transport, resource_id)))

    def resource(self, resource_id: ResourceId) -> Cached[ResourceDescriptor]:
        """A resource's description."""
        return self._of(resource_id, self._live.resource, resource_id, itself)

    def resources(
        self, *, limit: int = _LIST_LIMIT, archived: bool | None = None, entity_type: str | None = None
    ) -> Cached[ListResourcesResponse]:
        """A page of the resources the filters admit: the first hundred when no limit is stated.

        It is kept true by what every client hears and by the events of the
        resources this client holds the scope of, and by nothing else.
        Finding resources by text is `match.resources`.
        """
        return self._live.query(Keyed(self._live.lists, ResourceFilters(limit, archived, entity_type), itself))

    def annotations(self, resource_id: ResourceId) -> Cached[list[Annotation]]:
        """A resource's annotations."""
        return self._of(resource_id, self._live.annotations, resource_id, _listed)

    def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Cached[Annotation]:
        """One annotation of a resource."""
        self._live.annotation_of[annotation_id] = resource_id
        return self._of(resource_id, self._live.annotation, annotation_id, itself)

    def entity_types(self) -> Cached[list[str]]:
        """The knowledge base's entity types."""
        return self._live.query(Keyed(self._live.entity_types, WHOLE, itself))

    def tag_schemas(self) -> Cached[list[TagSchema]]:
        """The knowledge base's tag schemas."""
        return self._live.query(Keyed(self._live.tag_schemas, WHOLE, itself))

    def agents(self) -> Cached[list[Collaborator]]:
        """The knowledge base's collaborators.

        The directory, asked for first, with each model's limits as the
        services holding its credentials report them.
        """
        return self._live.query(_Collaborators(self._live))

    def events(self, resource_id: ResourceId) -> Cached[list[AttributedEvent]]:
        """A resource's events, each with who it is attributed to."""
        return self._of(resource_id, self._live.events, resource_id, itself)

    # ── One-shot reads ──────────────────────────────────────────────────

    async def resource_content(self, resource_id: ResourceId) -> str:
        """A resource's bytes as text, in the charset their media type states: UTF-8 when it states none."""
        return _text(await self._content.get_binary(resource_id))

    async def resource_graph(self, resource_id: ResourceId) -> GetResourceResponse:
        """A resource's description as linked data: itself, its annotations and the references to it."""
        return await self._content.get_resource_graph(resource_id)

    async def resource_anchored_text(self, resource_id: ResourceId) -> AnchoredTextAnswer:
        """A resource's recovered text and the runs that index it, or the named reason there is none."""
        answer = await self._links.request(BROWSE_ANCHORED_TEXT_REQUESTED, BrowseAnchoredTextRequest(resource_id=resource_id))
        return answer.response

    async def resource_representation(self, resource_id: ResourceId) -> Content:
        """A resource's bytes, unchanged, with their media type."""
        return await self._content.get_binary(resource_id)

    async def resource_representation_stream(self, resource_id: ResourceId) -> ContentStream:
        """The same, as a stream."""
        return await self._content.get_binary_stream(resource_id)

    async def resource_events(self, resource_id: ResourceId) -> list[AttributedEvent]:
        """A resource's events, each with who it is attributed to."""
        return await self._live.events_of(resource_id)

    async def annotation_history(self, resource_id: ResourceId, annotation_id: AnnotationId) -> GetAnnotationHistoryResponse:
        """The events of one annotation."""
        request = BrowseAnnotationHistoryRequest(resource_id=resource_id, annotation_id=annotation_id)
        return (await self._links.request(BROWSE_ANNOTATION_HISTORY_REQUESTED, request)).response

    async def files(self, path: str = ".", *, sort: BrowseDirectoryRequestSort = "name") -> BrowseDirectoryResultResponse:
        """The entries of a directory of the knowledge base's tree: its root when no path is stated, by name when no order is."""
        return (await self._links.request(BROWSE_DIRECTORY_REQUESTED, BrowseDirectoryRequest(path=path, sort=sort))).response

    async def kb(self) -> KbDescription:
        """What the knowledge base says of itself: its name and domain, and its working tree's branch.

        Asked every time: a branch changes with no event to say so.
        """
        return (await self._links.request(BROWSE_KB_REQUESTED, BrowseKbRequest())).response

    # ── Signals ─────────────────────────────────────────────────────────

    def click(self, annotation_id: AnnotationId) -> None:
        """Signal: open an annotation for this viewer."""
        self._links.signal(BROWSE_CLICK, BrowseClickEvent(annotation_id=annotation_id))

    def open_resource(self, resource_id: ResourceId) -> None:
        """Signal: open a resource for this viewer."""
        self._links.signal(BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resource_id=resource_id))

    def resource_viewed(self, resource_id: ResourceId) -> None:
        """Report that this viewer is looking at a resource. It goes over the wire, and nobody awaits it."""
        self._links.report(BROWSE_RESOURCE_VIEWED, BrowseResourceViewedEvent(resource_id=resource_id))
