# @semiont/ontology

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+ontology%22)

Entity types, tag schemas, and tag extraction utilities for the Semiont annotation system.

## Overview

This package consolidates ontology-related code that was previously scattered across the codebase:
- **Entity types**: Semantic categories for tagging resources and annotations (Person, Organization, Location, etc.)
- **Tag schemas**: Structural analysis frameworks (IRAC for legal, IMRAD for scientific, Toulmin for argumentation)
- **Tag extraction**: Utilities for extracting tag information from W3C annotations

## Installation

```bash
npm install @semiont/ontology
```

## Usage

### Entity Types

Default entity types used throughout the system:

```typescript
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';

console.log(DEFAULT_ENTITY_TYPES);
// ['Person', 'Organization', 'Location', 'Event', 'Concept',
//  'Product', 'Technology', 'Date', 'Author']
```

### Tag Schemas

Three built-in tag schemas for structural document analysis:

```typescript
import {
  TAG_SCHEMAS,
  getTagSchema,
  getAllTagSchemas,
  getTagSchemasByDomain
} from '@semiont/ontology';

// Get a specific schema
const iracSchema = getTagSchema('legal-irac');
// Returns: { id: 'legal-irac', name: 'Legal Analysis (IRAC)',
//           domain: 'legal', tags: [...] }

// Get all schemas
const allSchemas = getAllTagSchemas();
// Returns array of all 3 schemas

// Get schemas by domain
const legalSchemas = getTagSchemasByDomain('legal');
// Returns schemas where domain === 'legal'
```

Available schemas (from [src/tag-schemas.ts](src/tag-schemas.ts)):
- `legal-irac`: Legal Analysis (IRAC) - Issue, Rule, Application, Conclusion
- `scientific-imrad`: Scientific Paper (IMRAD) - Introduction, Methods, Results, Discussion
- `argument-toulmin`: Argument Structure (Toulmin) - Claim, Evidence, Warrant, Counterargument, Rebuttal

### Entity Extraction

Extract entity types from annotation bodies:

```typescript
import { getEntityTypes } from '@semiont/ontology';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

const annotation: Annotation = {
  motivation: 'linking',
  body: [
    { type: 'TextualBody', purpose: 'tagging', value: 'Person' },
    { type: 'TextualBody', purpose: 'tagging', value: 'Organization' },
    { type: 'SpecificResource', source: 'resource://abc123' }
  ],
  target: 'resource://xyz789'
};

const entityTypes = getEntityTypes(annotation);
// Returns: ['Person', 'Organization']
```

From [src/entity-extraction.ts](src/entity-extraction.ts): Extracts values from `TextualBody` items where `purpose === 'tagging'`.

### Tag Extraction

Extract tag categories and schema IDs from tag annotations:

```typescript
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';

const tagAnnotation = {
  motivation: 'tagging',
  body: [
    { type: 'TextualBody', purpose: 'tagging', value: 'Issue' },
    { type: 'TextualBody', purpose: 'classifying', value: 'legal-irac' }
  ],
  target: { source: 'resource://doc123', selector: { /* ... */ } }
};

const category = getTagCategory(tagAnnotation);
// Returns: 'Issue'

const schemaId = getTagSchemaId(tagAnnotation);
// Returns: 'legal-irac'
```

From [src/tag-extraction.ts](src/tag-extraction.ts): Tag annotations use dual-body structure with `purpose: 'tagging'` for category and `purpose: 'classifying'` for schema ID.

### Tag Schema Helpers

```typescript
import { isValidCategory, getSchemaCategory } from '@semiont/ontology';

// Check if a category exists in a schema
const isValid = isValidCategory('legal-irac', 'Issue');
// Returns: true

const invalid = isValidCategory('legal-irac', 'Conclusion');
// Returns: true (all 4 IRAC categories are valid)

const notValid = isValidCategory('legal-irac', 'Introduction');
// Returns: false (Introduction is IMRAD, not IRAC)

// Get category details
const category = getSchemaCategory('legal-irac', 'Rule');
// Returns: {
//   name: 'Rule',
//   description: 'The relevant law, statute, or legal principle',
//   examples: ['What law applies?', 'What is the legal standard?', ...]
// }
```

## Tag Collections

Type definitions for graph database tag collection operations:

```typescript
import type { TagCollection, TagCollectionOperations } from '@semiont/ontology';

// TagCollection interface for stored collections
interface TagCollection {
  id: string;
  collectionType: 'entity-types';
  tags: string[];
  created: Date;
  updatedAt: Date;
}

// TagCollectionOperations interface for graph database implementations
interface TagCollectionOperations {
  getEntityTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;
  hasEntityTypesCollection(): Promise<boolean>;
  initializeCollections(): Promise<void>;
}
```

From [src/tag-collections.ts](src/tag-collections.ts): Interfaces for managing entity type collections in graph databases.

## Dependencies

- `@semiont/api-client`: For W3C annotation type definitions

## Package Structure

```
packages/ontology/
├── src/
│   ├── index.ts                # Public API exports
│   ├── entity-types.ts         # DEFAULT_ENTITY_TYPES
│   ├── tag-collections.ts      # TagCollection interfaces
│   ├── tag-schemas.ts          # TAG_SCHEMAS registry
│   ├── entity-extraction.ts    # getEntityTypes utility
│   ├── tag-extraction.ts       # getTagCategory, getTagSchemaId
│   └── bootstrap.ts            # Re-export note (actual bootstrap in backend)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## Notes

- **Bootstrap service**: The entity types bootstrap logic remains in `apps/backend/src/bootstrap/entity-types-bootstrap.ts` to avoid circular dependency with `@semiont/core`.
- **Annotation type guards**: Type guards like `isHighlight()`, `isReference()`, etc. remain in `@semiont/api-client` as the OpenAPI spec is the source of truth for W3C motivations.

## License

Apache-2.0
