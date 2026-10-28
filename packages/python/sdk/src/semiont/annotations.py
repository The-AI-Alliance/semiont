"""Reading an annotation, and building one.

An annotation's `target` is a resource's id or an object; its `selector` is one
selector or a list; its `body` is absent, one item or a list. The readers read
each, so that nothing that reads an annotation narrows those shapes by hand.

The builders make the annotations a worker commits. `reconcile` finds the
words a model quoted in a text, `annotation_of_span` builds the annotation of
the span it found, and `annotation_of_resource` builds one of a resource as a
whole. An annotation built here has the id every SDK gives it, so building it
again, in any language, writes nothing new.

Every SDK has the readers and the builders. The case tables in
`specs/src/annotations` hold each to one answer (`reader-cases.json`,
`reconcile-cases.json`, `builder-cases.json`): this package's tests run them.
"""

from collections.abc import Iterator, Sequence
from datetime import UTC, datetime
from typing import Final

from pydantic import JsonValue

from semiont._annotation_id import annotation_id_for
from semiont._pdf_locate import fragment_of, locate
from semiont._spans import AnchorMethod, MatchQuality, QuotedText, ReconciledSpan, TextSpan, reconcile
from semiont._white_space import collapsed
from semiont.error_codes import SpanRefusal
from semiont.errors import SpanRefusedError
from semiont.identifiers import ResourceId
from semiont.model import stated, written
from semiont.types import (
    Agent,
    AnchoredText,
    Annotation,
    AnnotationBodies,
    AnnotationBody,
    AnnotationSelector,
    AnnotationTarget,
    BodyPurpose,
    FragmentSelector,
    Motivation,
    Selector,
    SpecificResource,
    TextPositionSelector,
    TextQuoteSelector,
    TextualBody,
)

__all__ = [
    "AnchorMethod",
    "MatchQuality",
    "QuotedText",
    "ReconciledSpan",
    "SpanRefusal",
    "SpanRefusedError",
    "TextSpan",
    "annotation_exact_text",
    "annotation_of_resource",
    "annotation_of_span",
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
    "reconcile",
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


_PDF_FRAGMENTS: Final = "http://tools.ietf.org/rfc/rfc3778"
"""What a PDF's fragment conforms to."""


def _is_a_span_of(length: int, start: object, end: object) -> bool:
    """Whether two offsets are a span of a text of `length` code points: whole numbers, in order, inside the text.

    A type checker holds a caller to whole numbers. Code that has none hands
    on whatever it read, and that is refused here by name.
    """
    return isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= length


def _fragments(anchored: AnchoredText, span: TextSpan) -> list[Selector]:
    """A selector for each rectangle a span of a PDF's anchored text is located at, when the items it overlaps cover its words."""
    overlapping, rectangles = locate(anchored, span.start, span.end)
    if not rectangles:
        raise SpanRefusedError("nothing-located", f"no item of the anchored text overlaps offsets {span.start} to {span.end}")
    covered = anchored.text[min(item.start for item in overlapping) : max(item.end for item in overlapping)]
    if collapsed(span.exact) not in collapsed(covered):
        raise SpanRefusedError(
            "exact-not-covered", f"the items that overlap offsets {span.start} to {span.end} do not cover the span's words"
        )
    return [FragmentSelector(type="FragmentSelector", conforms_to=_PDF_FRAGMENTS, value=fragment_of(rectangle)) for rectangle in rectangles]


def _said(body: AnnotationBodies | None) -> AnnotationBodies | None:
    """A body saying only what it holds, one body or a list as it was given."""
    if body is None:
        return None
    if isinstance(body, list):
        return [stated(item) for item in body]
    return stated(body)


def _as_written(body: AnnotationBodies | None) -> JsonValue:
    """A body as the wire carries it, which is what goes into an annotation's id. `None` for no body."""
    if body is None:
        return None
    if isinstance(body, list):
        items: list[JsonValue] = [written(item) for item in body]
        return items
    return written(body)


def _built(
    target: AnnotationTarget, motivation: Motivation, anchor: str, generator: Agent | None, body: AnnotationBodies | None
) -> Annotation:
    """The annotation of `target`, built now, with the id of what it is. It states what it was given and nothing else."""
    said = _said(body)
    return stated(
        Annotation(
            context="http://www.w3.org/ns/anno.jsonld",
            type="Annotation",
            id=annotation_id_for(target.source, motivation, anchor, _as_written(said)),
            motivation=motivation,
            target=target,
            body=said,
            generator=None if generator is None else stated(generator),
            created=datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        )
    )


def annotation_of_span(
    text: str | AnchoredText,
    span: TextSpan,
    *,
    resource_id: ResourceId,
    motivation: Motivation,
    generator: Agent,
    body: AnnotationBodies | None = None,
) -> Annotation:
    """Build the annotation of a span of a resource's text.

    `text` is the resource's text, or a PDF's anchored text. A span of a text
    is selected by its position and its quote. A span of a PDF is selected by
    a rectangle for each line it touches, and its quote. `generator` says what
    made the annotation, and `body` is carried as it is given.

    A span is checked against the text before anything is built, and one that
    is not the text's raises `SpanRefusedError`, whose `code` says which
    refusal it is. A span `reconcile` found is the text's own. For a PDF,
    every item of the anchored text must be a stretch of that text, or no span
    of it is built (`item-out-of-range`).
    """
    whole = text if isinstance(text, str) else text.text
    if not isinstance(text, str):
        # A PDF's anchored text is held to itself before the span is held to it. Its items are what say where
        # the text is on a page, and a rectangle is made from an item's own offsets, so one that is no stretch
        # of the text refuses every span of it, whether this span touches that item or not.
        for index, item in enumerate(text.items):
            if not _is_a_span_of(len(whole), item.start, item.end):
                raise SpanRefusedError(
                    "item-out-of-range",
                    f"item {index} of the anchored text is offsets {item.start} to {item.end}, "
                    f"which is no stretch of a text of {len(whole)} code points",
                )
    if not _is_a_span_of(len(whole), span.start, span.end):
        raise SpanRefusedError(
            "span-out-of-range", f"offsets {span.start} to {span.end} are not a span of a text of {len(whole)} code points"
        )
    where: list[Selector]
    if isinstance(text, str):
        if whole[span.start : span.end] != span.exact:
            raise SpanRefusedError("exact-mismatch", f"the text from offset {span.start} to offset {span.end} is not the span's words")
        where = [TextPositionSelector(type="TextPositionSelector", start=span.start, end=span.end)]
    else:
        where = _fragments(text, span)
    if span.prefix is not None and not whole.endswith(span.prefix, 0, span.start):
        raise SpanRefusedError("prefix-mismatch", f"the span's prefix is not the text just before offset {span.start}")
    if span.suffix is not None and not whole.startswith(span.suffix, span.end):
        raise SpanRefusedError("suffix-mismatch", f"the span's suffix is not the text just after offset {span.end}")
    quote = stated(TextQuoteSelector(type="TextQuoteSelector", exact=span.exact, prefix=span.prefix or None, suffix=span.suffix or None))
    selector: list[Selector] = [*where, quote]
    return _built(
        AnnotationTarget(type="SpecificResource", source=resource_id, selector=selector),
        motivation,
        f"{span.start}:{span.end}:{span.exact}",
        generator,
        body,
    )


def annotation_of_resource(
    resource_id: ResourceId,
    *,
    motivation: Motivation,
    generator: Agent | None = None,
    body: AnnotationBodies | None = None,
) -> Annotation:
    """Build an annotation of a resource as a whole, which has no selector.

    The link from a resource to one generated from it is such an annotation:
    its `motivation` is `linking`, and its `body` names the generated resource.
    """
    return _built(AnnotationTarget(source=resource_id), motivation, "", generator, body)
