# Content API Reference

Each call of `@semiont/content`, with an example. Why the package is shaped as it is, is [Architecture](architecture.md).

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
