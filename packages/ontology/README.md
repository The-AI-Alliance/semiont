# @semiont/ontology

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+ontology%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=ontology)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=ontology)
[![npm version](https://img.shields.io/npm/v/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![License](https://img.shields.io/npm/l/@semiont/ontology.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The entity types a knowledge base starts with. It is small on purpose: a knowledge base's vocabulary is its own, kept in its record, and what lives here is only the starting set.

## Who uses it

- **[`@semiont/make-meaning`](../make-meaning/README.md)** seeds a new knowledge base with `DEFAULT_ENTITY_TYPES`.
- **[`@semiont/graph`](../graph/README.md)** seeds its entity-type collection with the defaults.

**Building an application?** A knowledge base's vocabulary comes from the knowledge base, through [`@semiont/sdk`](../sdk/README.md): `browse.entityTypes()`, `frame.addEntityTypes(...)`, `browse.tagSchemas()` and `frame.addTagSchema(...)`. The readers of the entity types and the tag on an annotation (`getEntityTypes`, `getTagCategory`, `getTagSchemaId`) are [`@semiont/core`](../core/README.md)'s, and the SDK exports them.

## What is in it

| | |
|---|---|
| `DEFAULT_ENTITY_TYPES` | The nine types a new knowledge base is given: Person, Organization, Location, Event, Concept, Product, Technology, Date, Author |
| `TagCollection`, `TagCollectionOperations` | Types describing an entity-type collection kept in a store |

## What a change must keep

- **The defaults are a starting set, not the vocabulary.** A knowledge base adds types of its own, and what it holds is what its record says. Nothing checks an entity type against `DEFAULT_ENTITY_TYPES`.
- **Tag schemas are not here.** A knowledge base registers its own at runtime, and a schema's data lives with the knowledge base that owns it. The `TagSchema` and `TagCategory` types are [`@semiont/core`](../core/README.md)'s.
- **Seeding is not here.** Giving a new knowledge base its defaults is an append to its record, so it is the [Archivist](../../docs/protocol/ARCHIVIST.md)'s.

The readers of an annotation (its target, its quoted text, the resource it links to, its entity types, its tag) are `@semiont/core`'s.

## License

Apache-2.0
