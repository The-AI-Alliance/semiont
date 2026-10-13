"""An annotation's summary: what a model says of a passage where it stands.

`docs/protocol/LIBRARIAN.md` § An annotation's summary states it. The
resource's view is read and the annotation found in it; the resource's text
is read and cut around what the annotation selects, 200 code points on each
side; the model is asked with the annotation-summary prompt; and the answer
is the model's summary, the resource's id and name with the annotation's
entity types, and the passage as it was cut.

A summary is answered or raises, and emits nothing. `Ungathered` is a
summary that cannot be answered, and its words are what the failure channel
carries. A model that fails raises what it failed with.
"""

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
from semiont_librarian.prompts import NEAR, annotation_summary_prompt, ask
from semiont_librarian.reads import AnchoredText, Views
from semiont_librarian.resource_text import text_of
from semiont_librarian.window import annotation_context

__all__ = ["summarize"]


async def summarize(
    request: GatherSummaryRequest, *, views: Views, content: ContentReads, anchored: AnchoredText, inference: InferenceClient
) -> ContextualSummaryResponse:
    """The summary of the annotation a `gather:summary-requested` names.

    Raises `Ungathered` for a resource with no view, for an annotation the
    view does not hold or whose target names another resource, and for a
    resource whose text is not there. A target nothing places in the text
    (`semiont_librarian.window.Unplaced`), a read of bytes that fails and a
    model that fails each raise what they failed with.

    `relevantFields` states the resource's id and its name, and the
    annotation's entity types.
    """
    view = await views.get(request.resource_id)
    if view is None:
        raise Ungathered(f"Resource {request.resource_id} not found in view storage")
    annotation = next((held for held in view.annotations.annotations if held.id == request.annotation_id), None)
    if annotation is None:
        raise Ungathered("Annotation not found")

    on = target_source(annotation.target)
    if on != request.resource_id:
        raise Ungathered(f"Annotation target resource ID ({on}) does not match expected resource ID ({request.resource_id})")
    resource = view.resource
    text = await text_of(resource, content=content, anchored=anchored)
    if text is None:
        raise Ungathered("Resource content not found: no text for this media (not decoded, and no derived text yet)")

    # As much on each side as the prompt has and the answer states, and no more.
    around = annotation_context(annotation, text, NEAR, NEAR)
    types = entity_types(annotation)
    asking = annotation_summary_prompt(
        resource=resource.name, before=around.before, selected=around.selected, after=around.after, entity_types=types
    )
    summary = await ask(inference, asking)

    return ContextualSummaryResponse(
        summary=summary,
        relevant_fields=ContextualSummaryResponseRelevantFields(resource_id=resource.id, resource_name=resource.name, entity_types=types),
        context=ContextualSummaryResponseContext(before=around.before, selected=around.selected, after=around.after),
    )
