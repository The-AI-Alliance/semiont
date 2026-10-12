"""Gathering around a resource: the context a generation is given for one resource as a whole.

`docs/protocol/LIBRARIAN.md` § Gathering around a resource states it, rule by
rule, and the reads are made in the order of its rules: the resource's view;
its text, where the request asks for content; the knowledge graph; the
related resources and their texts; a model's summary and suggestions, where
the request asks for them and there is a text; and the passages of other
resources that are like this one, by the vectors its own chunks have.

Only the search for those passages waits (§ The two waits): where it finds
none and the resource's description states a checksum, the gather waits, for
the settle bound at most, for the Smelter's decision of exactly those bytes,
and asks the index again where the decision is `indexed`.

A gather answers its context or raises `Ungathered`, and emits nothing. The
request's `depth` has no effect: the graph is the resource's own
neighbourhood, one link out.
"""

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
from semiont_vectors.store import SearchFilter, SearchOptions, VectorReader

from semiont_librarian.annotation_gather import LIKE_ENOUGH, Ungathered, language_of, similar_of
from semiont_librarian.knowledge_graph import build_knowledge_graph
from semiont_librarian.log import LOG
from semiont_librarian.prompts import ask, reference_suggestions_prompt, resource_summary_prompt
from semiont_librarian.reads import AnchoredText, Degraded, GraphReads, SmeltWaits, SmeltWaitTimedOut, Views, WeaveWaits
from semiont_librarian.replies import read_suggestions
from semiont_librarian.resource_text import text_of

__all__ = ["gather"]


async def gather(
    request: GatherResourceRequest,
    *,
    views: Views,
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

    `settle_within` is the settle bound, in seconds. Raises `Ungathered` for
    a resource with no view. A read of bytes that fails, a graph that cannot
    be built, an index that fails and a wait that fails in any way but
    running out each raise what they failed with.

    A model that fails on the summary or on the suggestions leaves the
    context with neither, and a wait for the index that runs out leaves it
    without similar passages. Each is logged as a warning and counted
    (`degraded`), and the context is answered.
    """
    resource_id = request.resource_id
    options = request.options
    view = await views.get(resource_id)
    if view is None:
        raise Ungathered("Resource not found")
    main = view.resource
    main_text = await text_of(main, content=content, anchored=anchored) if options.include_content else None

    around = await build_knowledge_graph(resource_id, graph=graph, views=views, weave=weave, degraded=degraded)

    # The related resources: the first of the graph's resource nodes, but for the resource itself, that have a view.
    peers = [node for node in around.nodes if isinstance(node, GraphResourceNode) and node.id != resource_id]
    related: list[ResourceDescriptor] = []
    for node in peers[: max(0, options.max_resources - 1)]:
        peer = await views.get(node.id)
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
            suggestions = read_suggestions(await ask(inference, suggesting))
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
    matches = await vectors.search_by_resource(resource_id, asking)
    if not matches:
        representation = primary_representation(main)
        checksum = None if representation is None else representation.checksum
        if checksum:
            try:
                outcome = await smelt.when_settled(resource_id, checksum, settle_within)
            except SmeltWaitTimedOut:
                degraded.note("vectors")
                LOG.warning(
                    "Gather degraded: no similar passages, the vector index did not settle within the bound",
                    extra={"resourceId": resource_id, "contentChecksum": checksum, "settleSeconds": settle_within},
                )
            else:
                if outcome == "indexed":
                    matches = await vectors.search_by_resource(resource_id, asking)
    similar = await similar_of(matches, views)

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
