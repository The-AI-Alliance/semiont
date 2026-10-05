# @semiont/event-sourcing

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+event-sourcing%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=event-sourcing)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=event-sourcing)
[![npm version](https://img.shields.io/npm/v/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/event-sourcing.svg)](https://www.npmjs.com/package/@semiont/event-sourcing)
[![License](https://img.shields.io/npm/l/@semiont/event-sourcing.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The record of a knowledge base, and the views read from it. Every change is an event appended to a log in the knowledge base's working tree. Views of the current state are materialized from that log, and can always be made from it again.

## Who uses it

- **The Archivist** holds the one event store, built in [`@semiont/make-meaning`](../make-meaning/README.md). Its Stower is the only writer, and its Browser reads events and views to answer `browse` requests.
- **[`@semiont/jobs`](../jobs/README.md)** uses `annotationIdFor`, so that the same annotation made twice has one id.

**Building an application?** You do not need this package. An application reads a resource's history through [`@semiont/sdk`](../sdk/README.md) (`browse.events`), and writes by using the verbs.

## What is in it

| | |
|---|---|
| `createEventStore(project, eventBus, logger)` | The store of a knowledge base: its log, its views, and the bus it publishes on |
| `EventStore.appendEvent` | The one way an event is written |
| `EventLog`, `EventStorage` | The log: JSONL files under `.semiont/events/`, one stream per resource, and `__system__` for what belongs to the knowledge base as a whole |
| `EventQuery` | Reading events, with filters |
| `ViewManager`, `ViewMaterializer` | The views: a resource's description and its annotations, and the system views (entity types, tag schemas, people) |
| `applyEntityTypeAdded`, `applyTagSchemaAdded`, `applyPersonProfiled` | The system views' rules, as pure functions |
| `FilesystemViewStorage`, and the storage-uri index | Where views are kept, and which resource a file in the working tree is |
| `annotationIdFor` | An annotation's id, from what makes it that annotation |

## Example

```typescript
import { createEventStore, EventQuery } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, resourceId, userId, type Logger } from '@semiont/core';

declare const logger: Logger;

const project = new SemiontProject('/path/to/knowledge-base', {
  anchoredTextDir: process.env.SEMIONT_ANCHORED_TEXT_DIR!,
});
const eventStore = createEventStore(project, new EventBus(), logger);

// Appended to the log, then materialized into the views, then published.
const stored = await eventStore.appendEvent({
  type: 'mark:archived',
  resourceId: resourceId('doc-123'),
  userId: userId('did:web:example.org:users:alice'),
  version: 1,
  payload: {},
});
console.log(stored.metadata.sequenceNumber);

const history = await new EventQuery(eventStore.log.storage).getResourceEvents(resourceId('doc-123'));
```

## What a change must keep

- **The log is the record.** It is append-only, it lives in the knowledge base's working tree, and git gives it its history and its integrity. An event carries no hash of the one before it.
- **One write path, in one order.** `appendEvent` persists, then materializes the views, then publishes. A subscriber that hears an event can read a view that already includes it.
- **Views are disposable.** They live outside the working tree, and deleting them loses nothing: `rebuildAll` makes them again from the log when a process starts. Replaying events 1 to N gives the state that living through them gave, because both paths run the same code.
- **A view's rules are pure functions.** What the system views do with a repeat, an overwrite or an ordering is decided in the reducers, and tested without a filesystem. [The projection pattern](../../docs/architecture/PROJECTION-PATTERN.md) says how to add one.
- **A correlation id is not recorded.** It rides the bus envelope of the publish, so a caller can match the event to the command that caused it. It is never written to the log.
- **The event catalogue is not here.** What events exist, and each one's payload, is [`@semiont/core`](../core/README.md)'s `PersistedEvent`, generated from the bus registry.

## Documentation

- [API reference](docs/API.md): the store, the log, queries, and how views are materialized and rebuilt.
- [Storage layout](docs/STORAGE-LAYOUT.md): where each file is.
- [The projection pattern](../../docs/architecture/PROJECTION-PATTERN.md): the views' design, and its rules.

## License

Apache-2.0
