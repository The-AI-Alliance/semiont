"""Gathering around a resource: the context a generation is given for one resource as a whole.

`docs/protocol/LIBRARIAN.md` § Gathering around a resource states it, rule by
rule, and the reads are made in the order of its rules: the resource, as the
record describes it; its text, where the request asks for content or for a
summary; the knowledge graph; the related resources and their texts; a
model's summary and suggestions, where the request asks for them and there is
a text; and the passages of other resources that are like this one, by the
vectors its own chunks have.

Only the search for those passages waits (§ The two waits), and only where
the index does not hold the resource's bytes yet: it holds no point of the
resource, or points of other bytes than its description states. The gather
then waits, for the settle bound at most, for the Smelter's decision of
exactly those bytes, and asks the index again where the decision is
`indexed`. A resource the index holds, and that nothing is like, is answered
at once.

The request's `depth` is how many links out from the resource the graph
reaches, and the related resources are the nearest of it. A depth out of
bounds is `semiont_librarian.knowledge_graph.DepthRefused`, and nothing is
read.

A gather answers its context or raises, and emits nothing. `Ungathered` is a
gather that cannot be answered, and its words are what the failure channel
carries.
"""

from semiont.identifiers import ResourceId
from semiont.media_types import text_source_of
from semiont.model import stated
from semiont.resources import primary_representation, resource_entity_types
from semiont.types import (
    GatheredContext,
    GatheredContextFocusResource,
    GatheredContextFocusResourceContent,
    GatheredContextMetadata,
    GatheredContextSemanticContext,
    GatherResourceRequest,
    GraphResourceNode,
    ResourceDescriptor,
)
from semiont_inference.interface import InferenceClient
from semiont_service.content import ContentReads
from semiont_vectors.store import CollectionAbsent, SearchFilter, SearchOptions, VectorReader, VectorSearchResult

from semiont_librarian.annotation_gather import LIKE_ENOUGH, Ungathered, language_of, similar_of
from semiont_librarian.grace import described_if_readable
from semiont_librarian.knowledge_graph import build_knowledge_graph, refuse_depth_out_of_bounds
from semiont_librarian.log import LOG
from semiont_librarian.prompts import ask, reference_suggestions_prompt, resource_summary_prompt
from semiont_librarian.reads import AnchoredText, Degraded, GraphReads, Record, SmeltWaits, SmeltWaitTimedOut, WeaveWaits
from semiont_librarian.replies import SUGGESTION_ELEMENT, ask_for_elements, read_suggestions
from semiont_librarian.resource_text import text_of

__all__ = ["gather"]


def _without_the_index(resource_id: ResourceId, failure: Exception, degraded: Degraded) -> list[VectorSearchResult]:
    """No similar passages, for an index that failed: counted, and logged with what failed."""
    degraded.note("vectors")
    LOG.warning(
        "Gather degraded: no similar passages, the vector index failed",
        extra={"resourceId": resource_id, "error": str(failure)},
    )
    return []


async def _alike(
    main: ResourceDescriptor,
    asking: SearchOptions,
    *,
    vectors: VectorReader,
    smelt: SmeltWaits,
    degraded: Degraded,
    settle_within: float,
) -> list[VectorSearchResult]:
    """What the index finds like a resource, by the resource's own vectors, after the one wait a gather makes for the index.

    Where it finds nothing, the index is asked what it holds of the
    resource. Points of the bytes the description states are an indexed
    resource that nothing is like, and nothing waits. So is a resource whose
    description states no checksum, or a media type that has no text: the
    Smelter indexes neither. Otherwise the Smelter's decision of those bytes
    is waited for, and the index asked again where it is `indexed`.

    An index that fails, and a wait that runs out, each leave the gather
    without similar passages, counted and logged. An index with no such
    collection is raised, and so is a wait that fails in any other way.
    """
    try:
        matches = await vectors.search_by_resource(main.id, asking)
        if matches:
            return matches
        representation = primary_representation(main)
        checksum = None if representation is None else representation.checksum
        if representation is None or not checksum or text_source_of(representation.media_type) == "none":
            return []
        stamp = await vectors.get_resource_stamp(main.id)
    except CollectionAbsent:
        raise
    except Exception as failure:
        return _without_the_index(main.id, failure, degraded)
    if stamp is not None and stamp.content_checksum == checksum:
        return []

    try:
        outcome = await smelt.when_settled(main.id, checksum, settle_within)
    except SmeltWaitTimedOut:
        degraded.note("vectors")
        LOG.warning(
            "Gather degraded: no similar passages, the vector index did not settle within the bound",
            extra={"resourceId": main.id, "contentChecksum": checksum, "settleSeconds": settle_within},
        )
        return []
    if outcome != "indexed":
        return []
    try:
        return await vectors.search_by_resource(main.id, asking)
    except CollectionAbsent:
        raise
    except Exception as failure:
        return _without_the_index(main.id, failure, degraded)


async def gather(
    request: GatherResourceRequest,
    *,
    record: Record,
    content: ContentReads,
    anchored: AnchoredText,
    graph: GraphReads,
    vectors: VectorReader,
    weave: WeaveWaits,
    smelt: SmeltWaits,
    inference: InferenceClient,
    degraded: Degraded,
    settle_within: float,
) -> GatheredContext:
    """The context gathered around the resource a `gather:resource-requested` names: a `GatheredContext` whose focus is the resource.

    `settle_within` is the settle bound, in seconds. Raises
    `semiont_librarian.knowledge_graph.DepthRefused` for a `depth` less than
    1 or more than 3, before anything is read. Raises `Ungathered` for a
    resource the record does not hold. A read of bytes that fails, a graph
    that cannot be built, an index with no such collection and a wait that
    fails in any way but running out each raise what they failed with.

    A model that fails on the summary or on the suggestions leaves the
    context with neither, and an index that fails or a wait for it that runs
    out leaves it without similar passages. Each is logged as a warning and
    counted (`degraded`), and the context is answered. A read of the record
    that only adds to it, and fails, is passed over
    (`semiont_librarian.grace.described_if_readable`).

    The resource's text is read where the request asks for content or for a
    summary: a summary is of the text. It is in the answer only where
    content was asked for.
    """
    resource_id = request.resource_id
    options = request.options
    refuse_depth_out_of_bounds(options.depth)
    recorded = await record.described(resource_id)
    if recorded is None:
        raise Ungathered("Resource not found")
    main = recorded.resource
    main_text = await text_of(main, content=content, anchored=anchored) if options.include_content or options.include_summary else None

    around = await build_knowledge_graph(resource_id, graph=graph, record=record, weave=weave, degraded=degraded, depth=options.depth)

    # The related resources: the first of the graph's resource nodes, but for the resource itself, that the record holds.
    # The graph's resource nodes are nearest first.
    peers = [node for node in around.nodes if isinstance(node, GraphResourceNode) and node.id != resource_id]
    related: list[ResourceDescriptor] = []
    for node in peers[: max(0, options.max_resources - 1)]:
        peer = await described_if_readable(record, node.id)
        if peer is not None:
            related.append(peer.resource)
    related_texts: dict[str, str] = {}
    if options.include_content:
        for resource in related:
            text = await text_of(resource, content=content, anchored=anchored)
            if text:
                related_texts[resource.id] = text

    summary: str | None = None
    suggestions: list[str] | None = None
    if options.include_summary and main_text:
        types = resource_entity_types(main)
        try:
            summary = await ask(inference, resource_summary_prompt(name=main.name, content=main_text, entity_types=types))
            suggesting = reference_suggestions_prompt(title=main.name, entity_type=types[0] if types else None)
            suggestions = read_suggestions(await ask_for_elements(inference, suggesting, SUGGESTION_ELEMENT))
        except Exception as failure:
            degraded.note("suggestions")
            LOG.warning(
                "Gather degraded: no summary and no suggestions, the model failed",
                extra={"resourceId": resource_id, "error": str(failure)},
            )
            summary, suggestions = None, None

    # What is like the resource, by its own stored vectors: nothing is embedded.
    excluded = options.exclude_entity_types or []
    asking = SearchOptions(
        limit=options.max_resources,
        score_threshold=LIKE_ENOUGH,
        filter=SearchFilter(exclude_entity_types=excluded) if excluded else None,
    )
    matches = await _alike(main, asking, vectors=vectors, smelt=smelt, degraded=degraded, settle_within=settle_within)
    similar = await similar_of(matches, record)

    # The focus states `content` whenever content was asked for, and `related` in it even where no related text was read.
    held: GatheredContextFocusResourceContent | None = None
    if options.include_content:
        held = stated(GatheredContextFocusResourceContent(main=main_text or None, related=related_texts))
    focus = stated(
        GatheredContextFocusResource(
            kind="resource",
            resource=main,
            summary=summary or None,
            suggested_references=suggestions,
            content=held,
        )
    )
    semantic = stated(GatheredContextSemanticContext(similar=similar, excluded_entity_types=excluded or None)) if similar else None
    metadata = stated(GatheredContextMetadata(resource_type="document", language=language_of(main)))
    return stated(GatheredContext(focus=focus, graph=around, semantic_context=semantic, metadata=metadata))
