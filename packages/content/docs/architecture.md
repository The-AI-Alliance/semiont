# Content Architecture

Why `@semiont/content` is shaped as it is. Each call is in the [API reference](API.md). The pipeline its text extraction belongs to, from bytes to a selector on a page, is [Anchoring](../../../docs/architecture/ANCHORING.md).

## The working tree is the record of content

A resource's content is an ordinary file at an ordinary path in the knowledge base's working tree, readable with ordinary tools. The store does not copy bytes into a directory of its own. It reads and writes the files a person sees.

```
my-knowledge-base/           ← the working tree
├── .semiont/                ← configuration, and the event log
└── docs/
    └── overview.md          ← "file://docs/overview.md"
```

## Named by URI, checked by checksum

A resource's content is named by its `file://` URI, which stays the same when the content changes. A move is explicit (`move()`) and recorded as an event; it is never inferred. The SHA-256 of the content is taken on every write, and is what tells that a file on disk is still the one that was recorded.

## Two ways bytes arrive

The store separates the two by who has the bytes:

- **`store(content, storageUri)`** writes them. The Archivist's upload path calls it, with the bytes a client sent.
- **`register(storageUri, expectedChecksum?)`** reads a file that is already there and answers what it found. The Stower calls it when it records a resource, with the checksum the command carried, and a file that does not match is refused (`ChecksumMismatchError`).

Both answer the same `StoredResource`, so what is recorded does not depend on how the bytes came.

## The store keeps git's index

With `[git] sync = true` in `.semiont/config`, the store stages what it registers, moves and removes. The index is for people who commit by hand, so it has to be current within seconds, not after every change.

Staging goes through one interface, `Staging`, with two drivers: git, and none for a project that does not sync git. `stagingFor(project)` gives the one driver for a repository, shared by the content store and the event log. The git driver defers `git add`, drops repeats of a path that is already pending, and runs one command at a time, because git's index has one writer. A move or a removal waits for the adds queued before it.

The driver moves or deletes the file itself, and then tells git. A file operation therefore happens or throws, whatever git knows of the file; only the staging is best-effort.

A knowledge base need not be a git repository: without `[git] sync = true` it runs no git at all, and reports no branch. What is refused is the contradiction. A config that says `sync = true` over a tree that is not a git checkout stops the Archivist at boot (`Staging.ready()`), naming the tree and the two ways out. Past boot the driver pays for no check. If git stops working while the Archivist runs, the record is unaffected. Staging an adopted file or an appended event is queued behind the operation, so the operation succeeds, and the batch that fails is logged as an error (`Staging degraded`) and counted (`semiont.git.staging.failures`) for the operator. A move or a removal tells git itself: it moves or deletes the file and then reports that it could not be staged. Staging resumes as soon as git works again.

`store` stages nothing. Uploaded bytes are staged by `register`, when the event that names them applies. Whether a project stages is its `[git] sync` setting, never one call's choice.

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

- **It records nothing.** That a resource was created, moved or removed is the event log's to say. The store answers what it wrote, and the caller records it.
- **It serves nothing.** The routes that upload and download content are the Archivist's and the gateway's.
- **It does not decide which media types are admitted.** That registry, and `deriveStorageUri`, which names a file from a resource's name and type, are `@semiont/core`'s.
