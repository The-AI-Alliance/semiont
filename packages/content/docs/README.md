# @semiont/content Documentation

Documentation for the working-tree content package.

## Topics

- **[API Reference](API.md)** - Complete API documentation
- **[Architecture](architecture.md)** - Design principles and implementation
- **[MIME Types](mime-types.md)** - Media type handling (80+ types)

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

### MIME Types

- 80+ supported types with proper extensions
- `deriveStorageUri()` builds a `file://` URI from a resource name and MIME type
- Unknown types default to `.dat`

From [../src/working-tree-store.ts](../src/working-tree-store.ts): Working tree storage.
From [../src/extract-pdf-text-layer.ts](../src/extract-pdf-text-layer.ts): PDF text-layer extraction.
From [../src/locate.ts](../src/locate.ts): Span-to-rectangle geometry.
From [../src/mime-extensions.ts](../src/mime-extensions.ts): MIME type mappings.
From [../src/checksum.ts](../src/checksum.ts): SHA-256 utilities.

## External References

- SHA-256: [NIST FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf)
- MIME Types: [RFC 2045](https://datatracker.ietf.org/doc/html/rfc2045)
- pdf.js: [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)
