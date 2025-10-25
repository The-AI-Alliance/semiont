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

### Migration (Completed 2025-10-24)

Previous non-compliant format:
```json
{
  "type": "TextPositionSelector",
  "exact": "text",     // ❌ Wrong - belongs to TextQuoteSelector
  "offset": 0,         // ❌ Wrong - should be "start"
  "length": 10         // ❌ Wrong - should be "end" (absolute)
}
```

All selectors migrated to W3C-compliant format. See commit history for details.

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
