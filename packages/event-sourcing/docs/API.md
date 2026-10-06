# Event Sourcing API Reference

## Reading a view

A resource's view is the file the Archivist keeps at `<resourcesDir>/<ab>/<cd>/<resourceId>.json`, where `ab/cd` is the resource id's shard (`getShardPath` in `@semiont/core`). It holds what the resource's events add up to.

```typescript
import { FilesystemViewStorage, type ResourceView, type ViewStorage } from '@semiont/event-sourcing';
import { SemiontState } from '@semiont/core/node';
import { resourceId, type Logger } from '@semiont/core';

declare const logger: Logger;

const state = new SemiontState({ name: 'my-knowledge-base' });
const views: ViewStorage = new FilesystemViewStorage(state, logger /* optional */);

const view: ResourceView | null = await views.get(resourceId('doc-123'));
```

The constructor takes anything with a `resourcesDir`. `SemiontState` resolves one from a knowledge base's name; a test passes a temporary directory.

`get` answers:

- the view, when its file is there;
- `null`, when there is no file;
- `null`, when the file does not parse. The store logs it as corrupted. The Archivist's next write of that view replaces the file.

It throws a `TypeError` for a string that is not a `ResourceId`, and rethrows any other read error.

### ResourceView

`ResourceView` is the spec's schema of that name, generated into `@semiont/core`:

| Field | |
|---|---|
| `resource` | The `ResourceDescriptor` |
| `annotations` | `{ resourceId, annotations, version, updatedAt }` |
| `lastSequence` | The sequence number of the last event applied. A graph read that follows a write waits for the graph projection to reach it |

How each event changes a view is in [the Archivist's protocol](../../../docs/protocol/ARCHIVIST.md#how-each-event-changes-the-views).

## Annotation ids

```typescript
import { annotationIdFor } from '@semiont/event-sourcing';

const id = annotationIdFor({
  resourceId: 'doc-123',
  motivation: 'commenting',
  anchor: '0:5:Hello',
  body: { type: 'TextualBody', value: 'A greeting', purpose: 'commenting' },
});
```

The id is 21 base64url characters of the SHA-256 of the canonical JSON of those four inputs. Object keys are sorted at every depth and array order is kept. `body` is hashed whenever there is one, so two comments on one span are two annotations.

`anchor` is a string the caller renders from the span. The guarantee that making an annotation again gives the same id holds as far as that string is stable.

## Event types

The events a knowledge base records are [`@semiont/core`](../../core/README.md)'s `PersistedEvent` catalogue, generated from the bus registry. `PERSISTED_EVENT_TYPES` is the list at run time.
