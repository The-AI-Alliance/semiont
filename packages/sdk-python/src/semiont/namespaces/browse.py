"""Browse: reads, and this viewer's own signals.

The queries (`Cached`) are asked when their `fresh` is called. The one-shot
reads are asked once. The signals are this viewer's own, with the one report
among them going over the wire.
"""

import asyncio
import codecs
from dataclasses import dataclass
from typing import Final, final

from semiont.cached import Cached
from semiont.channel import Operation
from semiont.channels import BROWSE_CLICK, BROWSE_RESOURCE_OPEN, BROWSE_RESOURCE_VIEWED
from semiont.errors import SemiontError, TransportError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.operations import (
    BROWSE_AGENTS_REQUESTED,
    BROWSE_ANCHORED_TEXT_REQUESTED,
    BROWSE_ANNOTATION_HISTORY_REQUESTED,
    BROWSE_ANNOTATION_REQUESTED,
    BROWSE_ANNOTATIONS_REQUESTED,
    BROWSE_DIRECTORY_REQUESTED,
    BROWSE_ENTITY_TYPES_REQUESTED,
    BROWSE_EVENTS_REQUESTED,
    BROWSE_KB_REQUESTED,
    BROWSE_RESOURCE_REQUESTED,
    BROWSE_RESOURCES_REQUESTED,
    BROWSE_TAG_SCHEMAS_REQUESTED,
    LIMITS_OPERATIONS,
)
from semiont.transport import Content, ContentStream, ContentTransport
from semiont.types import (
    AgentSoftware,
    AnchoredTextAnswer,
    Annotation,
    AttributedEvent,
    BrowseAgentsRequest,
    BrowseAnchoredTextRequest,
    BrowseAnnotationHistoryRequest,
    BrowseAnnotationRequest,
    BrowseAnnotationsRequest,
    BrowseClickEvent,
    BrowseDirectoryRequest,
    BrowseDirectoryRequestSort,
    BrowseDirectoryResultResponse,
    BrowseEntityTypesRequest,
    BrowseEventsRequest,
    BrowseKbRequest,
    BrowseResourceOpenEvent,
    BrowseResourceRequest,
    BrowseResourcesRequest,
    BrowseResourceViewedEvent,
    BrowseTagSchemasRequest,
    CollaboratorEntry,
    CommandError,
    GetAnnotationHistoryResponse,
    GetResourceResponse,
    InferenceLimits,
    InferenceLimitsRequest,
    InferenceLimitsResult,
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

    def __init__(self, links: Links, content: ContentTransport) -> None:
        self._links: Final = links
        self._content: Final = content

    # ── Queries ─────────────────────────────────────────────────────────

    def resource(self, resource_id: ResourceId) -> Cached[ResourceDescriptor]:
        """A resource's description."""
        return Cached(lambda: self._resource(resource_id))

    async def _resource(self, resource_id: ResourceId) -> ResourceDescriptor:
        return (await self._links.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource_id))).response.resource

    def resources(
        self, *, limit: int = _LIST_LIMIT, archived: bool | None = None, entity_type: str | None = None
    ) -> Cached[ListResourcesResponse]:
        """A page of the resources the filters admit: the first hundred when no limit is stated.

        Finding resources by text is `match.resources`.
        """
        request = BrowseResourcesRequest(limit=limit, offset=0, archived=archived, entity_type=entity_type)
        return Cached(lambda: self._resources(request))

    async def _resources(self, request: BrowseResourcesRequest) -> ListResourcesResponse:
        return (await self._links.request(BROWSE_RESOURCES_REQUESTED, request)).response

    def annotations(self, resource_id: ResourceId) -> Cached[list[Annotation]]:
        """A resource's annotations."""
        return Cached(lambda: self._annotations(resource_id))

    async def _annotations(self, resource_id: ResourceId) -> list[Annotation]:
        answer = await self._links.request(BROWSE_ANNOTATIONS_REQUESTED, BrowseAnnotationsRequest(resource_id=resource_id))
        return answer.response.annotations

    def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Cached[Annotation]:
        """One annotation of a resource."""
        return Cached(lambda: self._annotation(resource_id, annotation_id))

    async def _annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Annotation:
        request = BrowseAnnotationRequest(resource_id=resource_id, annotation_id=annotation_id)
        return (await self._links.request(BROWSE_ANNOTATION_REQUESTED, request)).response.annotation

    def entity_types(self) -> Cached[list[str]]:
        """The knowledge base's entity types."""
        return Cached(self._entity_types)

    async def _entity_types(self) -> list[str]:
        return (await self._links.request(BROWSE_ENTITY_TYPES_REQUESTED, BrowseEntityTypesRequest())).response.entity_types

    def tag_schemas(self) -> Cached[list[TagSchema]]:
        """The knowledge base's tag schemas."""
        return Cached(self._tag_schemas)

    async def _tag_schemas(self) -> list[TagSchema]:
        return (await self._links.request(BROWSE_TAG_SCHEMAS_REQUESTED, BrowseTagSchemasRequest())).response.tag_schemas

    def agents(self) -> Cached[list[Collaborator]]:
        """The knowledge base's collaborators.

        The directory, asked for first, with each model's limits as the
        services holding its credentials report them.
        """
        return Cached(self._agents)

    async def _agents(self) -> list[Collaborator]:
        directory = self._links.run(self._directory())
        # A holder that is down, silent or mistaken reports none: its models
        # show no limits, and the directory is not held up by it for longer
        # than a request waits.
        reports = [self._links.run(self._limits_reported(holder)) for holder in LIMITS_OPERATIONS]
        try:
            entries = await directory
            reported = [pair for report in await asyncio.gather(*reports) for pair in report]
        except BaseException:
            for asked in (directory, *reports):
                asked.cancel()
            raise
        return _joined(entries, reported)

    async def _directory(self) -> list[CollaboratorEntry]:
        return (await self._links.request(BROWSE_AGENTS_REQUESTED, BrowseAgentsRequest())).response.agents

    async def _limits_reported(
        self, holder: Operation[InferenceLimitsRequest, InferenceLimitsResult, CommandError]
    ) -> list[InferencePairLimits]:
        """The models one key holder reports the limits of."""
        try:
            return (await self._links.request(holder, InferenceLimitsRequest())).response.limits
        except SemiontError:
            return []

    def events(self, resource_id: ResourceId) -> Cached[list[AttributedEvent]]:
        """A resource's events, each with who it is attributed to."""
        return Cached(lambda: self.resource_events(resource_id))

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
        return (await self._links.request(BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resource_id=resource_id))).response.events

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
