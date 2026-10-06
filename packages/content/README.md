# @semiont/content

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+content%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=content)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=content)
[![npm version](https://img.shields.io/npm/v/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![License](https://img.shields.io/npm/l/@semiont/content.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

A resource's bytes, read from the Archivist, and the text read out of the ones that carry none. It derives text and its geometry from PDFs: the text layer, OCR, tables and forms.

## Who uses it

- **The Librarian, the Smelter and the Worker** hold no store. They read a resource's bytes from the Archivist, through `archivistContentReads()`.
- **The Smelter** derives text, with `derivingExtractorFor` and the anchored-text store.
- **The Worker** reads a PDF's text layer with `extractPdfTextLayer`.

Each of those is wired in [`@semiont/make-meaning`](../make-meaning/README.md) or [`@semiont/jobs`](../jobs/README.md). The working tree itself is the [Archivist](../../docs/protocol/ARCHIVIST.md)'s: it is the only service that mounts it.

**Building an application?** You do not need this package. An application uploads and reads content through [`@semiont/sdk`](../sdk/README.md): `yield.resource` and `browse.resourceContent`.

## What is in it

| | |
|---|---|
| `archivistContentReads`, `ContentReads` | How a service with no mount reads a resource's bytes, and the one way such a read fails (`RepresentationMissing`) |
| `calculateChecksum` | The SHA-256 a resource's content is known by |
| `derivingExtractorFor(mediaType)` | The extractor for a media type whose text has to be derived. For a PDF: text layer, OCR for scanned pages, tables, form values |
| `createAnchoredTextStore` | Where a derived text is kept, by content checksum, so OCR runs once per document |
| `extractPdfTextLayer` | The lower-level reader of a PDF's native text layer |
| `MAX_PDF_BYTES`, `withinByteBudget` | The size the extractor accepts, which is also the bound on what a generation may produce |

## Example

```typescript
import { archivistContentReads, calculateChecksum, derivingExtractorFor } from '@semiont/content';
import { resourceId, type ServiceAccountCredential } from '@semiont/core';
import type { ArchivistAddressConfig } from '@semiont/core/node';

declare const config: ArchivistAddressConfig;
declare const credential: ServiceAccountCredential;

const content = archivistContentReads(config, credential);
const { data, contentType } = await content.getBinary(resourceId('doc-123'));
console.log(contentType, calculateChecksum(Buffer.from(data)));

const extractor = derivingExtractorFor('application/pdf');
```

## What a change must keep

- **One process touches the tree.** Bytes are read from the Archivist by resource id. A service with no Archivist configured fails as it starts, and a missing address is never a reason to read a tree locally.
- **Derived text is a cache, never the record.** Everything in the anchored-text store can be derived again from the source bytes. A read never throws: a stale stamp, a corrupt file and an absent one are all a miss. The store may make extraction faster, and may never make it fail.
- **The writer states its stamp.** The anchored-text store writes the stamp its entries carry to a `STAMP` file in its directory, so the Archivist, which reads the store, can tell a current entry from a stale one.
- **No text is a named answer.** An extraction that gives none says why (`no-text-layer`, `encrypted`, `corrupt`, `too-large`). It never returns a bare null.
- **One byte budget, enforced twice.** `MAX_PDF_BYTES` bounds what the extractor reads and what a generation writes, so Semiont never creates a resource its own extractor would decline.
- **Geometry's vocabulary lives in `@semiont/core`.** `AnchoredText`, `locate` and `textUnder` are there, so the browser can reason over a page without importing this package, which carries pdf.js, Tesseract and `node:fs`.

## Documentation

- [Architecture](docs/architecture.md): why the package is shaped as it is.
- [API reference](docs/API.md): checksums, reading bytes without a mount, deriving text from a PDF, the anchored-text store.
- [Anchoring](../../docs/architecture/ANCHORING.md): the pipeline this package's extraction sits in.

## License

Apache-2.0
