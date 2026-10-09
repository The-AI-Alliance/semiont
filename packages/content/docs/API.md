# Content API Reference

Each call of `@semiont/content`, with an example. Why the package is shaped as it is, is [Architecture](architecture.md).

## Checksum

```typescript
import { calculateChecksum } from '@semiont/content';

const checksum = calculateChecksum(Buffer.from('Hello'));
// SHA-256 hex string (64 chars)
```

## Naming a file

A `file://` URI is made from a resource's name and its media type by `deriveStorageUri`, which is [`@semiont/core`](../../core/README.md)'s, beside the registry of media types it reads:

```typescript
import { deriveStorageUri } from '@semiont/core';

deriveStorageUri('My Document', 'text/markdown');   // 'file://my-document.md'
```

## Reading bytes without a mount

A service that does not mount the knowledge base reads a resource's bytes from the Archivist:

```typescript
import { archivistContentReads, RepresentationMissing } from '@semiont/content';
```

`archivistContentReads(...)` answers a `ContentReads`: the transport contract's `getBinary`, keyed by resource id. It finds the Archivist's address when it is made, so a service with none configured fails as it starts. A read of a resource the Archivist does not have, or one with no stored representation, throws `RepresentationMissing`, whose `reason` says which.

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

Finds bounding rectangles for a span `[start, end)` of `layer.text`, two offsets counted in Unicode code points. Exported by `@semiont/core`. Returns `rects`, one `PdfCoordinate` per line of text covered by the span (possibly across pages), and `overlap`, the text items they were computed from; both are empty if no text items overlap the span.

```typescript
import { locate } from '@semiont/core';

const { rects, overlap } = locate(layer, 120, 178);
// rects => [{ page: 1, x: 56.7, y: 701.2, width: 213.4, height: 11.9 }, ...]
```

### Types

`PdfTextLayer`, `PdfPageInfo` and `PdfFormField` are defined, field by field, in [`src/pdf-text-layer.ts`](../src/pdf-text-layer.ts). A layer is the reading-order `text` of the whole document, the `items` that index it (one per run of text, each with its range of the text, counted in code points, and its place on a page), the `pages`, and the filled values of a form's `fields`. `PdfTextItem` is `@semiont/core`'s.

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
this package, pdf.js, the engine and its traineddata. A stamp mismatch, an entry
of another format version, a corrupt file and an absent one are all the same
answer: a miss. A read never
throws; a failed write does, and the extractor catches it, so the store may
make extraction faster, never make it fail.

See **[ANCHORING.md](../../../docs/architecture/ANCHORING.md)** for the pipeline this
sits in.
