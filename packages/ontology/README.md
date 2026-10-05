# @semiont/ontology

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+ontology%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=ontology)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=ontology)
[![npm version](https://img.shields.io/npm/v/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![License](https://img.shields.io/npm/l/@semiont/ontology.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Entity types, and the readers of entity types and tags on an annotation.

## Overview

This package holds:
- **Entity types**: the kinds of thing a reference can be about and a resource can be classified as (Person, Organization, Location and so on). `DEFAULT_ENTITY_TYPES` is the starting set, and `getEntityTypes` reads them from an annotation.
- **Tag readers**: `getTagCategory` and `getTagSchemaId`, which read a tag's category and its schema's id from an annotation's body. They need no schema registry.
- **Tag collections**: interfaces for keeping the entity-type vocabulary in a graph store.

**Tag schemas are not in this package.** A knowledge base registers its own with `frame.addTagSchema(...)`; the `TagSchema` and `TagCategory` types are `@semiont/core`'s, and a schema's data lives with the knowledge base that owns it.

## Installation

```bash
npm install @semiont/ontology
```

## Usage

### Entity types

The entity types a new knowledge base starts with:

```typescript
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';

console.log(DEFAULT_ENTITY_TYPES);
// ['Person', 'Organization', 'Location', 'Event', 'Concept',
//  'Product', 'Technology', 'Date', 'Author']
```

A knowledge base adds its own with `frame.addEntityTypes(...)` and reads the whole vocabulary with `browse.entityTypes()`.

### Tag schemas

Tag schemas are registered per knowledge base, at runtime (see the [`semiont-tag` skill](../../docs/builder/skills/semiont-tag/SKILL.md)). The `TagSchema` and `TagCategory` types are `@semiont/core`'s, and a schema's data lives with the knowledge base that owns it.

```typescript
import type { TagSchema } from '@semiont/sdk';

const SCHEMA: TagSchema = {
  id: 'my-schema',
  name: 'My Schema',
  description: 'What this schema classifies',
  domain: 'general',
  tags: [{ name: 'Claim', description: 'An assertion the text makes', examples: ['What is being claimed?'] }],
};

// Registering identical content again changes nothing.
await semiont.frame.addTagSchema(SCHEMA);

// The schemas a knowledge base has registered
const all = await semiont.browse.tagSchemas().fresh();
```

### Reading entity types from an annotation

A reference names its entity types in `TextualBody` items whose `purpose` is `tagging`. `getEntityTypes` collects their values, from a body that is a list. A body that is a single item, or absent, gives an empty list.

```typescript
import { getEntityTypes } from '@semiont/ontology';

const annotations = await semiont.browse.annotations(rId).fresh();
for (const annotation of annotations) {
  console.log(annotation.id, getEntityTypes(annotation));   // e.g. ['Person', 'Organization']
}
```

See [src/entity-extraction.ts](src/entity-extraction.ts).

### Reading a tag's category and schema

A tag has two body items: one whose `purpose` is `tagging`, holding the category, and one whose `purpose` is `classifying`, holding the schema's id. Both readers return `undefined` for an annotation that is not a tag.

```typescript
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';

const annotations = await semiont.browse.annotations(rId).fresh();
for (const annotation of annotations) {
  const category = getTagCategory(annotation);   // e.g. 'Issue'
  const schemaId = getTagSchemaId(annotation);   // e.g. 'legal-irac'
  if (category) console.log(`${schemaId}: ${category}`);
}
```

See [src/tag-extraction.ts](src/tag-extraction.ts).

## Tag collections

Interfaces for keeping the entity-type vocabulary in a graph store:

```typescript
import type { TagCollection, TagCollectionOperations } from '@semiont/ontology';
```

`TagCollection` is a stored collection (`id`, `collectionType: 'entity-types'`, `tags`, `created`, `updatedAt`). `TagCollectionOperations` is `getEntityTypes`, `addEntityType`, `addEntityTypes`, `hasEntityTypesCollection` and `initializeCollections`. See [src/tag-collections.ts](src/tag-collections.ts). The drivers in `@semiont/graph` keep the vocabulary through the first three, which `GraphDatabase` declares itself; none of them declares these interfaces.

## Dependencies

- `@semiont/core`, for the `Annotation` type.

## Notes

- **Seeding a knowledge base's entity types** is in `packages/make-meaning/src/bootstrap/entity-types.ts`. It needs an event bus and an event store, which do not belong in this package.
- **The readers of the rest of an annotation** (its target, its quoted text, the resource it links to, `isHighlight()`, `isReference()` and the like) are `@semiont/core`'s, in `src/web-annotation-utils.ts`.

## License

Apache-2.0
