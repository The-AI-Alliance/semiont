# Frame Flow

**Purpose**: Define and evolve the KB's **schema layer** — the conceptual vocabulary the other seven flows are expressed in. Where yield/mark/match/bind/gather/browse/beckon act on content (resources, annotations, references, attention), Frame acts on what *kinds* of things exist: entity types today, eventually tag schemas, relation/predicate types, and ontology imports.

**Related Documentation**:
- [Mark Flow](./MARK.md) - Annotation CRUD operates within the entity-type vocabulary Frame defines
- [Browse Flow](./BROWSE.md) - `browse.entityTypes()` is the live read of the vocabulary Frame writes to
- [Knowledge System](../../system/KNOWLEDGE-SYSTEM.md) - Event store and the `mark:add-entity-type` channel

## Overview

Frame is the schema-layer flow — the eighth flow alongside yield, mark, match, bind, gather, browse, and beckon. It owns the conceptual vocabulary the KB's content is expressed in.

The mental model: when a participant joins a KB, the *content* (resources, annotations) is what they see; the *frame* is what they implicitly use to make sense of that content — what types of entities exist (Person, Organization, Concept, ...), what taxonomies are available (a "biological domain" schema with categories Biology / Chemistry / ...), what kinds of relations the KB recognizes. Mark and the other content flows consume the frame; Frame methods evolve it.

Schema-layer changes fan out across participants the same way content changes do: when one participant adds an entity type, others see it through `browse.entityTypes()` on their next live-read. The vocabulary is grow-only at MVP — there's no protocol-level "remove entity type" event, and AI-assisted detection workflows (`mark.assist(...)` with motivation `linking`) consume the current set without caring how it grew.

## MVP scope

Frame's MVP owns one structural primitive: entity-type vocabulary writes. That is intentionally small. Future Frame methods (sketched in [Future scope](#future-scope) below) extend this to tag schemas, relation/predicate types, and ontology import — but those wait for backend support. Frame as a flow is sized for growth; the conceptual home is established now so future schema-layer methods accrete onto a properly-framed flow rather than struggling to escape "schema-namespace" labeling later.

The split between writes (Frame) and live reads (Browse) is intentional. Browse is the live-read everything namespace — it owns cache primitives, live-query semantics, and hook-stable observables. Re-implementing those primitives on Frame for a single entity-type read would duplicate machinery without benefit. Writes to the schema layer belong on Frame; observation belongs on Browse.

## Using the API Client

Add an entity type to the KB's vocabulary. The `frame` namespace emits `mark:add-entity-type` on the bus gateway — the backend Stower handler persists the addition and the change becomes visible to other participants through `browse.entityTypes()`.

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

Adding the same entity type twice is idempotent — the backend dedupes; the second `mark:add-entity-type` for an existing tag is a no-op. No SDK-level coordination is needed for concurrent adds across participants.

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `mark:add-entity-type` | `{ tag: string }` | Add an entity type to the KB's vocabulary. Channel name preserved for backend stability — see [Channel naming](#channel-naming) below. |
| `mark:entity-type-added` | `{ payload: { entityType: string }, ... }` (StoredEvent) | Emitted by Stower after persistence. The entity-type-projection materializer updates the system view; subscribers to `browse.entityTypes()` see the new tag on their next emit. |

## Channel naming

The bus channel is named `mark:add-entity-type`, not `frame:add-entity-type`. The naming predates Frame's promotion to flow status; renaming the channel is a backend-and-protocol change with broader implications (event-store reads, downstream consumers) and is deferred. The SDK presents a clean `frame.X` surface without forcing the backend channel-name churn — the verb namespace and the wire-level channel are independent vocabularies, and the asymmetry is documented here so a reader of this doc isn't surprised by the `mark:` prefix in the events table.

If channel-rename becomes worthwhile (e.g. when more `frame:*` events accrete and the `mark:` prefix becomes obviously wrong), it's a separate plan with event-log migration concerns — not something to bundle into a flow definition.

## Future scope

Frame is sized to grow. As the KB's schema layer matures, the namespace can absorb:

- **Tag schemas** — taxonomies used by `mark.assist` for tagging-motivation work (the `schemaId` / `categories` parameters today). Tag schemas live as static data in `@semiont/ontology` until backend CRUD endpoints exist; when they do, `frame.addTagSchema(schema)` and a live `frame.tagSchemas()` slot in.
- **Relation / predicate types** — when the KB grows a typed-relation system on top of W3C annotations (today references are untyped except for entity-type tagging), Frame is where `frame.addRelationType` lives.
- **Ontology import / export** — bulk schema operations, OWL/RDF round-trip if the system supports them. `frame.importOntology(file)`, `frame.exportOntology()`.
- **Schema validation rules** — assertions about which entity types can co-occur, required fields, etc.

None of this is MVP. The design point is: Frame's namespace home gives these features a place to grow that isn't on Mark, isn't on Browse, and doesn't require inventing a new namespace each time a schema-layer concern appears.

## Implementation

- **Namespace**: [packages/sdk/src/namespaces/frame.ts](../../../packages/sdk/src/namespaces/frame.ts)
- **Interface**: [packages/sdk/src/namespaces/types.ts](../../../packages/sdk/src/namespaces/types.ts) — `FrameNamespace`
- **Tests**: [packages/sdk/src/namespaces/__tests__/frame.test.ts](../../../packages/sdk/src/namespaces/__tests__/frame.test.ts)
- **Event channel**: [packages/core/src/bus-protocol.ts](../../../packages/core/src/bus-protocol.ts) — `mark:add-entity-type`, `mark:entity-type-added`
- **Backend handler**: [packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts) — handles `mark:add-entity-type`, appends `mark:entity-type-added` to the event log
- **Static defaults**: [packages/ontology/src/entity-types.ts](../../../packages/ontology/src/entity-types.ts) — `DEFAULT_ENTITY_TYPES` (the seed values used to bootstrap a fresh KB; per-KB additions come through Frame)
