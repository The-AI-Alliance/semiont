# Content Architecture

Why `@semiont/content` is shaped as it is. Each call is in the [API reference](API.md). The pipeline its text extraction belongs to, from bytes to a selector on a page, is [Anchoring](../../../docs/architecture/ANCHORING.md).

## One process touches the tree

In a running stack only the Archivist mounts the knowledge base. Every other service that needs a resource's bytes reads them from the Archivist, through `ContentReads`, which is the transport contract's byte read and nothing more. `archivistContentReads()` is that read over HTTP.

A service with no Archivist configured fails when it starts, not on its first read. A missing address is never a reason to read a tree locally: the point of one mount is that one process touches it.

## Text that has to be derived

Text decodes out of a text file. Out of a PDF it has to be derived, and how depends on what the document holds: a text layer is read directly, a scanned page is recognised by OCR, a table is rewritten as rows, and a form's values are folded in. `derivingExtractorFor` picks by what each page turns out to be.

- **No text is a named answer.** A document that gives none says why: it has no text layer, it is encrypted, it is corrupt, or it is too large.
- **What is derived is kept.** Recognition is slow, and several services read the same document, so an outcome is stored by the checksum of the bytes it came from. That store is a cache: a miss costs time and nothing else, and a read of it never fails.
- **One byte budget.** `MAX_PDF_BYTES` bounds what the extractor will read. The same bound is applied to what a generation writes, so Semiont does not create a resource its own extractor would decline.
- **Geometry is in PDF points**, with the origin at the bottom left. The flip to pixels happens in the browser. The types and the arithmetic that read a page's geometry are [`@semiont/core`](../../core/README.md)'s, so the browser needs none of this package's parsers.

## What it does not do

- **It stores no content.** A resource's files are in the knowledge base's working tree, which the [Archivist](../../../docs/protocol/ARCHIVIST.md#the-working-tree) writes, moves, removes and stages.
- **It serves nothing.** The routes that upload and download content are the Archivist's and the gateway's.
- **It does not decide which media types are admitted.** That registry, and `deriveStorageUri`, which names a file from a resource's name and type, are `@semiont/core`'s.
