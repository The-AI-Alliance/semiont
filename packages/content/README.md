# @semiont/content

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+content%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=content)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=content)
[![npm version](https://img.shields.io/npm/v/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![License](https://img.shields.io/npm/l/@semiont/content.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

A resource's bytes, read from the Archivist.

## Who uses it

- **The Librarian** holds no store. It reads a resource's bytes from the Archivist, through `archivistContentReads()`. The Worker holds none either, and reads bytes on the gateway by its client's own call.

The Librarian is wired in [`@semiont/make-meaning`](../make-meaning/README.md). The working tree itself is the [Archivist](../../docs/protocol/ARCHIVIST.md)'s: it is the only service that mounts it. The text of a PDF is derived by the [Smelter](../../docs/protocol/SMELTER.md), and nothing here derives any.

**Building an application?** You do not need this package. An application uploads and reads content through [`@semiont/sdk`](../sdk/README.md): `yield.resource` and `browse.resourceContent`.

## What is in it

| | |
|---|---|
| `archivistContentReads`, `ContentReads` | How a service with no mount reads a resource's bytes, and the one way such a read fails (`RepresentationMissing`) |

## Example

```typescript
import { archivistContentReads } from '@semiont/content';
import { resourceId, type ServiceAccountCredential } from '@semiont/core';
import type { ArchivistAddressConfig } from '@semiont/core/node';

declare const config: ArchivistAddressConfig;
declare const credential: ServiceAccountCredential;

const content = archivistContentReads(config, credential);
const { data, contentType } = await content.getBinary(resourceId('doc-123'));
console.log(contentType, data.byteLength);
```

## What a change must keep

- **One process touches the tree.** Bytes are read from the Archivist by resource id. A service with no Archivist configured fails as it starts, and a missing address is never a reason to read a tree locally.
- **A miss says which half failed.** A read of a resource the Archivist does not have, or of one whose bytes it does not hold, throws `RepresentationMissing`, whose `reason` is the `code` the Archivist answered. A 404 that states no such code is an error, and never a miss.
- **No token is held for the life of the process.** The Archivist's address is found once, when the reads are made. Each read resolves its token, which the service account keeps until shortly before it expires.

## Documentation

- [Architecture](docs/architecture.md): why the package is shaped as it is.
- [API reference](docs/API.md): reading bytes without a mount.

## License

Apache-2.0
