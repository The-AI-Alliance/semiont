"""Reading an annotation.

An annotation's `target` is a resource's id or an object; its `selector` is one
selector or a list; its `body` is absent, one item or a list. These functions
read each, so that nothing that reads an annotation narrows those shapes by
hand.

Every SDK has them, and `specs/src/annotations/reader-cases.json` holds each to
one answer for one annotation: this package's tests run it.
"""

from collections.abc import Iterator, Sequence

from semiont.identifiers import ResourceId
from semiont.types import (
    Annotation,
    AnnotationBodies,
    AnnotationBody,
    AnnotationSelector,
    AnnotationTarget,
    BodyPurpose,
    Selector,
    SpecificResource,
    TextQuoteSelector,
    TextualBody,
)

__all__ = [
    "annotation_exact_text",
    "body_source",
    "comment_text",
    "entity_types",
    "exact_text",
    "is_assessment",
    "is_body_resolved",
    "is_comment",
    "is_highlight",
    "is_reference",
    "is_resolved_reference",
    "is_stub_reference",
    "is_tag",
    "tag_category",
    "tag_schema_id",
    "target_selector",
    "target_source",
    "text_quote_selector",
]


def _items(body: AnnotationBodies | None) -> Sequence[AnnotationBody]:
    """A body's items: none when there is no body, the one when it is a single item, each when it is a list."""
    if body is None:
        return ()
    if isinstance(body, list):
        return body
    return (body,)


def _selectors(selector: AnnotationSelector) -> Sequence[Selector]:
    """A selector's items: the one when it is a single selector, each when it is a list."""
    if isinstance(selector, list):
        return selector
    return (selector,)


def body_source(body: AnnotationBodies | None) -> ResourceId | None:
    """The resource a body links to: the first resource it names, which is the link the graph draws. Nothing for a body that names none."""
    for item in _items(body):
        if isinstance(item, SpecificResource):
            return item.source
    return None


def is_body_resolved(body: AnnotationBodies | None) -> bool:
    """Whether a body links to a resource."""
    return body_source(body) is not None


def target_source(target: ResourceId | AnnotationTarget) -> ResourceId:
    """The resource a target names, whether the target is that resource's id or an object that states it."""
    return target.source if isinstance(target, AnnotationTarget) else target


def target_selector(target: ResourceId | AnnotationTarget) -> AnnotationSelector | None:
    """A target's selector: one, or a list. Nothing for a target that is only a resource's id, and for one that states no selector."""
    return target.selector if isinstance(target, AnnotationTarget) else None


def is_highlight(annotation: Annotation) -> bool:
    """Whether an annotation is a highlight."""
    return annotation.motivation == "highlighting"


def is_reference(annotation: Annotation) -> bool:
    """Whether an annotation is a reference: its motivation is linking."""
    return annotation.motivation == "linking"


def is_assessment(annotation: Annotation) -> bool:
    """Whether an annotation is an assessment."""
    return annotation.motivation == "assessing"


def is_comment(annotation: Annotation) -> bool:
    """Whether an annotation is a comment."""
    return annotation.motivation == "commenting"


def is_tag(annotation: Annotation) -> bool:
    """Whether an annotation is a tag."""
    return annotation.motivation == "tagging"


def comment_text(annotation: Annotation) -> str | None:
    """A comment's text: that of its body's first item.

    Nothing for an annotation that is not a comment, and for a comment whose first item is not text.
    """
    if not is_comment(annotation):
        return None
    items = _items(annotation.body)
    if items and isinstance(items[0], TextualBody):
        return items[0].value
    return None


def is_stub_reference(annotation: Annotation) -> bool:
    """Whether an annotation is a reference that links to nothing yet."""
    return is_reference(annotation) and not is_body_resolved(annotation.body)


def is_resolved_reference(annotation: Annotation) -> bool:
    """Whether an annotation is a reference that links to a resource."""
    return is_reference(annotation) and is_body_resolved(annotation.body)


def text_quote_selector(selector: AnnotationSelector) -> TextQuoteSelector | None:
    """The quote selector among a selector's items: the first, wherever in a list it is. Nothing for a selector that quotes nothing."""
    for item in _selectors(selector):
        if isinstance(item, TextQuoteSelector):
            return item
    return None


def exact_text(selector: AnnotationSelector | None) -> str:
    """The text a selector quotes: its quote selector's exact text. Empty for a selector that quotes nothing, and for no selector at all."""
    quote = None if selector is None else text_quote_selector(selector)
    return "" if quote is None else quote.exact


def annotation_exact_text(annotation: Annotation) -> str:
    """The text an annotation quotes: that of its target's selector."""
    return exact_text(target_selector(annotation.target))


def _texts_for(annotation: Annotation, purpose: BodyPurpose) -> Iterator[str]:
    """The text of each body item that states it for `purpose`."""
    for item in _items(annotation.body):
        if isinstance(item, TextualBody) and item.purpose == purpose:
            yield item.value


def entity_types(annotation: Annotation) -> list[str]:
    """The entity types an annotation states: the text of each body item that tags, in the order its body has them.

    An item with no text states none.
    """
    return [text for text in _texts_for(annotation, "tagging") if text]


def tag_category(annotation: Annotation) -> str | None:
    """A tag's category: the text of its body item that tags. Nothing for an annotation that is not a tag."""
    return next(_texts_for(annotation, "tagging"), None) if is_tag(annotation) else None


def tag_schema_id(annotation: Annotation) -> str | None:
    """The id of the schema a tag's category is of: the text of its body item that classifies.

    Nothing for an annotation that is not a tag.
    """
    return next(_texts_for(annotation, "classifying"), None) if is_tag(annotation) else None
