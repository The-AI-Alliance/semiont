# @semiont/event-sourcing

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+event-sourcing%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=event-sourcing)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=event-sourcing)
[![npm version](https://img.shields.io/npm/v/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![License](https://img.shields.io/npm/l/@semiont/event-sourcing.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

What a reader of a knowledge base's record needs: the materialized view of a resource.

The record itself is the [Archivist](../../docs/protocol/ARCHIVIST.md)'s. It appends every change to an event log in the knowledge base's working tree and materializes a view of each resource's current state. This package reads those views; it writes nothing.

## Who uses it

- **The Librarian**, in [`@semiont/make-meaning`](../make-meaning/README.md), reads views with `FilesystemViewStorage` from the state tree the Archivist writes.

**Building an application?** You do not need this package. An application reads a resource through [`@semiont/sdk`](../sdk/README.md) (`browse.resource`, `browse.events`), and writes by using the verbs.

## What is in it

| | |
|---|---|
| `FilesystemViewStorage` | Reads a resource's view from `<resourcesDir>/<ab>/<cd>/<resourceId>.json` |
| `ViewStorage` | The read it implements: `get(resourceId)` |
| `ResourceView` | A view: the resource's descriptor, its annotations, and the sequence of the last event applied. The spec's `ResourceView` |

## Example

```typescript
import { FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontState } from '@semiont/core/node';
import { resourceId } from '@semiont/core';

const state = new SemiontState({ name: 'my-knowledge-base' });
const views = new FilesystemViewStorage(state);

const view = await views.get(resourceId('doc-123'));
if (view) {
  console.log(view.resource.name, view.annotations.annotations.length, view.lastSequence);
}
```

## What a change must keep

- **It only reads.** The Archivist is the one writer of the views. It renames whole files into place, so a reader sees a whole view or none.
- **A missing view is `null`.** So is a file that does not parse, which is logged. Anything else throws.
- **An id becomes a file name only after it is checked.** `get` refuses a string that is not a `ResourceId`, so `..` never reaches the path.
- **The view's shape is the spec's.** `ResourceView` is generated from the schema the Archivist writes to, in [`@semiont/core`](../core/README.md).

## Documentation

- [API reference](docs/API.md): reading a view.
- [The Archivist](../../docs/protocol/ARCHIVIST.md): where each file of the record is, and how each event changes the views.

## License

Apache-2.0
