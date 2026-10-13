"""An annotation's summary: what a model says of a passage where it stands.

`docs/protocol/LIBRARIAN.md` § An annotation's summary states it. The
resource's view is read and the annotation found in it; the resource's text
is read and cut around the annotation's position, 500 code points on each
side; the model is asked with the annotation-summary prompt; and the answer
is the model's summary, the resource's name with the annotation's entity
types, and the passage with the 200 nearest it on each side.

A summary is answered or raises, and emits nothing. `Ungathered` is a
summary that cannot be answered, and its words are what the failure channel
carries. A model that fails raises what it failed with.
"""

from typing import Final

from semiont.annotations import entity_types, target_source
from semiont.types import (
    ContextualSummaryResponse,
    ContextualSummaryResponseContext,
    ContextualSummaryResponseRelevantFields,
    GatherSummaryRequest,
)
from semiont_inference.interface import InferenceClient
from semiont_service.content import ContentReads

from semiont_librarian.annotation_gather import Ungathered
from semiont_librarian.prompts import after_passage, annotation_summary_prompt, ask, before_passage
from semiont_librarian.reads import AnchoredText, Views
from semiont_librarian.resource_text import text_of
from semiont_librarian.window import annotation_context

__all__ = ["summarize"]

_AROUND: Final = 500
"""How much text is cut on each side of the annotation's position."""


async def summarize(
    request: GatherSummaryRequest, *, views: Views, content: ContentReads, anchored: AnchoredText, inference: InferenceClient
) -> ContextualSummaryResponse:
    """The summary of the annotation a `gather:summary-requested` names.

    Raises `Ungathered` for a resource with no view, for an annotation the
    view does not hold, and for a resource whose text is not there. A target
    with no position selector, a read of bytes that fails and a model that
    fails each raise what they failed with.

    `relevantFields` states the resource's id and its name, and the
    annotation's entity types.
    """
    view = await views.get(request.resource_id)
    if view is None:
        raise Ungathered(f"Resource {request.resource_id} not found in view storage")
    annotation = next((held for held in view.annotations.annotations if held.id == request.annotation_id), None)
    if annotation is None:
        raise Ungathered("Annotation not found")

    # The resource is the one the annotation's target names, and its view is read for it.
    on = await views.get(target_source(annotation.target))
    if on is None:
        raise Ungathered("Resource not found")
    resource = on.resource
    text = await text_of(resource, content=content, anchored=anchored)
    if text is None:
        raise Ungathered("Resource content not found: no text for this media (not decoded, and no derived text yet)")

    around = annotation_context(annotation, text, _AROUND, _AROUND)
    types = entity_types(annotation)
    asking = annotation_summary_prompt(
        resource=resource.name, before=around.before, selected=around.selected, after=around.after, entity_types=types
    )
    summary = await ask(inference, asking)

    return ContextualSummaryResponse(
        summary=summary,
        relevant_fields=ContextualSummaryResponseRelevantFields(resource_id=resource.id, resource_name=resource.name, entity_types=types),
        context=ContextualSummaryResponseContext(
            before=before_passage(around.before), selected=around.selected, after=after_passage(around.after)
        ),
    )
