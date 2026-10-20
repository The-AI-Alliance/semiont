"""What refers to a resource: the annotations elsewhere that link to it, each with the name of the resource it is on.

`gather:referenced-by-requested` names a resource, and may name a motivation
(`docs/protocol/LIBRARIAN.md` § What refers to a resource). It asks which
links arrive at a resource, which only the graph answers. The graph is asked
as it holds them then: nothing here waits for it. A resource nobody made is
no resource nothing refers to: the request fails for one the record does not
hold. Its reply names no person, so no one is named in it.
"""

import asyncio

from semiont.annotations import exact_text, target_selector, target_source
from semiont.identifiers import ResourceId
from semiont.model import stated
from semiont.types import (
    GatherReferencedByRequest,
    GatherReferencedByResult,
    GetReferencedByResponse,
    GetReferencedByResponseReferencedByItem,
    GetReferencedByResponseReferencedByItemTarget,
    GetReferencedByResponseReferencedByItemTargetSelector,
    ResourceDescriptor,
)

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.grace import resource_with_view_grace
from semiont_librarian.log import LOG
from semiont_librarian.reads import GraphReads, Record

__all__ = ["answer"]


async def answer(request: GatherReferencedByRequest, *, graph: GraphReads, record: Record) -> GatherReferencedByResult:
    """The reply to `gather:referenced-by-requested`: one entry for each annotation that refers to the resource, in the graph's order.

    Raises `Ungathered` for a resource the record does not hold, before the
    graph is asked. Each resource those annotations are on is read once, from
    the graph, and from the record where the graph has none or its read
    fails. An entry is the annotation's id, the name of the resource it is
    on, and its target: that resource, and the words its quote selector
    states, or the empty string where it has none. An entry states no name
    where nobody holds a description of its resource, and where the name is
    empty. A graph that fails to answer is raised, and is the request's
    failure.
    """
    LOG.debug(
        "Looking for annotations referencing resource",
        extra={"resourceId": request.resource_id, "motivation": request.motivation or "all"},
    )
    if await record.described(request.resource_id) is None:
        raise Ungathered("Resource not found")
    references = await graph.get_resource_referenced_by(request.resource_id, request.motivation)

    cited_from = list(dict.fromkeys(target_source(reference.target) for reference in references))
    graced = await asyncio.gather(*(resource_with_view_grace(graph, record, source) for source in cited_from))
    described: dict[ResourceId, ResourceDescriptor] = {}
    for source, read in zip(cited_from, graced, strict=True):
        if read.resource is not None:
            described[read.resource.id] = read.resource
        if read.lagged_behind_view:
            LOG.info("A citing resource was read from its view: the graph does not hold it", extra={"resourceId": source})
        elif read.resource is None:
            LOG.warning("Referenced resource not found in graph or view", extra={"resourceId": source})

    entries: list[GetReferencedByResponseReferencedByItem] = []
    for reference in references:
        source = target_source(reference.target)
        on = described.get(source)
        entries.append(
            stated(
                GetReferencedByResponseReferencedByItem(
                    id=reference.id,
                    resource_name=(on.name or None) if on is not None else None,
                    target=GetReferencedByResponseReferencedByItemTarget(
                        source=source,
                        selector=GetReferencedByResponseReferencedByItemTargetSelector(exact=exact_text(target_selector(reference.target))),
                    ),
                )
            )
        )

    return GatherReferencedByResult(response=GetReferencedByResponse(referenced_by=entries))
