# @semiont/content

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+content%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=content)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=content)
[![npm version](https://img.shields.io/npm/v/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![License](https://img.shields.io/npm/l/@semiont/content.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The files of a knowledge base, and the text read out of the ones that carry none. It stores a resource's bytes in the knowledge base's working tree, keeps git's index in step, and derives text and its geometry from PDFs: the text layer, OCR, tables and forms.

## Who uses it

- **The Archivist** holds the one `WorkingTreeStore`. It is the only service that mounts the knowledge base's working tree.
- **The Smelter** derives text, with `derivingExtractorFor` and the anchored-text store.
- **The Librarian, the Smelter and the Worker** hold no store. They read a resource's bytes from the Archivist, through `archivistContentReads()`.
- **[`@semiont/event-sourcing`](../event-sourcing/README.md)** stages the event log with `createStager`, since the log lives in the same working tree.

Each of those is wired in [`@semiont/make-meaning`](../make-meaning/README.md) or [`@semiont/jobs`](../jobs/README.md). `startMakeMeaning()` builds the same store in one process, for scripts and tests.

**Building an application?** You do not need this package. An application uploads and reads content through [`@semiont/sdk`](../sdk/README.md): `yield.resource` and `browse.resourceContent`.

## What is in it

| | |
|---|---|
| `WorkingTreeStore` | Bytes in the working tree, by `file://` URI: `store`, `register` (a file already on disk), `retrieve`, `move`, `remove` |
| `createStager` | Deferred, deduplicated `git add`, run off the event loop |
| `calculateChecksum`, `verifyChecksum` | The SHA-256 a resource's content is known by |
| `archivistContentReads`, `ContentReads` | How a service with no mount reads a resource's bytes, and the one way such a read fails (`RepresentationMissing`) |
| `derivingExtractorFor(mediaType)` | The extractor for a media type whose text has to be derived. For a PDF: text layer, OCR for scanned pages, tables, form values |
| `createAnchoredTextStore` | Where a derived text is kept, by content checksum, so OCR runs once per document |
| `extractPdfTextLayer` | The lower-level reader of a PDF's native text layer |
| `MAX_PDF_BYTES`, `withinByteBudget` | The size the extractor accepts, which is also the bound on what a generation may produce |

## Example

```typescript
import { WorkingTreeStore } from '@semiont/content';
import { deriveStorageUri } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';

const project = new SemiontProject('/path/to/knowledge-base', {
  anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
});
const store = new WorkingTreeStore(project);

const uri = deriveStorageUri('My Document', 'text/markdown');   // "file://my-document.md"
const stored = await store.store(Buffer.from('# My Document\n'), uri);
console.log(stored.checksum, stored.byteSize);

const bytes = await store.retrieve(uri);
await store.move(uri, 'file://docs/my-document.md');
```

## What a change must keep

- **The working tree is the record of content.** A resource is named by its `file://` URI, which does not change when its content does. A move is recorded as an event.
- **The store keeps git's index.** With `[git] sync = true` in `.semiont/config`, every write is staged, a move is `git mv` and a removal is `git rm`. `{ noGit: true }` skips it for one call.
- **Derived text is a cache, never the record.** Everything in the anchored-text store can be derived again from the source bytes. A read never throws: a stale stamp, a corrupt file and an absent one are all a miss. The store may make extraction faster, and may never make it fail.
- **No text is a named answer.** An extraction that gives none says why (`no-text-layer`, `encrypted`, `corrupt`, `too-large`). It never returns a bare null.
- **One byte budget, enforced twice.** `MAX_PDF_BYTES` bounds what the extractor reads and what a generation writes, so Semiont never creates a resource its own extractor would decline.
- **Geometry's vocabulary lives in `@semiont/core`.** `AnchoredText`, `locate` and `textUnder` are there, so the browser can reason over a page without importing this package, which carries pdf.js, Tesseract and `node:fs`.

## Documentation

- [API reference](docs/API.md): the store, checksums, deriving text from a PDF, the anchored-text store.
- [Architecture](docs/architecture.md): the design principles.
- [Media types](docs/mime-types.md): which types are admitted, and where that is decided.
- [Anchoring](../../docs/architecture/ANCHORING.md): the pipeline this package's extraction sits in.

## License

Apache-2.0
