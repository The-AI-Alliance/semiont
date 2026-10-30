@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.annotations

import semiont.errors.SpanRefusal
import semiont.errors.SpanRefusedError
import semiont.identifiers.ResourceId
import semiont.types.Agent
import semiont.types.AnchoredText
import semiont.types.Annotation
import semiont.types.AnnotationBodies
import semiont.types.AnnotationBody
import semiont.types.AnnotationSelector
import semiont.types.AnnotationTarget
import semiont.types.AnnotationTargetType
import semiont.types.AnnotationTargetValue
import semiont.types.BodyPurpose
import semiont.types.FragmentSelector
import semiont.types.Motivation
import semiont.types.Selector
import semiont.types.SpecificResource
import semiont.types.TextPositionSelector
import semiont.types.TextQuoteSelector
import semiont.types.TextualBody
import semiont.types.wireJson
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/*
 * Reading an annotation, and building one. An annotation's target is a
 * resource's id or an object; its selector is one selector or a list; its body
 * is absent, one item or a list. The readers read each, so that nothing that
 * reads an annotation narrows those shapes by hand. The builders make the
 * annotations a worker commits, each with the id every SDK gives it, so
 * building it again, in any language, writes nothing new. The case tables in
 * specs/src/annotations hold each to one answer.
 */

/** A body's items: none when there is no body, the one when it is a single item, each when it is a list. */
private fun itemsOf(body: AnnotationBodies?): List<AnnotationBody> = when (body) {
    null -> emptyList()
    is AnnotationBodies.List -> body.value
    is AnnotationBody -> listOf(body)
}

/** A selector's items: the one when it is a single selector, each when it is a list. */
private fun selectorsOf(selector: AnnotationSelector): List<Selector> = when (selector) {
    is AnnotationSelector.List -> selector.value
    is Selector -> listOf(selector)
}

/** The resource a body links to: the first resource it names, which is the link the graph draws. Nothing for a body that names none. */
public fun bodySource(body: AnnotationBodies?): ResourceId? = itemsOf(body).firstNotNullOfOrNull { (it as? SpecificResource)?.source }

/** Whether a body links to a resource. */
public fun isBodyResolved(body: AnnotationBodies?): Boolean = bodySource(body) != null

/** The resource a target names, whether the target is that resource's id or an object that states it. */
public fun targetSource(target: AnnotationTargetValue): ResourceId = when (target) {
    is AnnotationTarget -> target.source
    is AnnotationTargetValue.ResourceId -> target.value
}

/** A target's selector: one, or a list. Nothing for a target that is only a resource's id, and for one that states no selector. */
public fun targetSelector(target: AnnotationTargetValue): AnnotationSelector? = (target as? AnnotationTarget)?.selector

/** Whether an annotation is a highlight. */
public fun isHighlight(annotation: Annotation): Boolean = annotation.motivation == Motivation.Highlighting

/** Whether an annotation is a reference: its motivation is linking. */
public fun isReference(annotation: Annotation): Boolean = annotation.motivation == Motivation.Linking

/** Whether an annotation is an assessment. */
public fun isAssessment(annotation: Annotation): Boolean = annotation.motivation == Motivation.Assessing

/** Whether an annotation is a comment. */
public fun isComment(annotation: Annotation): Boolean = annotation.motivation == Motivation.Commenting

/** Whether an annotation is a tag. */
public fun isTag(annotation: Annotation): Boolean = annotation.motivation == Motivation.Tagging

/** A comment's text: that of its body's first item. Nothing for an annotation that is not a comment, and for a comment whose first item is not text. */
public fun commentText(annotation: Annotation): String? =
    if (isComment(annotation)) (itemsOf(annotation.body).firstOrNull() as? TextualBody)?.value else null

/** Whether an annotation is a reference that links to nothing yet. */
public fun isStubReference(annotation: Annotation): Boolean = isReference(annotation) && !isBodyResolved(annotation.body)

/** Whether an annotation is a reference that links to a resource. */
public fun isResolvedReference(annotation: Annotation): Boolean = isReference(annotation) && isBodyResolved(annotation.body)

/** The quote selector among a selector's items: the first, wherever in a list it is. Nothing for a selector that quotes nothing. */
public fun textQuoteSelector(selector: AnnotationSelector): TextQuoteSelector? = selectorsOf(selector).firstNotNullOfOrNull { it as? TextQuoteSelector }

/** The text a selector quotes: its quote selector's exact text. Empty for a selector that quotes nothing, and for no selector at all. */
public fun exactText(selector: AnnotationSelector?): String = selector?.let(::textQuoteSelector)?.exact ?: ""

/** The text an annotation quotes: that of its target's selector. */
public fun annotationExactText(annotation: Annotation): String = exactText(targetSelector(annotation.target))

/** The text of each body item that states it for `purpose`. */
private fun textsFor(annotation: Annotation, purpose: BodyPurpose): List<String> =
    itemsOf(annotation.body).filterIsInstance<TextualBody>().filter { it.purpose == purpose }.map { it.value }

/** The entity types an annotation states: the text of each body item that tags, in the order its body has them. An item with no text states none. */
public fun entityTypes(annotation: Annotation): List<String> = textsFor(annotation, BodyPurpose.Tagging).filter { it.isNotEmpty() }

/** A tag's category: the text of its body item that tags. Nothing for an annotation that is not a tag. */
public fun tagCategory(annotation: Annotation): String? = if (isTag(annotation)) textsFor(annotation, BodyPurpose.Tagging).firstOrNull() else null

/** The id of the schema a tag's category is of: the text of its body item that classifies. Nothing for an annotation that is not a tag. */
public fun tagSchemaId(annotation: Annotation): String? = if (isTag(annotation)) textsFor(annotation, BodyPurpose.Classifying).firstOrNull() else null

/** What a PDF's fragment conforms to. */
private const val PDF_FRAGMENTS = "http://tools.ietf.org/rfc/rfc3778"

private val INSTANT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** Whether two offsets are a span of a text of `length` code points: in order, inside the text. */
private fun isASpanOf(length: Int, start: Long, end: Long): Boolean = start in 0..end && end <= length

/** A selector for each rectangle a span of a PDF's anchored text is located at, when the items it overlaps cover its words. */
private fun fragmentsOf(anchored: AnchoredText, whole: IntArray, span: TextSpan): List<Selector> {
    val (overlapping, rectangles) = locate(anchored, span.start, span.end)
    if (rectangles.isEmpty()) throw SpanRefusedError(SpanRefusal.NothingLocated, "no item of the anchored text overlaps offsets ${span.start} to ${span.end}")
    val covered = whole.text(overlapping.minOf { it.start }.toInt(), overlapping.maxOf { it.end }.toInt())
    if (collapsed(span.exact) !in collapsed(covered)) {
        throw SpanRefusedError(SpanRefusal.ExactNotCovered, "the items that overlap offsets ${span.start} to ${span.end} do not cover the span's words")
    }
    return rectangles.map { FragmentSelector(value = fragmentOf(it), conformsTo = PDF_FRAGMENTS) }
}

/** The annotation of `target`, built now, with the id of what it is. It states what it was given and nothing else. */
private fun built(target: AnnotationTarget, motivation: Motivation, anchor: String, generator: Agent?, body: AnnotationBodies?): Annotation {
    val written = body?.let { wireJson.encodeToJsonElement(AnnotationBodies.serializer(), it) }
    return Annotation(
        id = annotationIdFor(target.source, motivation, anchor, written),
        motivation = motivation,
        target = target,
        body = body,
        generator = generator,
        created = INSTANT.format(Instant.now().truncatedTo(ChronoUnit.MILLIS)),
    )
}

/** The span checked against `whole`, the text it is of, and its selectors, the quote last. */
private fun selected(whole: IntArray, span: TextSpan, where: () -> List<Selector>): List<Selector> {
    if (!isASpanOf(whole.size, span.start, span.end)) {
        throw SpanRefusedError(SpanRefusal.SpanOutOfRange, "offsets ${span.start} to ${span.end} are not a span of a text of ${whole.size} code points")
    }
    val located = where()
    val start = span.start.toInt()
    val end = span.end.toInt()
    if (span.prefix != null && !whole.hasAt(start - codePointsOf(span.prefix).size, codePointsOf(span.prefix))) {
        throw SpanRefusedError(SpanRefusal.PrefixMismatch, "the span's prefix is not the text just before offset $start")
    }
    if (span.suffix != null && !whole.hasAt(end, codePointsOf(span.suffix))) {
        throw SpanRefusedError(SpanRefusal.SuffixMismatch, "the span's suffix is not the text just after offset $end")
    }
    return located + TextQuoteSelector(exact = span.exact, prefix = span.prefix?.ifEmpty { null }, suffix = span.suffix?.ifEmpty { null })
}

private fun ofSpan(resourceId: ResourceId, motivation: Motivation, span: TextSpan, generator: Agent, body: AnnotationBodies?, selectors: List<Selector>): Annotation =
    built(
        AnnotationTarget(type = AnnotationTargetType.SpecificResource, source = resourceId, selector = AnnotationSelector.List(selectors)),
        motivation,
        "${span.start}:${span.end}:${span.exact}",
        generator,
        body,
    )

/**
 * Build the annotation of a span of a resource's text, selected by its
 * position and its quote. `generator` says what made the annotation, and
 * `body` is carried as it is given. A span is checked against the text before
 * anything is built, and one that is not the text's throws `SpanRefusedError`,
 * whose `reason` says which refusal it is. A span `reconcile` found is the
 * text's own.
 */
@JvmOverloads
@JvmExposeBoxed
public fun annotationOfSpan(
    text: String,
    span: TextSpan,
    resourceId: ResourceId,
    motivation: Motivation,
    generator: Agent,
    body: AnnotationBodies? = null,
): Annotation {
    val whole = codePointsOf(text)
    val selectors = selected(whole, span) {
        if (whole.text(span.start.toInt(), span.end.toInt()) != span.exact) {
            throw SpanRefusedError(SpanRefusal.ExactMismatch, "the text from offset ${span.start} to offset ${span.end} is not the span's words")
        }
        listOf(TextPositionSelector(start = span.start, end = span.end))
    }
    return ofSpan(resourceId, motivation, span, generator, body, selectors)
}

/**
 * Build the annotation of a span of a PDF's anchored text, selected by a
 * rectangle for each line it touches and by its quote. Every item of the
 * anchored text must be a stretch of that text, or no span of it is built
 * (`item-out-of-range`); and the span is then checked as a span of a text is,
 * and must be on the PDF's pages.
 */
@JvmOverloads
@JvmExposeBoxed
public fun annotationOfSpan(
    text: AnchoredText,
    span: TextSpan,
    resourceId: ResourceId,
    motivation: Motivation,
    generator: Agent,
    body: AnnotationBodies? = null,
): Annotation {
    val whole = codePointsOf(text.text)
    // A PDF's anchored text is held to itself before the span is held to it: a rectangle is made from an item's own
    // offsets, so one that is no stretch of the text refuses every span of it, whether this span touches it or not.
    for ((index, item) in text.items.withIndex()) {
        if (!isASpanOf(whole.size, item.start, item.end)) {
            throw SpanRefusedError(
                SpanRefusal.ItemOutOfRange,
                "item $index of the anchored text is offsets ${item.start} to ${item.end}, which is no stretch of a text of ${whole.size} code points",
            )
        }
    }
    val selectors = selected(whole, span) { fragmentsOf(text, whole, span) }
    return ofSpan(resourceId, motivation, span, generator, body, selectors)
}

/**
 * Build an annotation of a resource as a whole, which has no selector. The
 * link from a resource to one generated from it is such an annotation: its
 * `motivation` is linking, and its `body` names the generated resource.
 */
@JvmOverloads
@JvmExposeBoxed
public fun annotationOfResource(resourceId: ResourceId, motivation: Motivation, generator: Agent? = null, body: AnnotationBodies? = null): Annotation =
    built(AnnotationTarget(source = resourceId), motivation, "", generator, body)
