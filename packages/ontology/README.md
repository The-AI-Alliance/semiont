# @semiont/ontology

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+ontology%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=ontology)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=ontology)
[![npm version](https://img.shields.io/npm/v/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/ontology.svg)](https://www.npmjs.com/package/@semiont/ontology)
[![License](https://img.shields.io/npm/l/@semiont/ontology.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The entity types a knowledge base starts with, and the readers of entity types and tags on an annotation. It is small on purpose: a knowledge base's vocabulary is its own, kept in its record, and what lives here is only the starting set and the functions that read a vocabulary back off an annotation.

## Who uses it

- **[`@semiont/make-meaning`](../make-meaning/README.md)** seeds a new knowledge base with `DEFAULT_ENTITY_TYPES`, and reads entity types off annotations when it assembles context and when the Smelter indexes them.
- **[`@semiont/graph`](../graph/README.md)** reads them when it writes an annotation to the graph, and seeds its entity-type collection with the defaults.
- **[`@semiont/react-ui`](../react-ui/README.md)** reads them to show a reference's entity types and a tag's category.

**Building an application?** A knowledge base's vocabulary comes from the knowledge base, through [`@semiont/sdk`](../sdk/README.md): `browse.entityTypes()`, `frame.addEntityTypes(...)`, `browse.tagSchemas()` and `frame.addTagSchema(...)`. The three readers here are plain functions over an annotation, and a script that wants them imports this package for them.

## What is in it

| | |
|---|---|
| `DEFAULT_ENTITY_TYPES` | The nine types a new knowledge base is given: Person, Organization, Location, Event, Concept, Product, Technology, Date, Author |
| `getEntityTypes(annotation)` | The entity types a reference names |
| `getTagCategory(annotation)`, `getTagSchemaId(annotation)` | A tag's category, and the id of the schema it was made under |
| `TagCollection`, `TagCollectionOperations` | Types describing an entity-type collection kept in a store |

## Example

```typescript
import { getEntityTypes, getTagCategory, getTagSchemaId } from '@semiont/ontology';
import type { Annotation } from '@semiont/core';

function describe(annotation: Annotation): string {
  const category = getTagCategory(annotation);          // 'Issue', or undefined when it is not a tag
  if (category) return `${getTagSchemaId(annotation)}: ${category}`;
  return getEntityTypes(annotation).join(', ');         // 'Person, Organization'
}
```

## What a change must keep

- **The defaults are a starting set, not the vocabulary.** A knowledge base adds types of its own, and what it holds is what its record says. Nothing checks an entity type against `DEFAULT_ENTITY_TYPES`.
- **Tag schemas are not here.** A knowledge base registers its own at runtime, and a schema's data lives with the knowledge base that owns it. The `TagSchema` and `TagCategory` types are [`@semiont/core`](../core/README.md)'s.
- **The readers need no registry.** Each reads only the annotation it is given. A reference names its entity types in `TextualBody` items whose `purpose` is `tagging`. A tag has two items: one `tagging`, holding the category, and one `classifying`, holding the schema's id.
- **An annotation of another shape is an ordinary answer.** `getEntityTypes` gives an empty list for a body that is a single item or absent. The two tag readers give `undefined` for an annotation that is not a tag.
- **Seeding is not here.** Giving a new knowledge base its defaults needs an event bus and an event store, so it is `@semiont/make-meaning`'s, in `src/bootstrap/entity-types.ts`.

The readers of the rest of an annotation (its target, its quoted text, the resource it links to, `isHighlight`, `isReference`) are `@semiont/core`'s.

## License

Apache-2.0
