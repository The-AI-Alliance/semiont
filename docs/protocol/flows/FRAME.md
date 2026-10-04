# Frame

Frame defines the vocabulary a knowledge base is expressed in: what kinds of things exist. It is one of the four writing verbs, with [Yield](YIELD.md), [Mark](MARK.md) and [Bind](BIND.md). Those three write content. Frame writes the vocabulary that content draws on.

A knowledge base has two vocabularies:

- **Entity types**: the kinds of thing a reference can be about and a resource can be classified as, such as `Person`, `Organization` or `Concept`.
- **Tag schemas**: frameworks for a passage's role in a structure, such as IRAC for legal reasoning or IMRAD for a scientific paper. Each has an id and a list of categories.

Neither is fixed by Semiont. The participants in a knowledge base grow them.

## Operations

| SDK method | Returns | On the wire | Answered by |
|---|---|---|---|
| `frame.addEntityType` | nothing | `frame:add-entity-type` | the archivist |
| `frame.addEntityTypes` | nothing | one `frame:add-entity-type` per type | the archivist |
| `frame.addTagSchema` | nothing | `frame:add-tag-schema` | the archivist |

Reading the vocabularies is [Browse](BROWSE.md): `browse.entityTypes` and `browse.tagSchemas`.

## What it records

| Event | Records | Delivered to |
|---|---|---|
| `frame:entity-type-added` | An entity type joined the vocabulary | everyone |
| `frame:tag-schema-added` | A tag schema was registered, or replaced | everyone |

Both belong to the knowledge base as a whole and to no resource. They are recorded on the log's system stream.

## Rules

**The vocabulary only grows.** There is no operation that removes an entity type or a tag schema.

**Adding an entity type twice is a no-op.** Concurrent adds need no coordination.

**A tag schema is replaced whole, by id.** Registering a schema whose id already exists replaces it. Registering identical content changes nothing.

**There is no batch add on the wire.** `frame.addEntityTypes` sends one request per type. If one is refused, the ones before it have been recorded, and sending the list again is safe.

**A tag schema must be registered before it is used.** A [`mark.assist`](MARK.md#assistance) for `tagging` names a schema by id. The dispatcher resolves the id when it admits the job, and refuses a job that names a schema the knowledge base does not have.

### Tag schemas

A tag schema belongs to the knowledge base that uses it, not to Semiont. A knowledge base registers its own, typically when a skill or script starts:

```typescript
import type { TagSchema } from '@semiont/sdk';

const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue / Rule / Application / Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    { name: 'Issue',       description: 'The legal question to be resolved',  examples: ['What must the court decide?'] },
    { name: 'Rule',        description: 'The relevant law or legal principle', examples: ['What law applies?'] },
    { name: 'Application', description: 'How the rule applies to the facts',  examples: ['How does the law apply here?'] },
    { name: 'Conclusion',  description: 'The resolution',                       examples: ['What is the holding?'] },
  ],
};

await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);
```

## Example

```typescript
await semiont.frame.addEntityType('Person');
await semiont.frame.addEntityTypes(['Location', 'Organization', 'Event']);
```

From the launcher: `semiont frame --entity-type Person --entity-type Organization`, and `semiont browse --entity-types` to read them back.

## Where it is implemented

- The SDK namespace: [packages/sdk/src/namespaces/frame.ts](../../../packages/sdk/src/namespaces/frame.ts)
- What records the events: the Stower, in [packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts)
- How the two vocabularies are projected and read: [the projection pattern](../../architecture/PROJECTION-PATTERN.md)
- Where the dispatcher resolves a schema id: [apps/dispatcher/handlers/src/admission.rs](../../../apps/dispatcher/handlers/src/admission.rs)
- The entity types a new knowledge base starts with: [packages/ontology/src/entity-types.ts](../../../packages/ontology/src/entity-types.ts)
- The launcher verb: [apps/launcher/internal/verbs/frame.go](../../../apps/launcher/internal/verbs/frame.go)
- The channels and their payloads: [specs/src/bus/registry.json](../../../specs/src/bus/registry.json)
