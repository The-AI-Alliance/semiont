# Content API Reference

## Overview

The `@semiont/content` package manages files in the project working tree, records SHA-256 checksums for integrity, and extracts positioned text layers from PDFs.

## WorkingTreeStore

### Initialization

```typescript
import { WorkingTreeStore } from '@semiont/content';
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject('/path/to/project');
const store = new WorkingTreeStore(project, logger /* optional */);
```

The store resolves `file://` URIs against the project root. When the project has `[git] sync = true` in `.semiont/config`, mutating operations also keep the git index up to date; every method accepts `{ noGit: true }` to skip that for a single call.

### Storing Content

`store()` writes bytes to disk. Used when the file does not yet exist and the caller provides content (API/GUI/AI path).

```typescript
const stored = await store.store(
  Buffer.from('# Overview\n'),
  'file://docs/overview.md'
);

// Returns StoredResource:
// {
//   storageUri: 'file://docs/overview.md',
//   checksum: '5aaa0b72...',        // SHA-256 hex of content
//   byteSize: 12,
//   created: '2026-06-10T12:00:00.000Z'
// }
```

Intermediate directories are created automatically. With git sync, the file is staged via `git add`.

### Registering Existing Files

`register()` reads a file that is already on disk and returns its metadata (CLI path). If `expectedChecksum` is provided and does not match, it throws `ChecksumMismatchError`.

```typescript
const registered = await store.register('file://docs/overview.md');

// With verification:
await store.register('file://docs/overview.md', expectedChecksum);
// throws ChecksumMismatchError on mismatch
```

### Retrieving Content

```typescript
const buffer = await store.retrieve('file://docs/overview.md');
const text = buffer.toString('utf-8');
// Throws "Resource not found: <uri>" if the file does not exist
```

### Moving and Removing

```typescript
// Rename/move (git mv with git sync, fs.rename otherwise)
await store.move('file://docs/overview.md', 'file://docs/intro.md');

// Delete (git rm with git sync, fs.unlink otherwise)
await store.remove('file://docs/intro.md');

// Remove from the git index but keep the file on disk (git rm --cached)
await store.remove('file://docs/intro.md', { keepFile: true });
```

### Resolving URIs

```typescript
store.resolveUri('file://docs/overview.md');
// => '/path/to/project/docs/overview.md'
// Throws for URIs that do not start with file://
```

### Types

```typescript
interface StoredResource {
  storageUri: string;    // file:// URI (e.g. "file://docs/overview.md")
  checksum: string;      // SHA-256 hex of content
  byteSize: number;      // Size in bytes
  created: string;       // ISO 8601 timestamp
}

class ChecksumMismatchError extends Error {
  readonly storageUri: string;
  readonly expected: string;
  readonly actual: string;
}
```

## Checksum Utilities

```typescript
import { calculateChecksum, verifyChecksum } from '@semiont/content';

const checksum = calculateChecksum(Buffer.from('Hello'));
// SHA-256 hex string (64 chars)

verifyChecksum(Buffer.from('Hello'), checksum);  // true
```

## Storage URI Derivation

```typescript
import { deriveStorageUri } from '@semiont/content';
import type { SupportedMediaType } from '@semiont/core';

deriveStorageUri('My Document', 'text/markdown');
// 'file://my-document.md' (lowercased, non-alphanumerics collapsed to hyphens)
```

The `format` parameter is a `SupportedMediaType` — extensions come from the
media-type registry in `@semiont/core`, and formats are validated upstream at
the create/yield boundary, so the lookup is strict (no `.dat` fallback here).
Extension lookups for arbitrary strings (`extensionForMediaType`,
`mediaTypeForExtension`, capability queries) live in `@semiont/core`; see
[mime-types.md](./mime-types.md).

## PDF Text Layer

### extractPdfTextLayer

Extracts positioned text from a native (non-scanned) PDF using pdfjs-dist. Returns `null` when the document has no text items (scanned/image-only PDFs).

```typescript
import { extractPdfTextLayer } from '@semiont/content';

const layer = await extractPdfTextLayer(pdfBytes);  // Uint8Array | Buffer
if (layer === null) {
  // scanned or image-only PDF
}
```

### locate

Finds bounding rectangles for a character span `[start, end)` of `layer.text`. Returns one `PdfCoordinate` per line of text covered by the span (possibly across pages), or an empty array if no text items overlap the span.

```typescript
import { locate } from '@semiont/content';

const rects = locate(layer, 120, 178);
// => [{ page: 1, x: 56.7, y: 701.2, width: 213.4, height: 11.9 }, ...]
```

### Types

```typescript
interface PdfTextLayer {
  pages: PdfPageInfo[];  // Page dimensions in PDF points
  text: string;          // Reading-order concatenation across all pages
  items: PdfTextItem[];  // One entry per text run (roughly a word)
}

interface PdfTextItem {
  start: number;  // Char offset in PdfTextLayer.text (inclusive)
  end: number;    // Char offset in PdfTextLayer.text (exclusive)
  page: number;   // 1-indexed page number
  x: number;      // PDF points, origin bottom-left
  y: number;
  width: number;
  height: number;
}

interface PdfPageInfo {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}
```

All geometry is in PDF point space with the origin at the bottom-left of the page (Y increases upward). The Y-flip to canvas pixels happens downstream in the browser. The `PdfCoordinate` type that `locate()` emits lives in `@semiont/core` alongside the viewrect FragmentSelector codec.
