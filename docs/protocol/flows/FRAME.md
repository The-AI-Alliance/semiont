# Frame Flow

**Purpose**: Define and evolve the KB's **schema layer** — the conceptual vocabulary the other seven flows are expressed in. Where yield/mark/match/bind/gather/browse/beckon act on content (resources, annotations, references, attention), Frame acts on what *kinds* of things exist: entity types and tag schemas today, eventually relation/predicate types and ontology imports.

**Related Documentation**:
- [Mark Flow](./MARK.md) - Annotation CRUD operates within the entity-type vocabulary Frame defines, and `mark.assist(rid, 'tagging', ...)` resolves `schemaId` against the per-KB tag-schema registry Frame writes to
- [Browse Flow](./BROWSE.md) - `browse.entityTypes()` and `browse.tagSchemas()` are the live reads of the two vocabularies Frame writes to
- [Knowledge System](../../system/KNOWLEDGE-SYSTEM.md) - Event store and the `frame:*` channels

## Overview

Frame is the schema-layer flow — the eighth flow alongside yield, mark, match, bind, gather, browse, and beckon. It owns the conceptual vocabulary the KB's content is expressed in.

The mental model: when a participant joins a KB, the *content* (resources, annotations) is what they see; the *frame* is what they implicitly use to make sense of that content — what types of entities exist (Person, Organization, Concept, ...), what taxonomies are available (a "biological domain" schema with categories Biology / Chemistry / ...), what kinds of relations the KB recognizes. Mark and the other content flows consume the frame; Frame methods evolve it.

Schema-layer changes fan out across participants the same way content changes do: when one participant adds an entity type, others see it through `browse.entityTypes()` on their next live-read. The vocabulary is grow-only at MVP — there's no protocol-level "remove entity type" event, and AI-assisted detection workflows (`mark.assist(...)` with motivation `linking`) consume the current set without caring how it grew.

## Scope

Frame owns two structural primitives today: **entity-type vocabulary** and **tag-schema registration**. Both are write-side operations on the schema layer — live reads stay on Browse (`browse.entityTypes()`, `browse.tagSchemas()`). Future scope (relation/predicate types, ontology import, schema validation rules — see [Future scope](#future-scope) below) will accrete onto the same namespace as backend support arrives.

The split between writes (Frame) and live reads (Browse) is intentional. Browse is the live-read everything namespace — it owns cache primitives, live-query semantics, and hook-stable observables. Re-implementing those primitives on Frame for a single read would duplicate machinery without benefit. Writes to the schema layer belong on Frame; observation belongs on Browse.

## Entity types

Add an entity type to the KB's vocabulary. The `frame` namespace emits `frame:add-entity-type` on the bus gateway — the backend Stower handler persists the addition and the change becomes visible to other participants through `browse.entityTypes()`.

```typescript
// Add a single entity type
await client.frame.addEntityType('Person');

// Add multiple in one call
await client.frame.addEntityTypes(['Organization', 'Location', 'Event']);

// Live-read the current vocabulary (lives on Browse, not Frame)
client.browse.entityTypes().subscribe((types) => {
  console.log('Current vocabulary:', types);
});
```

Adding the same entity type twice is idempotent — the backend dedupes; the second `frame:add-entity-type` for an existing tag is a no-op. No SDK-level coordination is needed for concurrent adds across participants.

## Tag schemas

Tag schemas are structural-analysis frameworks (IRAC for legal reasoning, IMRAD for scientific papers, Toulmin for argumentation, custom domain schemas). They're **per-KB runtime-registered** — schema *data* lives with the knowledge base that owns it (typically a `src/tag-schemas.ts` module in the KB repo); the SDK ships only the `TagSchema` and `TagCategory` *types* (from `@semiont/core`).

The registration round-trip:

1. Caller invokes `client.frame.addTagSchema(schema)` — emits `frame:add-tag-schema` on the bus.
2. Stower's [`handleAddTagSchema`](../../../packages/make-meaning/src/stower.ts) appends a `frame:tag-schema-added` domain event to the `__system__` event stream.
3. The [ViewMaterializer](../../../packages/event-sourcing/src/views/view-materializer.ts) writes the schema to `{stateDir}/projections/__system__/tagschemas.json` (via `materializeTagSchemas`). Most-recent-wins by `schema.id`: identical re-registrations are silent; differing content overwrites and logs a warning.
4. The bridged `frame:tag-schema-added` event reaches every connected participant; their `browse.tagSchemas()` cache invalidates and re-emits with the new schema.

```typescript
import type { TagSchema } from '@semiont/sdk';

const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue / Rule / Application / Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    { name: 'Issue',       description: 'The legal question to be resolved',    examples: ['What must the court decide?'] },
    { name: 'Rule',        description: 'The relevant law or principle',         examples: ['What law applies?'] },
    { name: 'Application', description: 'How the rule applies to the facts',     examples: ['How does the law apply here?'] },
    { name: 'Conclusion',  description: 'The resolution',                         examples: ['What is the holding?'] },
  ],
};

// Register the schema — typically at skill startup. Idempotent.
await client.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

// Now mark.assist with motivation 'tagging' can use it. The dispatcher
// resolves schemaId → TagSchema via the projection at job-creation time
// and embeds the full schema in worker params, so the worker is
// independent of the registry.
await client.mark.assist(rid, 'tagging', {
  schemaId: LEGAL_IRAC_SCHEMA.id,
  categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
});

// Live-read the registered schemas (lives on Browse, not Frame). The
// cache invalidates on `frame:tag-schema-added` so it stays current.
client.browse.tagSchemas().subscribe((schemas) => {
  console.log('Registered schemas:', schemas.map((s) => s.id));
});
```

If `mark.assist` is called with a `schemaId` that isn't in the projection, the dispatcher rejects synchronously with `Tag schema not registered: <id>` — there is no build-time fallback. KBs that ship demo skills typically include a `register-tag-schemas` bootstrap skill plus per-skill self-registration so first-time users see the schemas without needing to run a separate command. Schema-evolution concerns (rename / remove / version / migrate annotation bodies under a renamed category) are deferred — see [`.plans/EVOLVE-TAG-SCHEMA.md`](../../../.plans/EVOLVE-TAG-SCHEMA.md).

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `frame:add-entity-type` | `{ tag: string }` | Add an entity type to the KB's vocabulary. Frame's command channel; the verb namespace and the wire-level channel agree on the prefix. |
| `frame:entity-type-added` | `{ payload: { entityType: string }, ... }` (StoredEvent) | Emitted by Stower after persistence. The entity-type-projection materializer updates the system view; subscribers to `browse.entityTypes()` see the new tag on their next emit. System-level event (no `resourceId`) — fan-out is global. |
| `frame:add-tag-schema` | `{ schema: TagSchema }` | Register a tag schema with the KB's runtime registry. Most-recent-wins by `schema.id`. |
| `frame:tag-schema-added` | `{ payload: { schema: TagSchema }, ... }` (StoredEvent) | Emitted by Stower after persistence. The tag-schemas-projection materializer updates `tagschemas.json`; subscribers to `browse.tagSchemas()` see the registration on their next emit. Bridged channel — fan-out is global. |

## Migrating from earlier channel names

Frame's wire channels were renamed from `mark:*` to `frame:*` when Frame was promoted to flow status. KBs created before the rename have event logs containing `"type": "mark:entity-type-added"` records under `__system__.jsonl`; the migration script at [`scripts/migrate-event-types.ts`](../../../scripts/migrate-event-types.ts) rewrites these in place to the new names. The SDK and backend reject the old channel names — there is no fallback shim — so any pre-rename event log must be migrated before the runtime can read it.

## Future scope

Frame is sized to grow. As the KB's schema layer matures, the namespace can absorb:

- **Schema evolution** — `frame.removeTagSchema(id)`, `frame.renameCategory(id, oldName, newName)`, optional schema-id versioning (`legal-irac@v1`). Today the registry is grow-only with most-recent-wins overwrites; rename / remove / version are deferred and tracked in [`.plans/EVOLVE-TAG-SCHEMA.md`](../../../.plans/EVOLVE-TAG-SCHEMA.md).
- **Relation / predicate types** — when the KB grows a typed-relation system on top of W3C annotations (today references are untyped except for entity-type tagging), Frame is where `frame.addRelationType` lives.
- **Ontology import / export** — bulk schema operations, OWL/RDF round-trip if the system supports them. `frame.importOntology(file)`, `frame.exportOntology()`.
- **Schema validation rules** — assertions about which entity types can co-occur, required fields, etc.

The design point: Frame's namespace home gives these features a place to grow that isn't on Mark, isn't on Browse, and doesn't require inventing a new namespace each time a schema-layer concern appears.

## Implementation

- **Namespace**: [packages/sdk/src/namespaces/frame.ts](../../../packages/sdk/src/namespaces/frame.ts)
- **Interface**: [packages/sdk/src/namespaces/types.ts](../../../packages/sdk/src/namespaces/types.ts) — `FrameNamespace`
- **Tests**: [packages/sdk/src/namespaces/__tests__/frame.test.ts](../../../packages/sdk/src/namespaces/__tests__/frame.test.ts), [packages/make-meaning/src/__tests__/handlers/job-commands.test.ts](../../../packages/make-meaning/src/__tests__/handlers/job-commands.test.ts) (dispatcher schema resolution), [packages/make-meaning/src/__tests__/views/tag-schemas-reader.test.ts](../../../packages/make-meaning/src/__tests__/views/tag-schemas-reader.test.ts), [tests/e2e/specs/11-frame-tag-schemas.spec.ts](../../../tests/e2e/specs/11-frame-tag-schemas.spec.ts) (end-to-end registration + tagging round-trip)
- **Event channels**: [packages/core/src/bus-protocol.ts](../../../packages/core/src/bus-protocol.ts) — `frame:add-entity-type`, `frame:entity-type-added`, `frame:add-tag-schema`, `frame:tag-schema-added`
- **Bridged channels**: [packages/core/src/bridged-channels.ts](../../../packages/core/src/bridged-channels.ts) — `frame:entity-type-added` and `frame:tag-schema-added` fan out via SSE to all participants
- **Backend handler**: [packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts) — `handleAddEntityType` and `handleAddTagSchema` append the corresponding domain events
- **Materializers**: [packages/event-sourcing/src/views/view-materializer.ts](../../../packages/event-sourcing/src/views/view-materializer.ts) — `materializeEntityTypes` writes `entitytypes.json`; `materializeTagSchemas` writes `tagschemas.json` with most-recent-wins + warning semantics
- **Projection readers**: [packages/make-meaning/src/views/entity-types-reader.ts](../../../packages/make-meaning/src/views/entity-types-reader.ts), [packages/make-meaning/src/views/tag-schemas-reader.ts](../../../packages/make-meaning/src/views/tag-schemas-reader.ts)
- **Dispatcher resolution**: [packages/make-meaning/src/handlers/job-commands.ts](../../../packages/make-meaning/src/handlers/job-commands.ts) — for `tag-annotation` jobs, resolves caller-supplied `schemaId` against the projection and embeds the full `TagSchema` in worker params
- **Entity-type defaults**: [packages/ontology/src/entity-types.ts](../../../packages/ontology/src/entity-types.ts) — `DEFAULT_ENTITY_TYPES` (the seed values used to bootstrap a fresh KB; per-KB additions come through Frame)
- **Tag-schema data**: lives with the KB that owns it (e.g. `semiont-caselaw-kb/src/tag-schemas.ts`). The semiont monorepo ships only the `TagSchema`/`TagCategory` types from `@semiont/core`
