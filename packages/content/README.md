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

**Infrastructure Ownership**: In production applications, the working tree store is **created and managed by [@semiont/make-meaning](../make-meaning/)'s `startMakeMeaning()` function**, which serves as the single orchestration point for all infrastructure components. Backend code accesses it as `knowledgeBase.content`.

The quick start example below shows direct instantiation for **testing, CLI tools, or content management scripts**.

## Quick Start

```typescript
import { WorkingTreeStore, deriveStorageUri } from '@semiont/content';
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject('/path/to/project');
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

- `store()` / `register()` run `git add`
- `move()` runs `git mv`
- `remove()` runs `git rm` (or `git rm --cached` with `keepFile: true`)

Every method accepts `{ noGit: true }` to skip staging for a single call. Without git sync, the store falls back to plain filesystem operations.

## PDF Text-Layer Extraction

For native (non-scanned) PDFs, `extractPdfTextLayer()` extracts positioned text using [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist). It returns `null` for scanned/image-only PDFs.

```typescript
import { extractPdfTextLayer, locate } from '@semiont/content';

const layer = await extractPdfTextLayer(pdfBytes);
if (layer) {
  console.log(layer.text);          // Full extracted text
  console.log(layer.pages.length);  // Page dimensions in PDF points

  // Find bounding rectangles for a span of the text (one per line)
  const rects = locate(layer, 120, 178);
  // => PdfCoordinate[] in PDF point space (origin: bottom-left)
}
```

Coordinates are in PDF point space, originating from the bottom-left of the page. The Y-flip to canvas pixels happens downstream in the browser; the server has no canvas. The `PdfCoordinate` geometry type lives in `@semiont/core` alongside the viewrect FragmentSelector codec.

## Utilities

```typescript
import {
  calculateChecksum,       // SHA-256 hex of a string or Buffer
  verifyChecksum,          // Compare content against an expected checksum
  deriveStorageUri,        // ("My Doc", "text/markdown") → "file://my-doc.md"
} from '@semiont/content';
```

`deriveStorageUri` takes a `SupportedMediaType`; the media-type registry —
which types are admitted, their extensions, and their capabilities — lives in
[@semiont/core](../core/)'s `media-types.ts`. See [docs/mime-types.md](./docs/mime-types.md).

## Documentation

- [API Reference](./docs/API.md) - Complete API documentation
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
