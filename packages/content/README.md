# @semiont/content

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+content%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=content)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=content)
[![npm version](https://img.shields.io/npm/v/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![License](https://img.shields.io/npm/l/@semiont/content.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Working-tree storage for project resources, with optional git staging, plus PDF text-layer extraction.

## Installation

```bash
npm install @semiont/content
```

## Architecture Context

**Infrastructure Ownership**: In a running stack the working tree store is **held by the Archivist**, the one service that mounts the knowledge base's working tree. Its entry point in [@semiont/make-meaning](../make-meaning/) constructs the store and hands each actor the slice it uses; the Smelter, the Librarian and the worker hold no store and read bytes from the Archivist through `archivistContentReads()`. The in-process root, `startMakeMeaning()`, constructs the same store as the `content` field of its `KnowledgeBase`.

The quick start example below shows direct instantiation for **testing, CLI tools, or content management scripts**.

## Quick Start

```typescript
import { WorkingTreeStore } from '@semiont/content';
import { deriveStorageUri } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject('/path/to/project', {
  anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
});
const store = new WorkingTreeStore(project);

// Derive a stable file:// URI from a resource name
const uri = deriveStorageUri('My Document', 'text/markdown');
// => "file://my-document.md"

// Write content to the working tree (API/GUI/AI path)
const stored = await store.store(Buffer.from('# My Document\n'), uri);
console.log(stored.checksum);  // SHA-256 hex of the content
console.log(stored.byteSize);  // 14

// Register a file that is already on disk (CLI path)
const registered = await store.register('file://docs/overview.md');

// Read content back by URI
const content = await store.retrieve(uri);
console.log(content.toString()); // "# My Document\n"

// Move and remove files
await store.move(uri, 'file://docs/my-document.md');
await store.remove('file://docs/my-document.md');
```

## Working Tree Storage

The working tree (project root) is the source of truth for file content. Resources are identified by their `file://` URI, which is stable across content changes; moves are tracked by events.

```
my-project/                  ← project root
├── .semiont/                ← project config and event log
└── docs/
    └── overview.md          ← storageUri "file://docs/overview.md"
```

There are two write paths:

- **`store(content, storageUri)`** — write bytes to disk. Used when the file does not yet exist and the caller provides content (API/GUI/AI path).
- **`register(storageUri, expectedChecksum?)`** — read an existing file and record its metadata (CLI path). If `expectedChecksum` is provided and does not match, throws `ChecksumMismatchError`.

Both return the same metadata:

```typescript
interface StoredResource {
  storageUri: string;    // file:// URI (e.g. "file://docs/overview.md")
  checksum: string;      // SHA-256 hex of content
  byteSize: number;      // Size in bytes
  created: string;       // ISO 8601 timestamp
}
```

### Git Integration

When the project has `[git] sync = true` in `.semiont/config`, the store keeps the git index up to date automatically:

- `store()` / `register()` queue a `git add`, which is deferred and deduplicated (`flushStaging()` stages what is pending)
- `move()` runs `git mv`
- `remove()` runs `git rm` (or `git rm --cached` with `keepFile: true`)

Every mutating method accepts `{ noGit: true }` to skip staging for a single call. Without git sync, the store falls back to plain filesystem operations.

## PDF Extraction

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
derives is `decodeRepresentation` in [`@semiont/core`](../core/README.md).

A decline is named (`'no-text-layer' | 'encrypted' | 'corrupt' | 'too-large'`)
rather than a bare null, so a caller can settle with the reason.
`'no-text-layer'` means recognition ran and came up empty — not that it was
never attempted.

`extractPdfTextLayer()` is the lower-level reader underneath class A, returning
`null` for a document with no text operators anywhere.

Coordinates are PDF points, origin bottom-left; the Y-flip to canvas pixels
happens in the browser. The vocabulary these produce — `AnchoredText`,
`PdfTextItem` — and the `locate` / `textUnder` pair that reads it are exported
from [`@semiont/core`](../core/README.md), so the browser can reason over
geometry without importing this package's extraction stack.

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

See **[ANCHORING.md](../../docs/architecture/ANCHORING.md)** for the pipeline this
sits in.

## Utilities

```typescript
import {
  calculateChecksum,       // SHA-256 hex of a string or Buffer
  verifyChecksum,          // Compare content against an expected checksum
} from '@semiont/content';
import {
  deriveStorageUri,        // ("My Doc", "text/markdown") → "file://my-doc.md"
} from '@semiont/core';
```

`deriveStorageUri` is [@semiont/core](../core/)'s and takes a
`SupportedMediaType`; the media-type registry — which types are admitted, their
extensions, and their capabilities — lives in core's `media-types.ts`. See
[docs/mime-types.md](./docs/mime-types.md).

## Documentation

- [API Reference](./docs/API.md) - API documentation
- [Architecture](./docs/architecture.md) - Design principles

## Development

```bash
# Install dependencies
npm install

# Build package
npm run build

# Run tests
npm test

# Type checking
npm run typecheck
```

## License

Apache-2.0
