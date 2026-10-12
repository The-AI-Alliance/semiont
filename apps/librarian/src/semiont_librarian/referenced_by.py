"""What refers to a resource: the annotations elsewhere that link to it, each with the name of the resource it is on.

`gather:referenced-by-requested` names a resource, and may name a motivation
(`docs/protocol/LIBRARIAN.md` § What refers to a resource). It asks which
links arrive at a resource, which only the graph answers. The graph is asked
as it holds them then: nothing here waits for it.
"""

import asyncio
from typing import Final

from pydantic import TypeAdapter, ValidationError
from semiont.annotations import exact_text, target_selector, target_source
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import (
    Annotation,
    GatherReferencedByRequest,
    GatherReferencedByResult,
    GetReferencedByResponse,
    GetReferencedByResponseReferencedByItem,
    GetReferencedByResponseReferencedByItemTarget,
    GetReferencedByResponseReferencedByItemTargetSelector,
    Motivation,
    ResourceDescriptor,
)

from semiont_librarian.grace import resource_with_view_grace
from semiont_librarian.log import LOG
from semiont_librarian.naming import namer
from semiont_librarian.reads import GraphReads, People, Views

__all__ = ["answer"]

_UNNAMED: Final = "Untitled Resource"
"""What an annotation's resource is called where nobody holds a description of it, and where its name is empty."""

_MOTIVATION: Final = TypeAdapter[Motivation](Motivation)


async def _referring(graph: GraphReads, resource_id: ResourceId, motivation: str | None) -> list[Annotation]:
    """The annotations that refer to a resource, as the graph holds them: all of them, or those of one motivation.

    A request that names no motivation, or an empty one, asks for all. One
    that names a motivation no annotation can have is answered with none,
    and the graph is not asked.
    """
    if not motivation:
        return await graph.get_resource_referenced_by(resource_id, None)
    try:
        stated = _MOTIVATION.validate_python(motivation)
    except ValidationError:
        return []
    return await graph.get_resource_referenced_by(resource_id, stated)


async def answer(request: GatherReferencedByRequest, *, graph: GraphReads, views: Views, people: People) -> GatherReferencedByResult:
    """The reply to `gather:referenced-by-requested`: one entry for each annotation that refers to the resource, in the graph's order.

    Each resource those annotations are on is read once, from the graph, and
    from the views where the graph has none or its read fails. An entry is
    the annotation's id, the name of the resource it is on, and its target:
    that resource, and the words its quote selector states, or the empty
    string where it has none. The people projection is read once, and the
    reply's people are named. A graph that fails to answer is raised, and is
    the request's failure.
    """
    LOG.debug(
        "Looking for annotations referencing resource",
        extra={"resourceId": request.resource_id, "motivation": request.motivation or "all"},
    )
    references = await _referring(graph, request.resource_id, request.motivation)

    cited_from = list(dict.fromkeys(target_source(reference.target) for reference in references))
    graced = await asyncio.gather(*(resource_with_view_grace(graph, views, source) for source in cited_from))
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
            GetReferencedByResponseReferencedByItem(
                id=reference.id,
                resource_name=on.name if on is not None and on.name else _UNNAMED,
                target=GetReferencedByResponseReferencedByItemTarget(
                    source=source,
                    selector=GetReferencedByResponseReferencedByItemTargetSelector(exact=exact_text(target_selector(reference.target))),
                ),
            )
        )

    name = await namer(people)
    reply = GatherReferencedByResult(response=GetReferencedByResponse(referenced_by=entries))
    return GatherReferencedByResult.model_validate(name(written(reply)))
