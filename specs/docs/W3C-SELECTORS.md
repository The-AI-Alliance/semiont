# W3C Web Annotation Selectors

This document describes Semiont's implementation of W3C Web Annotation selectors for text and future support for images.

**Related Documentation:**
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Complete annotation architecture
- [API Reference](./API.md) - REST API endpoints
- [OpenAPI Specification](../openapi.json) - Machine-readable API spec

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

### Fuzzy Anchoring Implementation

Semiont implements **fuzzy anchoring** as specified in the W3C Web Annotation Data Model to handle cases where the same text appears multiple times in a document or when content has been modified. When rendering annotations, the system uses the TextQuoteSelector's `prefix` and `suffix` fields to disambiguate between multiple occurrences of the `exact` text. If an exact match fails (due to whitespace variations or minor content changes), the implementation falls back to fuzzy matching that checks if the prefix/suffix are substrings of the surrounding context, allowing annotations to remain valid even when formatting changes slightly.

The fuzzy anchoring logic is implemented in `apps/frontend/src/lib/fuzzy-anchor.ts` and automatically activates when TextQuoteSelector context is available. The system first attempts exact matching using `endsWith()` for prefix and `startsWith()` for suffix. If no exact match is found, it performs fuzzy matching using `includes()` to handle whitespace variations. This three-tier fallback strategy (exact position → exact context → fuzzy context → first occurrence) ensures annotations remain functional across document edits while maintaining precision when possible.

For AI-detected entity annotations, Semiont automatically extracts 32 characters of prefix and suffix context during the detection phase. This context is stored in the annotation and used by the frontend to correctly locate entity mentions even when the same entity name appears multiple times in a document. The fuzzy anchoring implementation includes comprehensive test coverage (23 tests) validating single occurrences, multiple occurrence disambiguation, fuzzy matching fallbacks, and edge cases including unicode characters and special characters.

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
