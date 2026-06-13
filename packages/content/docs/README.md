# @semiont/content Documentation

Documentation for the working-tree content package.

## Topics

- **[API Reference](API.md)** - Complete API documentation
- **[Architecture](architecture.md)** - Design principles and implementation
- **[Media Types](mime-types.md)** - Storage URI derivation (the registry itself lives in @semiont/core)

## Quick Reference

### Working Tree Storage

- The working tree (project root) is the source of truth for file content
- Resources are identified by stable `file://` URIs (e.g. `file://docs/overview.md`)
- Two write paths: `store()` (caller provides bytes) and `register()` (file already on disk)
- SHA-256 checksums recorded for integrity, verified on `register()`
- Optional git staging (`git add`/`mv`/`rm`) when the project has `[git] sync = true`

### PDF Text Layer

- `extractPdfTextLayer()` extracts positioned text runs from native PDFs via pdfjs-dist
- Returns `null` for scanned/image-only PDFs
- `locate()` maps a character span to per-line bounding rectangles
- Coordinates are PDF points, origin bottom-left; the Y-flip happens in the browser

### Media Types

- `deriveStorageUri()` builds a `file://` URI from a resource name and a validated `SupportedMediaType`
- The media-type registry (admitted types, extensions, capabilities) lives in `@semiont/core`'s `media-types.ts`

From [../src/working-tree-store.ts](../src/working-tree-store.ts): Working tree storage.
From [../src/extract-pdf-text-layer.ts](../src/extract-pdf-text-layer.ts): PDF text-layer extraction.
From [../src/locate.ts](../src/locate.ts): Span-to-rectangle geometry.
From [../src/storage-uri.ts](../src/storage-uri.ts): Storage URI derivation.
From [../src/checksum.ts](../src/checksum.ts): SHA-256 utilities.

## External References

- SHA-256: [NIST FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf)
- MIME Types: [RFC 2045](https://datatracker.ietf.org/doc/html/rfc2045)
- pdf.js: [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)
