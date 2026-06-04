# W3C Web Annotation Selectors

This document describes Semiont's implementation of W3C Web Annotation selectors for text and future support for images.

**Related Documentation:**
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Complete annotation architecture
- [API Reference](./API.md) - REST API endpoints
- [OpenAPI Specification](../../specs/openapi.json) - Machine-readable API spec
- [@semiont/core Utilities](../../packages/core/docs/Utilities.md) - Implementation aids: fuzzy anchoring, SVG selector parsing, position validation

## Text Selectors (Implemented)

Semiont implements **W3C-compliant text selectors** using a combination of TextPositionSelector and TextQuoteSelector for robustness.

### Current Implementation

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

Specifies character positions from the start of the document:

```typescript
{
  type: "TextPositionSelector",
  start: number,  // Character offset from beginning
  end: number     // Character offset from beginning (NOT length)
}
```

**W3C Specification:** [§4.2.1 TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)

### TextQuoteSelector

Specifies the exact text with optional context:

```typescript
{
  type: "TextQuoteSelector",
  exact: string,    // The selected text
  prefix?: string,  // Text immediately before (optional)
  suffix?: string   // Text immediately after (optional)
}
```

**W3C Specification:** [§4.2.4 TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)

### Benefits of Dual Selectors

- **TextPositionSelector**: Fast, precise lookup when document unchanged
- **TextQuoteSelector**: Recovery when document content shifts
- **Prefix/Suffix**: Additional context for robust matching

### Dual Selectors Are Written to Agree

The two selectors are not independent guesses — they are reconciled at write time so they describe the same span. The LLM does **not** supply offsets; it supplies `exact` (a verbatim substring) plus optional prefix/suffix context. Our code computes `start`/`end` by searching the source for `exact`, and a no-overlap invariant rejects any annotation whose selectors disagree:

```
content.substring(start, end) === exact
content.substring(start - prefix.length, start) === prefix   // when prefix present
content.substring(end, end + suffix.length) === suffix       // when suffix present
```

This write-time reconciliation (`reconcileSelector` in `@semiont/core`) is where fuzzy matching lives — verbatim, then deterministic normalization (smart quotes, whitespace), then Levenshtein within a 5% tolerance — because the source content is in hand and the output is the authoritative record. All five annotation-detection workers converge on it. When `exact` appears more than once, prefix/suffix disambiguate; an undisambiguated multi-occurrence match is flagged `first-of-many` for audit rather than silently anchored. See [@semiont/core Utilities](../../packages/core/docs/Utilities.md#reconcile-llm-emitted-selectors).

### Render-Time Anchoring (Verbatim Only)

Because the stored selectors already agree, the renderer trusts them and re-anchors only on a **verbatim** quote match. The one legitimate render-time discrepancy is *positional drift*: content shifted above the span after the annotation was written, so the `TextPositionSelector` is stale but `exact` still exists byte-identical. `anchorAnnotation` (`@semiont/core`) recovers it — uniquely, disambiguated by prefix/suffix, or (for repeated text) by closest-to-offset position — and flags anything it cannot resolve verbatim as low-confidence rather than fuzzy-matching at render time. This is the W3C-intended use of `TextQuoteSelector` for recovery; the fuzzy fallback chain stays on the write side.

## Image Selectors (Future)

Planned support for image annotation using W3C-compliant selectors.

### FragmentSelector

For simple rectangular regions (most common):

```json
{
  "type": "FragmentSelector",
  "conformsTo": "http://www.w3.org/TR/media-frags/",
  "value": "xywh=pixel:100,200,150,80"
}
```

**W3C Specification:** [§4.2.9 FragmentSelector](https://www.w3.org/TR/annotation-model/#fragment-selector)

**Media Fragments Spec:** [W3C Media Fragments URI](https://www.w3.org/TR/media-frags/)

### SvgSelector

For non-rectangular regions (circles, polygons, freehand):

```json
{
  "type": "SvgSelector",
  "value": "<svg><circle cx='200' cy='200' r='80'/></svg>"
}
```

**W3C Specification:** [§4.2.8 SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)

### Use Cases

- Annotate UI elements in screenshots
- Tag regions in architectural diagrams
- Identify faces or objects in photos
- Mark up visual documentation

### Security Considerations

SVG selectors will be validated to prevent:
- XSS attacks via `<script>` tags
- Event handler injection (`onclick`, `onload`)
- External resource loading (`<image>`, `xlink:href`)
- CSS injection via `<style>` attributes

Only basic SVG shapes will be permitted: `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<path>`.

## References

- [W3C Web Annotation Model](https://www.w3.org/TR/annotation-model/)
- [W3C Selectors Specification](https://www.w3.org/TR/annotation-model/#selectors)
- [TextPositionSelector](https://www.w3.org/TR/annotation-model/#text-position-selector)
- [TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- [FragmentSelector](https://www.w3.org/TR/annotation-model/#fragment-selector)
- [SvgSelector](https://www.w3.org/TR/annotation-model/#svg-selector)
- [Media Fragments URI](https://www.w3.org/TR/media-frags/)
