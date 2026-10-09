from semiont.annotations import (
    QuotedText,
    annotation_exact_text,
    annotation_of_resource,
    annotation_of_span,
    body_source,
    is_highlight,
    reconcile,
    target_source,
)
from semiont.identifiers import ResourceId
from semiont.types import Agent, AnchoredText, Annotation, SpecificResource


def highlight(text: str, quoted: QuotedText, resource: ResourceId, generator: Agent) -> Annotation | None:
    """A highlight of the words a model quoted, or nothing when the text does not have them."""
    span = reconcile(text, quoted)  # where the words are, as the text has them, with the text's own context
    if span is None:
        return None
    return annotation_of_span(text, span, resource_id=resource, motivation="highlighting", generator=generator)


def highlight_of_a_pdf(anchored: AnchoredText, quoted: QuotedText, resource: ResourceId, generator: Agent) -> Annotation | None:
    """The same of a PDF: the words are found in its anchored text, and selected by rectangles on its pages."""
    span = reconcile(anchored.text, quoted)
    if span is None:
        return None
    return annotation_of_span(anchored, span, resource_id=resource, motivation="highlighting", generator=generator)


def link_to_what_was_generated(source: ResourceId, generated: ResourceId, generator: Agent) -> Annotation:
    """The link from a resource to one generated from it: an annotation of the resource as a whole."""
    names_it = SpecificResource(type="SpecificResource", source=generated, purpose="linking")
    return annotation_of_resource(source, motivation="linking", generator=generator, body=names_it)


def describe(annotation: Annotation) -> str:
    """What an annotation says, read without narrowing its target, its selector or its body by hand."""
    on = target_source(annotation.target)
    if is_highlight(annotation):
        return f"{annotation.id}: a highlight of {annotation_exact_text(annotation)!r} in {on}"
    return f"{annotation.id}: {annotation.motivation}, from {on} to {body_source(annotation.body)}"
