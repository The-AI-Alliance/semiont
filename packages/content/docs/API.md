# Content API Reference

## Overview

The `@semiont/content` package manages files in the project working tree, records SHA-256 checksums for integrity, and extracts positioned text layers from PDFs.

## WorkingTreeStore

### Initialization

```typescript
import { WorkingTreeStore } from '@semiont/content';
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject('/path/to/project', { anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR! });
const store = new WorkingTreeStore(project, logger /* optional */);
```

The store resolves `file://` URIs against the project root. When the project has `[git] sync = true` in `.semiont/config`, mutating operations also keep the git index up to date; each of them accepts `{ noGit: true }` to skip that for a single call.

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
//   checksum: '875dce0e...',        // SHA-256 hex of content
//   byteSize: 11,
//   created: '2026-06-10T12:00:00.000Z'
// }
```

Intermediate directories are created automatically. With git sync, a `git add` of the file is queued: staging is deferred and deduplicated, and `flushStaging()` stages what is pending.

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
interface StoredResource {  // from @semiont/core
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

`deriveStorageUri` is exported by `@semiont/core`, not by this package; it
builds the `file://` URIs the store takes.

```typescript
import { deriveStorageUri } from '@semiont/core';

deriveStorageUri('My Document', 'text/markdown');
// 'file://my-document.md' (lowercased, non-alphanumerics collapsed to hyphens)
```

The `format` parameter is a `SupportedMediaType` — extensions come from the
media-type registry in `@semiont/core`, and formats are validated upstream at
the create/yield boundary, so the lookup is strict (no `.dat` fallback here).
Extension lookups for arbitrary strings (`extensionForMediaType`,
`mediaTypeForExtension`, capability queries) live in `@semiont/core`; see
[mime-types.md](./mime-types.md).

## Deriving text from a PDF

`derivingExtractorFor('application/pdf')` returns the extractor that turns a
PDF into text plus the geometry that indexes it, routing by what the document
actually holds:

| Class | Document | Read by |
|---|---|---|
| A | native text layer | pdf.js, directly |
| B | scanned — pixels only | OCR (Tesseract) |
| C | hybrid — some pages scanned | both; pages still unread are reported |
| D | tables | grid pages rewritten as markdown rows |
| E | forms | AcroForm values folded in, anchored to their widgets |
| F / G | encrypted, corrupt | declined by name, from the parser error |

```typescript
import {
  calculateChecksum,
  createAnchoredTextStore,
  derivingExtractorFor,
} from '@semiont/content';

const store = createAnchoredTextStore(anchoredTextDir);

// null for a media type whose text needs no deriving (text/* decodes)
const extractor = derivingExtractorFor('application/pdf');

if (extractor) {
  const outcome = await extractor.extract(pdfBytes, 'application/pdf', {
    key: calculateChecksum(pdfBytes),  // the identity of the bytes being read
    store,
  });

  if (outcome.kind === 'extracted') {
    outcome.text;          // reading-order text
    outcome.items;         // positioned runs indexing it
    outcome.method;        // 'pdf-text-layer' | 'ocr' | 'table' | 'form'
    outcome.unreadPages;   // class C: pages no reader could recover
  } else {
    outcome.declined;      // why there is no text
  }
}
```

The third argument is required: the anchored-text store, and the key the
outcome is filed under. A stored outcome is returned whole, so neither the
parser nor the OCR engine runs; a fresh one is written to the store. Deriving
is therefore open only to a process that holds the store, and in a running
stack the Smelter is the one that derives. Text that decodes rather than
derives is `decodeRepresentation` in [`@semiont/core`](../../core/README.md).

A decline is named (`'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large'`)
rather than a bare null, so a caller can settle with the reason.
`'no-text-layer'` means recognition ran and came up empty — not that it was
never attempted.

`extractPdfTextLayer()` is the lower-level reader underneath class A, returning
`null` for a document with no text operators anywhere.

Coordinates are PDF points, origin bottom-left; the Y-flip to canvas pixels
happens in the browser. The vocabulary these produce — `AnchoredText`,
`PdfTextItem` — and the `locate` / `textUnder` pair that reads it are exported
from [`@semiont/core`](../../core/README.md), so the browser can reason over
geometry without importing this package's extraction stack.

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

Finds bounding rectangles for a character span `[start, end)` of `layer.text`. Exported by `@semiont/core`. Returns `rects`, one `PdfCoordinate` per line of text covered by the span (possibly across pages), and `overlap`, the text items they were computed from; both are empty if no text items overlap the span.

```typescript
import { locate } from '@semiont/core';

const { rects, overlap } = locate(layer, 120, 178);
// rects => [{ page: 1, x: 56.7, y: 701.2, width: 213.4, height: 11.9 }, ...]
```

### Types

```typescript
interface PdfTextLayer {
  pages: PdfPageInfo[];    // Page dimensions in PDF points
  text: string;            // Reading-order concatenation across all pages
  items: PdfTextItem[];    // One entry per text run (roughly a word)
  fields: PdfFormField[];  // Filled AcroForm values; empty without a form
}

interface PdfTextItem {    // from @semiont/core
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
  textStart: number;      // Char offset in PdfTextLayer.text (inclusive)
  textEnd: number;        // Char offset in PdfTextLayer.text (exclusive)
  hasTextLayer: boolean;  // false for a scanned page
}
```

All geometry is in PDF point space with the origin at the bottom-left of the page (Y increases upward). The Y-flip to canvas pixels happens downstream in the browser. `PdfTextItem` and the `PdfCoordinate` type that `locate()` emits live in `@semiont/core` alongside the viewrect FragmentSelector codec.

## Anchored-text store

OCR costs ~2.9 s per scanned page, and the Smelter's embed, every detection job
and the PDF viewer all read the same document, so what the engine produced is
kept rather than re-derived:

```typescript
import { createAnchoredTextStore } from '@semiont/content';

const store = createAnchoredTextStore(dir, logger);
await store.write(checksum, outcome);       // an ExtractionOutcome; throws if the write fails
const stored = await store.read(checksum);  // null on any miss
```

Derived values only, keyed by content checksum and stamped with the versions of
this package, pdf.js, the engine and its traineddata. A stamp mismatch, a
corrupt file and an absent one are all the same answer: a miss. A read never
throws; a failed write does, and the extractor catches it, so the store may
make extraction faster, never make it fail.

See **[ANCHORING.md](../../../docs/architecture/ANCHORING.md)** for the pipeline this
sits in.
