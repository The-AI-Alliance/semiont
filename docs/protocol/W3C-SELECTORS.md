# W3C Web Annotation Selectors

Which selectors a Semiont annotation carries, and why the answer depends on the
resource it points at.

A resource's media type constrains the selectors that can apply to it. Text
offers offsets into it; a PDF offers page geometry; an image offers regions.
The media-type registry records that as `AnchoringModel` — `'text-selector'` or
`'spatial'` — and every producer follows it. **How** the geometry for a spatial anchor is obtained, and
how a scanned page gets one at all, is
[ANCHORING.md](../architecture/ANCHORING.md).

**Related Documentation:**
- [Anchoring](../architecture/ANCHORING.md) - How a coordinate map is derived, stored and turned into a selector
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Complete annotation architecture
- [Semiont Protocol](./README.md) - The eight verbs and the bus these annotations travel on
- [OpenAPI Specification](../../specs/src/openapi.json) - Machine-readable API spec
- [Media Types](../architecture/MEDIA-TYPES.md) - What each media type declares, and what that changes
- [@semiont/core Utilities](../../packages/core/docs/Utilities.md) - Implementation aids: fuzzy anchoring, SVG selector parsing, position validation

## Text selectors

Semiont implements **W3C-compliant text selectors** using a combination of TextPositionSelector and TextQuoteSelector for robustness.

### What a text annotation carries

Every text annotation includes both selector types:

```json
{
  "target": {
    "source": "doc-123",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 100,
        "end": 120
      },
      {
        "type": "TextQuoteSelector",
        "exact": "selected text goes here",
        "prefix": "the ",
        "suffix": " is"
      }
    ]
  }
}
```

### TextPositionSelector

Specifies a span by two offsets from the start of the resource's text:

```typescript
import type { TextPositionSelector } from '@semiont/core';

const position: TextPositionSelector = {
  type: 'TextPositionSelector',
  start: 100,   // offset of the first code point selected
  end: 120,     // offset just past the last one: an offset too, not a length
};
```

An offset counts **Unicode code points** from the start of the resource's
decoded text, exactly as it was decoded: nothing is normalized first. That is
the count the Web Annotation Data Model requires, and it is the same number in
every language. A character outside the Basic Multilingual Plane (an emoji, a
mathematical letter, some CJK) is one code point, where a JavaScript string
has two UTF-16 code units for it, so an offset is a string's own position only
up to the first such character. `textOffsets` in `@semiont/core` converts
between the two, and
[`specs/src/text/offset-cases.json`](../../specs/src/text/offset-cases.json)
holds the count for every implementation.

**W3C Specification:** [§4.2.1 TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)

### TextQuoteSelector

Specifies the exact text with optional context:

```typescript
import type { TextQuoteSelector } from '@semiont/core';

const quote: TextQuoteSelector = {
  type: 'TextQuoteSelector',
  exact: 'selected text goes here',   // the selected text
  prefix: 'the ',                      // text immediately before, optional
  suffix: ' is',                       // text immediately after, optional
};
```

**W3C Specification:** [§4.2.4 TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)

### Benefits of Dual Selectors

- **TextPositionSelector**: Fast, precise lookup when document unchanged
- **TextQuoteSelector**: Recovery when document content shifts
- **Prefix/Suffix**: Additional context for robust matching

### Dual Selectors Are Written to Agree

The two selectors are not independent guesses — they are reconciled at write time so they describe the same span. The LLM does **not** supply offsets; it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. Our code computes `start`/`end` by searching the source for `exact`, and a no-overlap invariant rejects any annotation whose selectors disagree:

```
the text from start to end                              is exact
the text that ends at start, as long as prefix is       is prefix   // when prefix present
the text that starts at end, as long as suffix is       is suffix   // when suffix present
```

Every position and every length there is counted in code points.

This write-time reconciliation (`reconcile` in `@semiont/core`, and in every SDK) is where fuzzy matching lives — verbatim, then deterministic normalization (smart quotes, whitespace), then Levenshtein within a 5% tolerance — because the source content is in hand and the output is the authoritative record. All five annotation-detection workers converge on it. When `exact` appears more than once, prefix/suffix disambiguate; an undisambiguated multi-occurrence match is flagged `first-of-many` for audit rather than silently anchored. See [@semiont/core Utilities](../../packages/core/docs/Utilities.md#reconcile-what-a-model-quoted).

### Render-Time Anchoring (Verbatim Only)

Because the stored selectors already agree, the renderer trusts them and re-anchors only on a **verbatim** quote match. The one legitimate render-time discrepancy is *positional drift*: content shifted above the span after the annotation was written, so the `TextPositionSelector` is stale but `exact` still exists byte-identical. `anchorAnnotation` (`@semiont/core`) recovers it — uniquely, disambiguated by prefix/suffix, or (for repeated text) by closest-to-offset position — and flags anything it cannot resolve verbatim as low-confidence rather than fuzzy-matching at render time. This is the W3C-intended use of `TextQuoteSelector` for recovery; the fuzzy fallback chain stays on the write side.

## PDF selectors

A PDF anchors **spatially**. Its characters are drawn at positions rather than
held at offsets, and the extracted text is a derived artifact — re-extraction
could shift every offset — so offsets into it are not a durable anchor for
one. Page geometry is.

### FragmentSelector — RFC 3778

```json
{
  "type": "FragmentSelector",
  "conformsTo": "http://tools.ietf.org/rfc/rfc3778",
  "value": "page=1&viewrect=72,700,240,12"
}
```

`viewrect` is `left,top,width,height` in **PDF points, origin bottom-left**,
Y increasing upward. The flip to canvas pixels happens in the browser.

**One selector per line.** A span crossing three lines produces three
`FragmentSelector`s, each bounding that line's covered words — not one rectangle
swallowing the whitespace between them.

### Paired with a TextQuoteSelector

A PDF annotation carries geometry **and** the words that geometry covers:

```json
{
  "selector": [
    { "type": "FragmentSelector", "conformsTo": "http://tools.ietf.org/rfc/rfc3778",
      "value": "page=1&viewrect=72,700,240,12" },
    { "type": "TextQuoteSelector", "exact": "the passage in question" }
  ]
}
```

The quote is the annotation's only human-readable identity away from the page:
without it a panel entry is anonymous, search over annotation text misses it,
and an export has nothing to print. It is omitted — rather than stored empty —
when a rectangle covers no words, because an empty quote would assert the box
was drawn around nothing.

**No `TextPositionSelector`.** See the opening of this section: offsets into a
derived extraction are not durable.

## Image selectors

An image anchors spatially too, and has no text to quote, so a region is the
whole of the anchor.

### SvgSelector

```json
{
  "type": "SvgSelector",
  "value": "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"100\" y=\"200\" width=\"150\" height=\"80\"/></svg>"
}
```

Three shapes are written and read: a rectangle (`<rect>`), a circle
(`<circle>`) and a polygon (`<polygon>`). Coordinates are in the image's own
pixels, origin top-left, whatever size it was displayed at when the region was
drawn. A selector holding any other markup is not read as a region.

**W3C Specification:** [§4.2.8 SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)

## References

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/)
- [W3C Selectors Specification](https://www.w3.org/TR/annotation-model/#selectors)
- [TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)
- [TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- [FragmentSelector](https://www.w3.org/TR/annotation-model/#fragment-selector)
- [SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)
- [RFC 3778 — PDF Fragment Identifiers](https://tools.ietf.org/rfc/rfc3778)
