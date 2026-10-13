"""Gathering around an annotation: the context a reference search and a generation are given for one annotation.

`docs/protocol/LIBRARIAN.md` § Gathering around an annotation states it, rule
by rule, and the reads are made in the order of its rules: the resource's
view and the annotation in it; the resource the annotation links to; the text
around the selection; the linked resource's text and a model's summary of it;
the knowledge graph, one link out; how many resources have each entity type; a model's
sentence on how the passage relates to what is around it; and the annotations
elsewhere whose quoted text is like the selection.

A gather answers its context or raises, and emits nothing. `Ungathered` is a
gather that cannot be answered, and its words are what the failure channel
carries; a window out of bounds is `semiont_librarian.window.WindowRefused`.
What a read raises is passed on as it is.

The context states what it holds and nothing else: a member the gather has
nothing for is absent, and is not `null`.
"""

from collections.abc import Sequence
from typing import Final, final

from semiont.annotations import body_source, entity_types, target_source
from semiont.model import stated
from semiont.resources import primary_representation, resource_entity_types
from semiont.types import (
    GatherAnnotationRequest,
    GatheredContext,
    GatheredContextFocusAnnotation,
    GatheredContextFocusAnnotationSelected,
    GatheredContextFocusAnnotationTargetContext,
    GatheredContextMetadata,
    GatheredContextSemanticContext,
    ResourceDescriptor,
    SemanticMatch,
)
from semiont_inference.interface import InferenceClient
from semiont_service.content import ContentReads
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import CollectionAbsent, SearchFilter, SearchOptions, VectorReader, VectorSearchResult

from semiont_librarian.grace import view_if_readable
from semiont_librarian.knowledge_graph import LEAST_DEPTH, build_knowledge_graph
from semiont_librarian.log import LOG
from semiont_librarian.prompts import ask, relationship_prompt, resource_summary_prompt
from semiont_librarian.reads import AnchoredText, Degraded, GraphReads, Views, WeaveWaits
from semiont_librarian.resource_text import has_stored_bytes, text_of
from semiont_librarian.views import derive_views
from semiont_librarian.window import Window, refuse_out_of_bounds, selection_of

__all__ = ["LIKE_ENOUGH", "Ungathered", "gather", "language_of", "similar_of"]

_WINDOW: Final = 1000
"""How much text is taken on each side of the selection, where the request states no `contextWindow`."""

_SIMILAR: Final = 10
"""The most annotations asked of the vector index."""

LIKE_ENOUGH: Final = 0.5
"""The least score at which a passage is like another: what either gather asks the vector index for."""


@final
class Ungathered(Exception):
    """A gather, or a summary, that cannot be answered. Its words are what is answered on the failure channel."""


def language_of(resource: ResourceDescriptor) -> str | None:
    """The language a resource's description states, which is a gathered context's `metadata.language`. Nothing where it states none.

    A description states it of its primary representation, where the
    Archivist puts the language a resource was recorded with.
    """
    representation = primary_representation(resource)
    return None if representation is None else representation.language or None


async def similar_of(found: Sequence[VectorSearchResult], views: Views) -> list[SemanticMatch]:
    """What a vector search found, as a gathered context states it: each match named by its resource's view, in the order found.

    A match whose resource has no view that can be read, or a view with an
    empty name, is left out: a match must name where it is from.
    """
    similar: list[SemanticMatch] = []
    for hit in found:
        view = await view_if_readable(views, hit.resource_id)
        if view is None or not view.resource.name:
            LOG.debug("Semantic match dropped: its resource has no view", extra={"resourceId": hit.resource_id})
            continue
        similar.append(
            stated(
                SemanticMatch(
                    text=hit.text,
                    resource_id=hit.resource_id,
                    resource_name=view.resource.name,
                    annotation_id=hit.annotation_id,
                    score=hit.score,
                    entity_types=None if hit.entity_types is None else [*hit.entity_types],
                    machine_read=hit.machine_read or None,
                )
            )
        )
    return similar


async def gather(
    request: GatherAnnotationRequest,
    *,
    views: Views,
    content: ContentReads,
    anchored: AnchoredText,
    graph: GraphReads,
    vectors: VectorReader,
    weave: WeaveWaits,
    embedding: EmbeddingProvider,
    inference: InferenceClient,
    degraded: Degraded,
) -> GatheredContext:
    """The context gathered around the annotation a `gather:requested` names: a `GatheredContext` whose focus is the annotation.

    `includeSourceContext` and `includeTargetContext` are each true where the
    request does not state them, and `contextWindow` is 1,000. Raises
    `semiont_librarian.window.WindowRefused` for a window less than 100 or
    more than 5,000, before anything is read. Raises `Ungathered` for a
    resource with no view; for an annotation the view does not hold, or
    whose target names another resource; and for a resource with no stored
    bytes whose text was asked for. A read of bytes that fails, a graph that
    cannot be built and a count of entity types that fails each raise what
    they failed with, and so does an index with no such collection.

    A model that fails on the linked resource's summary or on the
    relationship sentence, and an embedding or an index that fails in the
    search for similar annotations, each leave the context without that
    member. Each is logged as a warning and counted (`degraded`), and the
    context is answered. A view that only adds to it, and cannot be read, is
    passed over (`semiont_librarian.grace.view_if_readable`).
    """
    options = request.options
    include_source = options is None or options.include_source_context is None or options.include_source_context
    include_target = options is None or options.include_target_context is None or options.include_target_context
    window = _WINDOW if options is None or options.context_window is None else options.context_window
    refuse_out_of_bounds(window)

    resource_id = request.resource_id
    view = await views.get(resource_id)
    if view is None:
        raise Ungathered("Source resource not found")
    annotation = next((held for held in view.annotations.annotations if held.id == request.annotation_id), None)
    if annotation is None:
        raise Ungathered("Annotation not found in view")
    on = target_source(annotation.target)
    if on != resource_id:
        raise Ungathered(f"Annotation target resource ID ({on}) does not match expected resource ID ({resource_id})")
    source = view.resource

    # The resource the annotation's body links to, where it links to one that has a view.
    linked: ResourceDescriptor | None = None
    linked_id = body_source(annotation.body)
    if linked_id is not None:
        linked_view = await view_if_readable(views, linked_id)
        linked = None if linked_view is None else linked_view.resource

    selection: Window | None = None
    if include_source:
        if not has_stored_bytes(source):
            raise Ungathered("Source content not found: no storageUri")
        text = await text_of(source, content=content, anchored=anchored)
        if text is None:
            LOG.warning("Source context skipped: this resource has no text, or none yet", extra={"resourceId": resource_id})
        else:
            selection = selection_of(annotation, text, window)

    target_context: GatheredContextFocusAnnotationTargetContext | None = None
    if include_target and linked is not None and has_stored_bytes(linked):
        linked_text = await text_of(linked, content=content, anchored=anchored)
        # A text with nothing in it is no context, and nothing a model can summarize.
        if linked_text:
            summarizing = resource_summary_prompt(name=linked.name, content=linked_text, entity_types=resource_entity_types(linked))
            # The summary adds to what is said of the linked resource: its text is answered with it or without.
            summary: str | None = None
            try:
                summary = await ask(inference, summarizing)
            except Exception as failure:
                degraded.note("summary")
                LOG.warning(
                    "Gather degraded: no summary of the linked resource, the model failed",
                    extra={"resourceId": resource_id, "annotationId": annotation.id, "linkedResourceId": linked.id, "error": str(failure)},
                )
            target_context = stated(GatheredContextFocusAnnotationTargetContext(content=linked_text[: window * 2], summary=summary))

    around = await build_knowledge_graph(resource_id, graph=graph, views=views, weave=weave, degraded=degraded, depth=LEAST_DEPTH)
    lists = derive_views(around, resource_id, annotation.id)
    frequencies = {stat.type: stat.count for stat in await graph.get_entity_type_stats()}
    types = entity_types(annotation)

    relationship: str | None = None
    if selection is not None:
        relating = relationship_prompt(
            passage=selection.selected,
            connected=[connection.resource_name for connection in lists.connections],
            cited_by=[citer.resource_name for citer in lists.cited_by],
            sibling_entity_types=lists.sibling_entity_types,
            entity_types=types,
        )
        try:
            relationship = await ask(inference, relating)
        except Exception as failure:
            degraded.note("relationship")
            LOG.warning(
                "Gather degraded: no relationship sentence, the model failed",
                extra={"resourceId": resource_id, "annotationId": annotation.id, "error": str(failure)},
            )

    similar: list[SemanticMatch] = []
    if selection is not None and selection.selected:
        try:
            found = await vectors.search_annotations(
                await embedding.embed_query(selection.selected),
                SearchOptions(limit=_SIMILAR, score_threshold=LIKE_ENOUGH, filter=SearchFilter(exclude_resource_id=resource_id)),
            )
            similar = await similar_of(found, views)
        except CollectionAbsent:
            # An index nobody has started is no index that failed: the gather fails, and says so.
            raise
        except Exception as failure:
            degraded.note("vectors")
            LOG.warning(
                "Gather degraded: no similar annotations, the search of the vector index failed",
                extra={"resourceId": resource_id, "annotationId": annotation.id, "error": str(failure)},
            )

    selected = (
        None
        if selection is None
        else GatheredContextFocusAnnotationSelected(before=selection.before, text=selection.selected, after=selection.after)
    )
    focus = stated(
        GatheredContextFocusAnnotation(
            kind="annotation",
            annotation=annotation,
            source_resource=source,
            selected=selected,
            target_resource=linked,
            target_context=target_context,
        )
    )
    metadata = stated(
        GatheredContextMetadata(
            resource_type="document",
            language=language_of(source),
            entity_types=types,
            entity_type_frequencies=frequencies,
        )
    )
    return stated(
        GatheredContext(
            focus=focus,
            graph=around,
            semantic_context=GatheredContextSemanticContext(similar=similar) if similar else None,
            metadata=metadata,
            inferred_relationship_summary=relationship or None,
        )
    )
