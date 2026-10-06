"""Gather: assembling the context a model is given, and what refers to a resource."""

from collections.abc import Sequence
from typing import Final, final

from semiont.cached import Cached, Keyed, itself
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.namespaces.live import Live
from semiont.operations import GATHER_REQUESTED, GATHER_RESOURCE_REQUESTED
from semiont.running import Running
from semiont.types import (
    GatherAnnotationComplete,
    GatherAnnotationOptions,
    GatherAnnotationRequest,
    GatheredContext,
    GatherResourceRequest,
    GatherResourceRequestOptions,
    GetReferencedByResponseReferencedByItem,
)

__all__ = ["GatherNamespace"]

# What a caller that states nothing is given. Every SDK sends the same: the
# cases of specs/src/client/surface.json hold each to it.
_CONTEXT_WINDOW: Final = 2000
_DEPTH: Final = 2
_MAX_RESOURCES: Final = 10


@final
class GatherNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links, live: Live) -> None:
        self._links: Final = links
        self._live: Final = live

    def annotation(
        self, resource_id: ResourceId, annotation_id: AnnotationId, *, context_window: int = _CONTEXT_WINDOW
    ) -> Running[GatherAnnotationComplete]:
        """The context around one annotation, taking `context_window` characters of its source: two thousand when none is stated."""
        request = GatherAnnotationRequest(
            annotation_id=annotation_id, resource_id=resource_id, options=GatherAnnotationOptions(context_window=context_window)
        )
        return Running(lambda _: self._links.run(self._links.request(GATHER_REQUESTED, request)))

    async def resource(
        self,
        resource_id: ResourceId,
        *,
        depth: int = _DEPTH,
        max_resources: int = _MAX_RESOURCES,
        include_content: bool = True,
        include_summary: bool = False,
        exclude_entity_types: Sequence[str] = (),
    ) -> GatheredContext:
        """The context around a whole resource.

        With nothing stated: two hops of the graph, ten resources, their
        content, and no summary. An empty exclusion excludes nothing, and is
        not sent.
        """
        options = (
            GatherResourceRequestOptions(
                depth=depth,
                max_resources=max_resources,
                include_content=include_content,
                include_summary=include_summary,
                exclude_entity_types=list(exclude_entity_types),
            )
            if exclude_entity_types
            else GatherResourceRequestOptions(
                depth=depth, max_resources=max_resources, include_content=include_content, include_summary=include_summary
            )
        )
        gathered = await self._links.request(GATHER_RESOURCE_REQUESTED, GatherResourceRequest(resource_id=resource_id, options=options))
        return gathered.response

    def referenced_by(self, resource_id: ResourceId) -> Cached[list[GetReferencedByResponseReferencedByItem]]:
        """The annotations elsewhere that refer to a resource. Watching it holds the resource's scope."""
        return self._live.query(Keyed(self._live.referenced_by, resource_id, itself, scope=(self._links.wire.transport, resource_id)))
