"""A reference search: what a reference could refer to, as scored candidates.

`match:search-requested` carries a reference and the context gathered around
it (`docs/protocol/LIBRARIAN.md` § Reference search). Four sources are read
for candidates: the graph's listing by name, its listing by entity type, the
resources the context's graph connects the reference's resource to, and the
vector index. A resource is one candidate however many of them found it, and
the reference's own resource is none. Each candidate is scored
(`semiont_librarian.score`), a model is asked to score the twenty of the
highest scores, and the answer is the candidates by score, the highest first. `specs/src/librarian/score-cases.json` states each search as
what every source answers and the candidates that follow.

`search` answers the reply, or raises. What it raises is the failure, and its
words are the message of `match:search-failed`. A listing that fails raises.
A vector index or a model that fails does not: it is logged, and the search
is answered without it.

Everything read is handed in: the graph, the views, the index, the provider
that makes the term's vector, the model, the people projection its reply is
named by, and the clock recency is counted by.
"""

import asyncio
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Final, final

from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import (
    Annotation,
    GatheredContext,
    GatheredContextFocusAnnotation,
    MatchSearchRequest,
    MatchSearchResult,
    ResourceDescriptor,
    ScoredResource,
    TextualBody,
)
from semiont_graph.interface import ResourceQuery
from semiont_inference.interface import InferenceClient
from semiont_service.white_space import trimmed
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import CollectionAbsent, SearchFilter, SearchOptions, VectorReader, VectorSearchResult

from semiont_librarian.grace import resource_with_view_grace
from semiont_librarian.limit import refuse_limit_below_least
from semiont_librarian.log import LOG
from semiont_librarian.naming import namer
from semiont_librarian.prompts import score_prompt
from semiont_librarian.reads import GraphReads, People, Views
from semiont_librarian.replies import SCORE_ELEMENT, ask_for_elements, read_scores
from semiont_librarian.score import Score, Source, score_of, with_model_score
from semiont_librarian.views import GraphViews, derive_views

__all__ = [
    "MOST_BY_ENTITY_TYPE",
    "MOST_BY_NAME",
    "MOST_HITS",
    "MOST_SHOWN",
    "WEAKEST_HIT",
    "FocusNotAnAnnotation",
    "search",
]

MOST_BY_NAME: Final = 20
"""The most resources the graph's listing by name is asked for."""

MOST_BY_ENTITY_TYPE: Final = 50
"""The most resources the graph's listing by entity type is asked for."""

MOST_HITS: Final = 40
"""The most hits the vector index is asked for."""

WEAKEST_HIT: Final = 0.4
"""A hit of the vector index scores this or more against the term's vector."""

MOST_SHOWN: Final = 20
"""The most candidates a model is asked to score."""


@final
class FocusNotAnAnnotation(Exception):
    """The context of a reference search is gathered around a resource, and not around an annotation."""


@final
class _Found:
    """The candidates, in the order they were found, each with what found it.

    A resource is described as the first source to find it answered it. The
    request's own resource is no candidate, whichever source answers it.
    """

    def __init__(self, own: ResourceId) -> None:
        self._own: Final = own
        self.resources: Final[dict[ResourceId, ResourceDescriptor]] = {}
        self.sources: Final[dict[ResourceId, set[Source]]] = {}

    def by(self, source: Source, resource: ResourceDescriptor) -> None:
        """Count `resource` as found by `source`."""
        if resource.id == self._own:
            return
        if resource.id in self.sources:
            self.sources[resource.id].add(source)
        else:
            self.resources[resource.id] = resource
            self.sources[resource.id] = {source}


def _term(focus: GatheredContextFocusAnnotation) -> str:
    """The search term: the selected text and the hint, each left out when absent or empty, joined by one space."""
    selected = "" if focus.selected is None else focus.selected.text
    return " ".join(part for part in (selected, focus.user_hint) if part)


async def _by_name(graph: GraphReads, term: str) -> list[ResourceDescriptor]:
    """What the graph's listing by name answers for the term, whatever the term is."""
    return (await graph.list_resources(ResourceQuery(search=term, limit=MOST_BY_NAME))).resources


async def _by_entity_type(graph: GraphReads, entity_types: Sequence[str]) -> list[ResourceDescriptor]:
    """What the graph's listing by entity type answers. It is not asked where the context has no entity type."""
    if not entity_types:
        return []
    return (await graph.list_resources(ResourceQuery(entity_types=entity_types, limit=MOST_BY_ENTITY_TYPE))).resources


async def _hits(term: str, own: ResourceId, *, vectors: VectorReader, embedding: EmbeddingProvider) -> list[VectorSearchResult]:
    """The vector index's hits for the term, in the order it answers them, of chunks of any resource but `own`, the request's.

    None for a blank term, which is not asked of it. None where the provider
    or the index fails, which is logged. An index with no such collection,
    which no store has made yet, is not read so: it fails the search.
    """
    if trimmed(term) == "":
        return []
    try:
        vector = await embedding.embed_query(term)
        options = SearchOptions(limit=MOST_HITS, score_threshold=WEAKEST_HIT, filter=SearchFilter(exclude_resource_id=own))
        return await vectors.search_resources(vector, options)
    except CollectionAbsent:
        raise
    except Exception as failure:
        LOG.warning("Vector search failed, falling back to structural search", extra={"error": str(failure)})
        return []


_SAID: Final = ("commenting", "assessing")
"""The purposes of a body item that is what its annotation says of the passage: a comment's text, or an assessment's."""


def _body_text(annotation: Annotation) -> str | None:
    """The text of the first item of an annotation's body whose purpose is commenting or assessing. Nothing where no item is one.

    An item that tags the annotation with an entity type, or is there for
    any other purpose, is not what the annotation says.
    """
    items = annotation.body if isinstance(annotation.body, list) else [annotation.body]
    for item in items:
        if isinstance(item, TextualBody) and item.purpose in _SAID and item.value:
            return item.value
    return None


async def _model_scores(
    shown: Sequence[ResourceDescriptor],
    *,
    context: GatheredContext,
    focus: GatheredContextFocusAnnotation,
    views: GraphViews,
    inference: InferenceClient,
) -> dict[int, float]:
    """What a model scores each of the candidates it is shown, by the candidate's number in the prompt, from 1."""
    prompt = score_prompt(
        selected=(focus.selected.text or None) if focus.selected is not None else None,
        hint=focus.user_hint or None,
        motivation=focus.annotation.motivation,
        source=focus.source_resource.name,
        body=_body_text(focus.annotation),
        entity_types=context.metadata.entity_types or [],
        connected=[connection.resource_name for connection in views.connections],
        relationship=context.inferred_relationship_summary,
        candidates=shown,
    )
    scores = read_scores(await ask_for_elements(inference, prompt, SCORE_ELEMENT), len(shown))
    LOG.debug("Inference semantic scores", extra={"candidateCount": len(shown), "scoredCount": len(scores)})
    return scores


def _candidate(resource: ResourceDescriptor, score: Score) -> ScoredResource:
    """A candidate as the reply carries it: its resource's description, as it was read, with `score` and `matchReason` added."""
    return ScoredResource.model_validate({**written(resource), "score": score.points, "matchReason": score.reason})


async def search(
    request: MatchSearchRequest,
    *,
    graph: GraphReads,
    views: Views,
    vectors: VectorReader,
    embedding: EmbeddingProvider,
    inference: InferenceClient,
    people: People,
    now: Callable[[], datetime],
) -> MatchSearchResult:
    """The reply to a reference search: its candidates by score, the highest first, and no more of them than the request's limit.

    The people projection is read once, after the search, and the reply's
    people are named.

    Raises `FocusNotAnAnnotation`, before any source is asked, where the
    context's focus is not an annotation, and
    `semiont_librarian.limit.LimitRefused` for a limit below 1. Raises what
    a listing of the graph raised, or a read of a view. `now` answers the
    moment the search is made, with its offset.
    """
    context = request.context
    focus = context.focus
    if not isinstance(focus, GatheredContextFocusAnnotation):
        raise FocusNotAnAnnotation(f"Matcher expected annotation focus, received '{focus.kind}'")
    refuse_limit_below_least(request.limit)

    term = _term(focus)
    entity_types = context.metadata.entity_types or []
    LOG.debug(
        "Searching for binding candidates",
        extra={
            "referenceId": request.reference_id,
            "searchTerm": term,
            "limit": request.limit,
            "useSemanticScoring": request.use_semantic_scoring,
        },
    )
    # The lists read off the context's graph are those of the request's resource: the graph was gathered around it.
    graph_views = derive_views(context.graph, request.resource_id, None)

    # The two listings and the index are asked together. Each listing answers what the graph holds then: a resource
    # made a moment ago may be missing from one, and is a candidate still where another source finds it.
    named, typed, hits = await asyncio.gather(
        _by_name(graph, term),
        _by_entity_type(graph, entity_types),
        _hits(term, request.resource_id, vectors=vectors, embedding=embedding),
    )

    # A neighbour is read back from the graph, and from its view where the graph has none yet: the view is written
    # first, and a resource just made is not to be dropped while the graph is behind.
    neighbours = await asyncio.gather(
        *(resource_with_view_grace(graph, views, ResourceId(connection.resource_id)) for connection in graph_views.connections)
    )
    lagged = sum(1 for neighbour in neighbours if neighbour.lagged_behind_view)
    if lagged > 0:
        LOG.info("[graph lag] neighborhood candidates hydrated from view", extra={"count": lagged})

    found = _Found(request.resource_id)
    for resource in named:
        found.by("name", resource)
    for resource in typed:
        found.by("entityType", resource)
    for neighbour in neighbours:
        if neighbour.resource is not None:
            found.by("neighborhood", neighbour.resource)

    # Each hit is a chunk of a resource. Of several hits of one resource the best score is kept, and the resource
    # is read back once, as a neighbour is.
    vector_scores: dict[ResourceId, float] = {}
    for hit in hits:
        vector_scores[hit.resource_id] = max(hit.score, vector_scores.get(hit.resource_id, hit.score))
    lagged = 0
    for hit_resource in vector_scores:
        graced = await resource_with_view_grace(graph, views, hit_resource)
        if graced.lagged_behind_view:
            lagged += 1
        if graced.resource is not None:
            found.by("semantic", graced.resource)
    if lagged > 0:
        LOG.info("[graph lag] semantic candidates hydrated from view", extra={"count": lagged})

    LOG.debug(
        "Candidate retrieval",
        extra={
            "nameMatches": len(named),
            "entityTypeMatches": len(typed),
            "neighborResources": sum(1 for neighbour in neighbours if neighbour.resource is not None),
            "semanticMatches": len(hits),
            "totalCandidates": len(found.resources),
        },
    )

    moment = now()
    frequencies = context.metadata.entity_type_frequencies or {}
    scored = [
        (
            resource,
            score_of(
                resource,
                term=term,
                entity_types=entity_types,
                entity_type_frequencies=frequencies,
                views=graph_views,
                sources=found.sources[resource_id],
                vector_score=vector_scores.get(resource_id),
                moment=moment,
            ),
        )
        for resource_id, resource in found.resources.items()
    ]

    # The model is shown the twenty of the highest scores. Python's sort keeps candidates of one score in the
    # order they were found, in this direction too.
    scored.sort(key=lambda each: each[1].points, reverse=True)
    if scored and request.use_semantic_scoring is not False:
        shown = [resource for resource, _ in scored[:MOST_SHOWN]]
        try:
            model_scores = await _model_scores(shown, context=context, focus=focus, views=graph_views, inference=inference)
        except Exception as failure:
            LOG.warning("Inference semantic scoring failed, using structural scores only", extra={"error": str(failure)})
        else:
            scored = [
                (resource, with_model_score(score, model_scores[number]) if number in model_scores else score)
                for number, (resource, score) in enumerate(scored, start=1)
            ]

    # Ordered again, by what the model added. Candidates of one score stay as they were before it.
    ordered = sorted(scored, key=lambda each: each[1].points, reverse=True)
    LOG.debug(
        "Search results scored",
        extra={
            "total": len(ordered),
            "topScore": ordered[0][1].points if ordered else None,
            "topReason": ordered[0][1].reason if ordered else None,
        },
    )

    limited = ordered if request.limit is None else ordered[: request.limit]
    reply = MatchSearchResult(reference_id=request.reference_id, response=[_candidate(resource, score) for resource, score in limited])
    name = await namer(people)
    return MatchSearchResult.model_validate(name(written(reply)))
