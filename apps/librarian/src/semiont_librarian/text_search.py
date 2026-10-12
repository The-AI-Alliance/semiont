"""A search of the knowledge base's resources by text: the graph's page, the index's where the graph found nothing, and the previews.

`match:resources-requested` asks which resources a text finds
(`docs/protocol/LIBRARIAN.md` § Text search).
`specs/src/librarian/search-cases.json` states each search as what each
store answers and the page that follows, and what a preview is, and the
tests run every case of it.

The graph is asked first, and applies every filter before it cuts the page.
Only a first page that found nothing is answered by meaning: the text is
embedded once, the index's chunks are folded to one for each resource, and
those at the semantic floor or above are the page. Each reads one index. A
search that puts several sources together is a reference search, and is not
made here.
"""

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

from semiont.model import written
from semiont.types import (
    MatchResourcesRequest,
    MatchResourcesResponse,
    MatchResourcesResponseMatchKind,
    MatchResourcesResult,
    ResourceDescriptor,
)
from semiont_graph.interface import ResourceQuery
from semiont_service.content import ContentReads
from semiont_service.white_space import trimmed
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.merge import merge_by_resource
from semiont_vectors.store import SearchOptions, VectorReader

from semiont_librarian.grace import resource_with_view_grace
from semiont_librarian.log import LOG
from semiont_librarian.naming import namer
from semiont_librarian.reads import GraphReads, People, Views
from semiont_librarian.resource_text import preview_of

__all__ = ["Page", "answer", "search_resources", "with_previews"]

_FIRST_OFFSET: Final = 0
"""Where a search that states no offset begins."""

_PAGE_LIMIT: Final = 50
"""How many resources a page has at most, for a search that states no limit."""

_CHUNKS_FOR_EACH_RESOURCE: Final = 4
"""How many chunks the index is asked for, for each resource of a page.

The index answers chunks, and they are folded to one for each resource, so a
resource of many chunks could otherwise crowd the others off the page. It is
room, and no promise.
"""


@final
@dataclass(frozen=True, slots=True)
class Page:
    """One page of the resources a text search found, how many it found in all, and which kind of answer it is.

    A resource of a semantic page carries the passage that matched as its
    `content`. `total` counts all that matched, and not the page.
    `match_kind` is `lexical` for the graph's answer, a page with nothing on
    it among them, and `semantic` where the index answered.
    """

    resources: list[ResourceDescriptor]
    total: int
    match_kind: MatchResourcesResponseMatchKind


def _nothing() -> Page:
    """The page of a search that found nothing: no resources, a total of 0, and lexical."""
    return Page(resources=[], total=0, match_kind="lexical")


def _paged(filters: MatchResourcesRequest) -> tuple[int, int]:
    """The offset and the limit a search is made with: its own, and 0 and 50 where it states none."""
    return (
        _FIRST_OFFSET if filters.offset is None else filters.offset,
        _PAGE_LIMIT if filters.limit is None else filters.limit,
    )


async def search_resources(
    filters: MatchResourcesRequest,
    *,
    graph: GraphReads,
    views: Views,
    vectors: VectorReader,
    embedding: EmbeddingProvider,
    semantic_floor: float,
) -> Page:
    """The page a text search answers.

    The text is searched without the white space at its two ends, and one
    that is then empty finds nothing and asks no store. Otherwise the graph
    is asked, and a graph that fails is raised. Its page is the answer where
    it matched anything, or the search is not for a first page. Otherwise
    the index answers (`semantic_floor` is the least score a resource needs
    to be found there).
    """
    offset, limit = _paged(filters)
    search = trimmed(filters.search)
    if not search:
        return _nothing()
    lexical = await graph.list_resources(
        ResourceQuery(
            search=search,
            archived=filters.archived,
            entity_types=(filters.entity_type,) if filters.entity_type else (),
            offset=offset,
            limit=limit,
        )
    )
    # What the index costs is paid only for a page that would otherwise be empty, and a later page of a search
    # that matched nothing does not pay it again.
    if lexical.total > 0 or offset > 0:
        return Page(resources=lexical.resources, total=lexical.total, match_kind="lexical")
    return await _by_meaning(search, limit, graph=graph, views=views, vectors=vectors, embedding=embedding, semantic_floor=semantic_floor)


async def _by_meaning(
    search: str,
    limit: int,
    *,
    graph: GraphReads,
    views: Views,
    vectors: VectorReader,
    embedding: EmbeddingProvider,
    semantic_floor: float,
) -> Page:
    """The page the index answers for a text the graph matched nothing by, which is semantic also where nothing is kept.

    The index is asked with no filter. The floor is applied here and not by
    the index, so that what is below it is there to be counted: the line
    logged of each search is what the floor is set by.

    Whatever fails in here, the answer is the page the search already had,
    with nothing on it and lexical. A search that found nothing does not
    become a failure.
    """
    try:
        vector = await embedding.embed(search)
        hits = await vectors.search_resources(vector, SearchOptions(limit=limit * _CHUNKS_FOR_EACH_RESOURCE))
        folded = merge_by_resource(hits)
        kept = [hit for hit in folded if hit.score >= semantic_floor]
        LOG.debug(
            "Semantic score distribution of a text search",
            extra={
                "chunkHits": len(hits),
                "resources": len(folded),
                "aboveFloor": len(kept),
                "belowFloor": len(folded) - len(kept),
                "topScore": folded[0].score if folded else None,
                "bottomScore": folded[-1].score if folded else None,
                "floor": semantic_floor,
            },
        )
        # The order of the scores is the order of the page, and nothing else is: not which resource is the newest.
        resources: list[ResourceDescriptor] = []
        for hit in kept[:limit]:
            # The index can hold a resource a moment after it is gone: a hit nobody holds a resource for is left out.
            graced = await resource_with_view_grace(graph, views, hit.resource_id)
            if graced.resource is not None:
                resources.append(graced.resource.model_copy(update={"content": hit.text}))
        return Page(resources=resources, total=len(kept), match_kind="semantic")
    except Exception as failure:
        LOG.warning("A text search could not be answered by meaning, and is answered as finding nothing", extra={"reason": str(failure)})
        return _nothing()


async def with_previews(resources: Sequence[ResourceDescriptor], *, content: ContentReads) -> list[ResourceDescriptor]:
    """Each resource with a preview of its text as its `content`, in the order given (`semiont_librarian.resource_text.preview_of`).

    The resources are read together. One whose read fails previews as the
    empty string, and the others keep theirs.
    """
    previews = await asyncio.gather(*(preview_of(resource, content=content) for resource in resources))
    return [resource.model_copy(update={"content": preview}) for resource, preview in zip(resources, previews, strict=True)]


async def answer(
    request: MatchResourcesRequest,
    *,
    graph: GraphReads,
    views: Views,
    vectors: VectorReader,
    embedding: EmbeddingProvider,
    semantic_floor: float,
    content: ContentReads,
    people: People,
) -> MatchResourcesResult:
    """The reply to `match:resources-requested`: the page, the offset and the limit the search was made with, and its people named.

    Each resource of a lexical page is given a preview. A semantic page's
    `content` is the passage that matched, and is left as it is. The people
    projection is read once, after the search. A graph that fails to list is
    raised, and is the request's failure.
    """
    offset, limit = _paged(request)
    page = await search_resources(request, graph=graph, views=views, vectors=vectors, embedding=embedding, semantic_floor=semantic_floor)
    resources = await with_previews(page.resources, content=content) if page.match_kind == "lexical" else page.resources
    name = await namer(people)
    reply = MatchResourcesResult(
        response=MatchResourcesResponse(resources=resources, total=page.total, offset=offset, limit=limit, match_kind=page.match_kind)
    )
    return MatchResourcesResult.model_validate(name(written(reply)))
