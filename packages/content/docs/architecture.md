# Content Architecture

Why `@semiont/content` is shaped as it is. Each call is in the [API reference](API.md).

## One process touches the tree

In a running stack only the Archivist mounts the knowledge base. Every other service that needs a resource's bytes reads them from the Archivist, through `ContentReads`, which is the transport contract's byte read and nothing more. `archivistContentReads()` is that read over HTTP.

A service with no Archivist configured fails when it starts, not on its first read. A missing address is never a reason to read a tree locally: the point of one mount is that one process touches it.

## What it does not do

- **It stores no content.** A resource's files are in the knowledge base's working tree, which the [Archivist](../../../docs/protocol/ARCHIVIST.md#the-working-tree) writes, moves, removes and stages.
- **It serves nothing.** The routes that upload and download content are the Archivist's and the gateway's.
- **It derives no text.** The text of a PDF, and where each run of it is on a page, is derived and kept by the [Smelter](../../../docs/protocol/SMELTER.md). The types and the arithmetic that read a page's geometry are [`@semiont/core`](../../core/README.md)'s.
- **It does not decide which media types are admitted.** That registry, and `deriveStorageUri`, which names a file from a resource's name and type, are `@semiont/core`'s.
