# W3C Web Annotation in Semiont

## Overview

Semiont is a knowledge management system built on the **[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)**, a standard specification for creating, sharing, and managing annotations across the web. This document provides a comprehensive overview of how Semiont implements and extends the W3C specification across all layers of the application stack.

**Key Features**:
- Full W3C Web Annotation compliance for interoperability
- Multi-body annotations supporting entity type tags and document linking
- Event-sourced architecture with immutable audit trail
- Graph-based storage for efficient querying and relationship traversal
- JSON-LD export for semantic web integration

## Table of Contents

1. [W3C Web Annotation Foundation](#w3c-web-annotation-foundation)
2. [Annotation Types in Semiont](#annotation-types-in-semiont)
3. [Layer Architecture](#layer-architecture)
4. [UI Layer: User Interaction](#ui-layer-user-interaction)
5. [API Layer: HTTP Interface](#api-layer-http-interface)
6. [Layer 2: Event Store](#layer-2-event-store)
7. [Layer 3: Projection Store](#layer-3-projection-store)
8. [Layer 4: Graph Database](#layer-4-graph-database)
9. [JSON-LD Export](#json-ld-export)
10. [W3C Compliance](#w3c-compliance)

---

## W3C Web Annotation Foundation

### Core Concepts

The W3C Web Annotation Data Model defines a standard way to represent annotations as JSON-LD documents. Every annotation has:

- **`@context`**: JSON-LD context (always `"http://www.w3.org/ns/anno.jsonld"`)
- **`type`**: Always `"Annotation"`
- **`id`**: Unique identifier
- **`target`**: What is being annotated (the selected text/resource)
- **`body`**: The annotation content (0 or more bodies)
- **`motivation`**: Why the annotation was created (e.g., `"linking"`, `"highlighting"`, `"tagging"`)
- **`creator`**: Who created the annotation
- **`created`**: When it was created (ISO 8601 timestamp)

### Multiple Bodies Pattern

W3C allows annotations to have **multiple bodies**, each serving a different purpose. This is expressed as an array:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-456",
      "purpose": "linking"
    }
  ],
  "target": { ... }
}
```

**Key principle**: "Each Body is considered to be equally related to each Target individually"

---

## Annotation Types in Semiont

Semiont uses two primary annotation types, distinguished by their **motivation**:

### 1. Reference Annotations (`motivation: "linking"`)

References link highlighted text to other documents. They can exist in two states:

#### Stub Reference (Unresolved)

An unresolved link that doesn't yet point to a target document. Uses **empty body array** or only tagging bodies:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    }
  ],
  "creator": {
    "id": "user-789",
    "name": "Jane Doe"
  },
  "created": "2025-01-15T10:00:00Z"
}
```

#### Linked Reference

A reference with a linked target document. The body includes a `SpecificResource` item:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-456",
      "purpose": "linking"
    }
  ],
  "creator": {
    "id": "user-789",
    "name": "Jane Doe"
  },
  "created": "2025-01-15T10:00:00Z"
}
```

**Use Cases for Stub References**:
- User highlights text representing a concept that should have its own document
- AI detection identifies potential references during document analysis
- User wants to mark something for later research/documentation
- Importing content with unresolved citations

**Use Cases for Updating Reference Body**:

- User generates a new document via AI and adds SpecificResource to body
- User manually creates a new document and links it to the reference
- User searches and selects an existing document to link
- Automated entity resolution adds links to knowledge base entries

### 2. Highlight Annotations (`motivation: "highlighting"`)

Simple text highlights with optional comments:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-456",
  "motivation": "highlighting",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "E=mc²",
      "start": 500,
      "end": 505
    }
  },
  "body": {
    "type": "TextualBody",
    "value": "Famous equation from special relativity",
    "purpose": "commenting"
  },
  "creator": {
    "id": "user-789",
    "name": "Jane Doe"
  },
  "created": "2025-01-15T11:30:00Z"
}
```

### Target Flexibility

Semiont supports all three W3C target forms:

**Form 1: Simple string IRI**
```json
"target": "http://example.org/document"
```

**Form 2: Object with source only** (entire resource)
```json
"target": {
  "source": "doc-123"
}
```

**Form 3: Object with source + selector** (specific fragment)
```json
"target": {
  "source": "doc-123",
  "selector": {
    "type": "TextQuoteSelector",
    "exact": "selected text",
    "start": 100,
    "end": 113
  }
}
```

---

## Layer Architecture

Semiont uses a **layered event-sourced architecture** that separates concerns and provides strong consistency guarantees:

```
┌─────────────────────────────────────────────────────┐
│  UI Layer (Frontend)                                │
│  - React Components                                 │
│  - Type Guards (isStubReference, isResolvedReference)│
│  - Annotation Popups                                │
└─────────────────────────────────────────────────────┘
                       ↕ HTTP API
┌─────────────────────────────────────────────────────┐
│  API Layer (Backend)                                │
│  - REST Endpoints                                   │
│  - Request Validation                               │
│  - Event Creation                                   │
└─────────────────────────────────────────────────────┘
                       ↓ Events
┌─────────────────────────────────────────────────────┐
│  Layer 2: Event Store (PostgreSQL)                  │
│  - Immutable event log                              │
│  - Source of truth                                  │
│  - Full audit trail                                 │
└─────────────────────────────────────────────────────┘
                       ↓ Event Consumers
┌─────────────────────────────────────────────────────┐
│  Layer 3: Projection Store (PostgreSQL)             │
│  - Current state materialization                    │
│  - Fast queries                                     │
│  - Derived from events                              │
└─────────────────────────────────────────────────────┘
                       ↓ Graph Consumer
┌─────────────────────────────────────────────────────┐
│  Layer 4: Graph Database (Neo4j/Neptune/JanusGraph)│
│  - Relationship traversal                           │
│  - Entity type relationships                        │
│  - Connection discovery                             │
└─────────────────────────────────────────────────────┘
```

---

## UI Layer: User Interaction

**Location**: [../apps/frontend/src/components/annotation-popups/](../apps/frontend/src/components/annotation-popups/)

### Type Guards

The frontend distinguishes annotation types using type guard functions:

**File**: [../apps/frontend/src/lib/api/annotation-utils.ts](../apps/frontend/src/lib/api/annotation-utils.ts)

```typescript
/**
 * Type guard to check if annotation is a reference (vs highlight)
 */
export function isReference(annotation: Annotation): boolean {
  return annotation.motivation === 'linking';
}

/**
 * Type guard to check if a reference is a stub (unresolved)
 */
export function isStubReference(annotation: Annotation): boolean {
  return isReference(annotation) && !getBodySource(annotation.body);
}

/**
 * Type guard to check if a reference has a linked document
 */
export function isResolvedReference(annotation: Annotation): boolean {
  return isReference(annotation) && getBodySource(annotation.body) !== null;
}

/**
 * Extract entity types from annotation body
 */
export function getEntityTypes(annotation: Annotation): string[] {
  if (!Array.isArray(annotation.body)) {
    return [];
  }

  return annotation.body
    .filter(b => b.type === 'TextualBody' && b.purpose === 'tagging')
    .map(b => b.value)
    .filter(Boolean);
}

/**
 * Get the linking source (target document ID) from body
 */
export function getBodySource(body: Annotation['body']): string | null {
  if (!Array.isArray(body)) {
    return null;
  }

  const linkingBody = body.find(
    b => b.type === 'SpecificResource' && b.purpose === 'linking'
  );

  return linkingBody?.source || null;
}
```

### Annotation Popups

Different UI components render based on annotation state:

**StubReferencePopup** ([StubReferencePopup.tsx](../apps/frontend/src/components/annotation-popups/StubReferencePopup.tsx))
- Shows entity type tags
- "Generate New Document" button - creates document via AI and adds SpecificResource to body
- "Search Existing Documents" button - opens search modal to select target
- "Edit" button - modify entity types
- "Delete" button - remove annotation
- "JSON-LD" button - view W3C-compliant JSON

**ResolvedReferencePopup** ([ResolvedReferencePopup.tsx](../apps/frontend/src/components/annotation-popups/ResolvedReferencePopup.tsx))
- Shows entity type tags
- Shows linked document name and preview
- "Open Document" button - navigate to target
- "Unlink" button - convert back to stub by removing SpecificResource body
- "Edit" button - modify entity types
- "Delete" button - remove annotation
- "JSON-LD" button - view W3C-compliant JSON

**HighlightPopup** ([HighlightPopup.tsx](../apps/frontend/src/components/annotation-popups/HighlightPopup.tsx))
- Shows comment text
- "Edit" button - modify comment
- "Delete" button - remove annotation
- "Convert to Reference" button - change motivation to `linking`
- "JSON-LD" button - view W3C-compliant JSON

### Workflow Example: Creating and Linking a Reference

1. **User selects text** → CreateAnnotationPopup appears
2. **User clicks "Create Reference"** → Enters entity types
3. **System creates stub** with `body: [TextualBody tags]`
4. **StubReferencePopup appears** showing entity tags
5. **User clicks "Generate Document"** → AI creates target document
6. **System emits `annotation.body.updated` event** with `add` operation for SpecificResource
7. **ResolvedReferencePopup appears** with link to new document

---

## API Layer: HTTP Interface

**Location**: [../apps/backend/src/routes/annotations/](../apps/backend/src/routes/annotations/)

### Creating Annotations

**Endpoint**: `POST /api/annotations`

**Request**:
```json
{
  "documentId": "doc-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    }
  ]
}
```

**Response**: Created annotation with generated ID and timestamps

**Process**:
1. Validate request schema
2. Generate unique annotation ID
3. Create `annotation.added` event
4. Emit to event store (Layer 2)
5. Return optimistic response

### Updating Annotation Body

**Endpoint**: `PUT /api/annotations/:id/body`

**Request**:
```json
{
  "documentId": "doc-123",
  "operations": [
    {
      "op": "add",
      "item": {
        "type": "SpecificResource",
        "source": "doc-456",
        "purpose": "linking"
      }
    }
  ]
}
```

**Process**:

1. Fetch current annotation from projection (Layer 3)
2. Validate operations
3. Create `annotation.body.updated` event
4. Emit to event store (Layer 2)
5. Return optimistic response with updated body

**Supported Operations**:

- **Add**: `{ op: 'add', item: {...} }` - Append body item (idempotent)
- **Remove**: `{ op: 'remove', item: {...} }` - Remove matching body item
- **Replace**: `{ op: 'replace', oldItem: {...}, newItem: {...} }` - Replace body item

Multiple operations can be sent in a single request.

### Updating Annotations

**Endpoint**: `PUT /api/annotations/:id`

**Request**:
```json
{
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Physicist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-456",
      "purpose": "linking"
    }
  ]
}
```

**Process**:
1. Fetch current annotation
2. Create `annotation.updated` event with changes
3. Emit to event store
4. Return updated annotation

---

## Layer 2: Event Store

**Location**: [../apps/backend/src/events/](../apps/backend/src/events/)

The event store is the **single source of truth** for all state changes. All mutations are expressed as immutable events.

### Event Types

**File**: [../packages/core/src/events.ts](../packages/core/src/events.ts)

#### annotation.added
```typescript
{
  type: 'annotation.added',
  annotationId: 'anno-123',
  documentId: 'doc-123',
  userId: 'user-789',
  timestamp: '2025-01-15T10:00:00Z',
  payload: {
    motivation: 'linking',
    target: { ... },
    body: [
      { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      { type: 'TextualBody', value: 'Scientist', purpose: 'tagging' }
    ],
    creator: { ... }
  }
}
```

#### annotation.body.updated

```typescript
{
  type: 'annotation.body.updated',
  annotationId: 'anno-123',
  userId: 'user-789',
  timestamp: '2025-01-15T11:00:00Z',
  payload: {
    annotationId: 'anno-123',
    operations: [
      {
        op: 'add',
        item: {
          type: 'SpecificResource',
          source: 'doc-456',
          purpose: 'linking'
        }
      }
    ]
  }
}
```

This event supports fine-grained operations on the annotation body:

- **`add`**: Append a body item (idempotent - won't duplicate)
- **`remove`**: Remove a body item
- **`replace`**: Replace one body item with another

Multiple operations can be batched in a single event.

#### annotation.deleted
```typescript
{
  type: 'annotation.deleted',
  annotationId: 'anno-123',
  userId: 'user-789',
  timestamp: '2025-01-15T13:00:00Z',
  payload: {
    annotationId: 'anno-123',
    reason: 'user_request'
  }
}
```

### Event Store Schema

**Table**: `events` (PostgreSQL)

```sql
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  event_id UUID UNIQUE NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,  -- annotationId or documentId
  user_id VARCHAR(255),
  timestamp TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB,
  version INTEGER NOT NULL
);

CREATE INDEX idx_events_aggregate ON events(aggregate_id, version);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);
```

### Properties

- **Immutable**: Events are never modified or deleted
- **Ordered**: Events have version numbers and timestamps
- **Complete**: Full audit trail of all changes
- **Replayable**: Can reconstruct any state by replaying events

---

## Layer 3: Projection Store

**Location**: [../apps/backend/src/projection/](../apps/backend/src/projection/)

The projection store materializes **current state** from the event stream for fast queries.

### Projection Consumer

**File**: [../apps/backend/src/events/consumers/projection-consumer.ts](../apps/backend/src/events/consumers/projection-consumer.ts)

The projection consumer listens to events and updates the current state:

```typescript
// annotation.added
await db.annotations.create({
  id: event.annotationId,
  documentId: event.documentId,
  motivation: event.payload.motivation,
  target: event.payload.target,
  body: event.payload.body,  // Multi-body array
  creator: event.payload.creator,
  created: event.timestamp,
  modified: event.timestamp
});

// annotation.body.updated
const currentAnnotation = await db.annotations.get(event.annotationId);
let bodyArray = Array.isArray(currentAnnotation.body) ? [...currentAnnotation.body] : [];

for (const op of event.payload.operations) {
  if (op.op === 'add') {
    // Idempotent add
    const exists = bodyArray.some(item => JSON.stringify(item) === JSON.stringify(op.item));
    if (!exists) bodyArray.push(op.item);
  } else if (op.op === 'remove') {
    bodyArray = bodyArray.filter(item => JSON.stringify(item) !== JSON.stringify(op.item));
  } else if (op.op === 'replace') {
    const index = bodyArray.findIndex(item => JSON.stringify(item) === JSON.stringify(op.oldItem));
    if (index !== -1) bodyArray[index] = op.newItem;
  }
}

await db.annotations.update(event.annotationId, {
  body: bodyArray,
  modified: event.timestamp
});

// annotation.updated
await db.annotations.update(event.annotationId, {
  body: event.payload.body,
  modified: event.timestamp
});

// annotation.deleted
await db.annotations.delete(event.annotationId);
```

### Projection Schema

**Table**: `annotations` (PostgreSQL)

```sql
CREATE TABLE annotations (
  id VARCHAR(255) PRIMARY KEY,
  document_id VARCHAR(255) NOT NULL REFERENCES documents(id),
  motivation VARCHAR(50) NOT NULL,
  target JSONB NOT NULL,
  body JSONB NOT NULL,  -- Multi-body array
  creator JSONB NOT NULL,
  created TIMESTAMPTZ NOT NULL,
  modified TIMESTAMPTZ NOT NULL,

  CONSTRAINT valid_motivation CHECK (motivation IN ('linking', 'highlighting', 'tagging'))
);

CREATE INDEX idx_annotations_document ON annotations(document_id);
CREATE INDEX idx_annotations_motivation ON annotations(motivation);
CREATE INDEX idx_annotations_created ON annotations(created DESC);
```

### Query Examples

```sql
-- Get all annotations for a document
SELECT * FROM annotations
WHERE document_id = 'doc-123'
ORDER BY created DESC;

-- Get all stub references
SELECT * FROM annotations
WHERE motivation = 'linking'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(body) AS elem
    WHERE elem->>'type' = 'SpecificResource'
  );

-- Get all references with linked documents
SELECT * FROM annotations
WHERE motivation = 'linking'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(body) AS elem
    WHERE elem->>'type' = 'SpecificResource'
  );

-- Get all references with specific entity type
SELECT * FROM annotations
WHERE motivation = 'linking'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(body) AS elem
    WHERE elem->>'type' = 'TextualBody'
      AND elem->>'purpose' = 'tagging'
      AND elem->>'value' = 'Person'
  );
```

---

## Layer 4: Graph Database

**Location**: [../apps/backend/src/graph/implementations/](../apps/backend/src/graph/implementations/)

The graph database stores annotations as nodes and relationships for efficient traversal and discovery.

### Graph Consumer

**File**: [../apps/backend/src/events/consumers/graph-consumer.ts](../apps/backend/src/events/consumers/graph-consumer.ts)

The graph consumer listens to events and updates the graph:

```typescript
// annotation.added
case 'annotation.added':
  await graphDb.createAnnotation({
    id: event.annotationId,
    motivation: event.payload.motivation,
    target: event.payload.target,
    body: event.payload.body,  // Multi-body array
    creator: event.payload.creator
  });
  break;

// annotation.body.updated
case 'annotation.body.updated':
  // Apply fine-grained operations to body array
  const currentAnnotation = await graphDb.getAnnotation(event.payload.annotationId);
  if (currentAnnotation) {
    let bodyArray = Array.isArray(currentAnnotation.body) ? [...currentAnnotation.body] : [];

    for (const op of event.payload.operations) {
      if (op.op === 'add') {
        const exists = bodyArray.some(item => JSON.stringify(item) === JSON.stringify(op.item));
        if (!exists) bodyArray.push(op.item);
      } else if (op.op === 'remove') {
        bodyArray = bodyArray.filter(item => JSON.stringify(item) !== JSON.stringify(op.item));
      } else if (op.op === 'replace') {
        const index = bodyArray.findIndex(item => JSON.stringify(item) === JSON.stringify(op.oldItem));
        if (index !== -1) bodyArray[index] = op.newItem;
      }
    }

    await graphDb.updateAnnotation(event.payload.annotationId, {
      body: bodyArray
    });
  }
  break;
```

### Neo4j Implementation

**File**: [../apps/backend/src/graph/implementations/neo4j.ts](../apps/backend/src/graph/implementations/neo4j.ts)

#### Graph Schema

```
(Document)
    ↑
    | [:BELONGS_TO]
    |
(Annotation)
    |
    | [:REFERENCES] (only when body includes SpecificResource)
    ↓
(Document)

(Annotation) -[:TAGGED_AS]-> (EntityType)
```

#### Creating Annotations

```cypher
// Stub Reference (no linking body)
MATCH (d:Document {id: $documentId})
CREATE (a:Annotation {
  id: $id,
  documentId: $documentId,
  exact: $exact,
  selector: $selector,
  type: 'SpecificResource',
  motivation: $motivation,
  creator: $creator,
  created: datetime($created)
})
CREATE (a)-[:BELONGS_TO]->(d)
FOREACH (entityType IN $entityTypes |
  MERGE (et:EntityType {name: entityType})
  CREATE (a)-[:TAGGED_AS]->(et)
)
RETURN a

// Reference with linked document (body includes SpecificResource)
MATCH (from:Document {id: $fromId})
MATCH (to:Document {id: $toId})
CREATE (a:Annotation {
  id: $id,
  documentId: $documentId,
  exact: $exact,
  selector: $selector,
  type: 'SpecificResource',
  motivation: $motivation,
  creator: $creator,
  created: datetime($created),
  source: $source
})
CREATE (a)-[:BELONGS_TO]->(from)
CREATE (a)-[:REFERENCES]->(to)
FOREACH (entityType IN $entityTypes |
  MERGE (et:EntityType {name: entityType})
  CREATE (a)-[:TAGGED_AS]->(et)
)
RETURN a
```

#### Updating Annotation Body

```cypher
// Add SpecificResource body item (linking to another document)
MATCH (a:Annotation {id: $annotationId})
MATCH (to:Document {id: $source})
SET a.source = $source,
    a.modified = datetime()
MERGE (a)-[:REFERENCES]->(to)
RETURN a

// Remove body item
MATCH (a:Annotation {id: $annotationId})
// Body modifications are handled in application code,
// then the updated body array is set on the annotation node
SET a.body = $updatedBodyArray,
    a.modified = datetime()
RETURN a
```

#### Reconstructing Annotations

When retrieving annotations from the graph, the body array is reconstructed:

```typescript
private parseAnnotationNode(node: any, entityTypes: string[] = []): Annotation {
  // Reconstruct body array from entity tags and linking body
  const bodyArray: Annotation['body'] = [];

  // Add entity tag bodies (TextualBody with purpose: "tagging")
  for (const entityType of entityTypes) {
    bodyArray.push({
      type: 'TextualBody' as const,
      value: entityType,
      purpose: 'tagging' as const,
    });
  }

  // Add linking body (SpecificResource) if annotation has linked document
  if (node.properties.source) {
    bodyArray.push({
      type: 'SpecificResource' as const,
      source: node.properties.source,
      purpose: 'linking' as const,
    });
  }

  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    'type': 'Annotation',
    id: node.properties.id,
    motivation: node.properties.motivation,
    target: {
      source: node.properties.documentId,
      selector: JSON.parse(node.properties.selector)
    },
    body: bodyArray,
    creator: JSON.parse(node.properties.creator),
    created: node.properties.created
  };
}
```

### Graph Queries

#### Finding Connected Documents

```cypher
// Documents referenced by doc-123
MATCH (d:Document {id: 'doc-123'})<-[:BELONGS_TO]-(a:Annotation)-[:REFERENCES]->(target:Document)
RETURN DISTINCT target

// Documents referencing doc-123
MATCH (source:Document)<-[:BELONGS_TO]-(a:Annotation)-[:REFERENCES]->(d:Document {id: 'doc-123'})
RETURN DISTINCT source

// Bidirectional connections
MATCH (d1:Document {id: 'doc-123'})<-[:BELONGS_TO]-(a1:Annotation)-[:REFERENCES]->(d2:Document)
MATCH (d2)<-[:BELONGS_TO]-(a2:Annotation)-[:REFERENCES]->(d1)
RETURN d2
```

#### Entity Type Queries

```cypher
// All annotations tagged as "Person"
MATCH (a:Annotation)-[:TAGGED_AS]->(et:EntityType {name: 'Person'})
RETURN a

// Documents with Person annotations
MATCH (d:Document)<-[:BELONGS_TO]-(a:Annotation)-[:TAGGED_AS]->(et:EntityType {name: 'Person'})
RETURN DISTINCT d

// Entity type statistics
MATCH (et:EntityType)<-[:TAGGED_AS]-(a:Annotation)
RETURN et.name, count(a) as count
ORDER BY count DESC
```

### Other Graph Implementations

Semiont supports multiple graph databases:

- **Neo4j** - Primary implementation, full Cypher support
- **AWS Neptune** - Gremlin-based, cloud-native
- **JanusGraph** - Gremlin-based, distributed
- **MemoryGraph** - In-memory for testing

All implementations provide the same interface and reconstruct W3C-compliant multi-body annotations.

---

## JSON-LD Export

Semiont provides JSON-LD export functionality throughout the UI, allowing users to view and copy W3C-compliant annotation data.

### UI Components

#### JsonLdButton Component

**File**: [../apps/frontend/src/components/annotation-popups/JsonLdButton.tsx](../apps/frontend/src/components/annotation-popups/JsonLdButton.tsx)

Appears in all annotation popups as a "📄 JSON-LD" button.

#### JsonLdView Component

**File**: [../apps/frontend/src/components/annotation-popups/JsonLdView.tsx](../apps/frontend/src/components/annotation-popups/JsonLdView.tsx)

Modal view showing:
- Syntax-highlighted JSON with CodeMirror
- Copy to clipboard button
- Dark/light theme support
- Line numbers (configurable)

#### JsonLdPanel Component

**File**: [../apps/frontend/src/components/document/panels/JsonLdPanel.tsx](../apps/frontend/src/components/document/panels/JsonLdPanel.tsx)

Document-level panel showing:
- Full document JSON-LD representation
- Read-only CodeMirror editor
- Copy to clipboard functionality

### Export Format

Exported annotations are fully W3C-compliant:

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "https://semiont.app/annotations/anno-123",
  "motivation": "linking",
  "target": {
    "source": "https://semiont.app/documents/doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "https://semiont.app/documents/doc-456",
      "purpose": "linking"
    }
  ],
  "creator": {
    "id": "https://semiont.app/users/user-789",
    "name": "Jane Doe",
    "type": "Person"
  },
  "created": "2025-01-15T10:00:00Z",
  "modified": "2025-01-15T11:00:00Z"
}
```

### Use Cases

1. **Interoperability**: Share annotations with other W3C-compliant systems
2. **Data Export**: Backup or migrate annotation data
3. **Debugging**: Inspect annotation structure during development
4. **Documentation**: Copy examples for API documentation
5. **Integration**: Feed annotations to semantic web tools
6. **Academic**: Cite annotation structure in papers

---

## W3C Compliance

Semiont implements the W3C Web Annotation Data Model with full compliance:

### Compliance Achievements

✅ **Zero Bodies Allowed**: W3C spec explicitly allows annotations with 0 or more bodies. Stub references use `body: []` or only tagging bodies.

✅ **Multiple Bodies**: Multi-body arrays combine TextualBody tags with SpecificResource links.

✅ **TextualBody**: Used for entity type tags with `purpose: "tagging"`.

✅ **SpecificResource**: Used for document links with `purpose: "linking"`. No non-compliant `value` property.

✅ **Purpose Field**: All bodies have appropriate `purpose` values (`"tagging"`, `"linking"`, `"commenting"`).

✅ **Target Flexibility**: Support all 3 W3C target forms (simple IRI, source-only, source+selector).

✅ **Required Fields**: All annotations have `@context`, `type`, `target` as required by W3C.

✅ **Motivation**: Standard W3C motivations (`linking`, `highlighting`, `tagging`, `commenting`).

✅ **Creator**: W3C-compliant creator objects with `id`, `name`, and optional `type`.

✅ **Timestamps**: ISO 8601 formatted `created` and `modified` timestamps.

✅ **JSON-LD Context**: Always use `"http://www.w3.org/ns/anno.jsonld"`.

### Testing

**File**: [../apps/backend/src/__tests__/w3c-compliance.test.ts](../apps/backend/src/__tests__/w3c-compliance.test.ts)

**15 W3C Compliance Tests** covering:

1. Stub reference validation (empty/tagging-only body arrays)
2. Linked reference validation (SpecificResource has source, no value)
3. Multi-body array structure
4. Target validation (all 3 forms)
5. Motivation validation
6. Required W3C fields
7. TextualBody structure
8. SpecificResource structure
9. Purpose field usage
10. Creator format
11. Timestamp format
12. Stub → Linked transitions (adding SpecificResource to body)
13. Linked → Stub transitions (removing SpecificResource from body)
14. Entity type tag extraction
15. Body source extraction

### Standards Compliance

Semiont follows:

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) - Core specification
- [W3C Web Annotation Vocabulary](https://www.w3.org/TR/annotation-vocab/) - Motivation and purpose values
- [W3C Web Annotation Protocol](https://www.w3.org/TR/annotation-protocol/) - HTTP API patterns
- [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) - JSON-LD serialization
- [Open Annotation Community Group](https://www.w3.org/community/openannotation/) - Best practices

---

## Implementation Highlights

### Separation of Concerns

- **UI Layer**: Pure presentation, delegates to API
- **API Layer**: Validation and event creation only
- **Event Store**: Immutable source of truth
- **Projection**: Optimized for queries
- **Graph**: Optimized for traversal

### Event-Sourced Benefits

- Complete audit trail
- Time-travel debugging
- Replay events to reconstruct state
- Multiple projections from same events
- Easy to add new views

### Graph Database Benefits

- Efficient relationship queries
- Entity type aggregation
- Connection discovery
- Path finding
- Network analysis

### W3C Benefits

- Interoperability with other systems
- Standard tooling support
- Semantic web integration
- Long-term data portability
- Academic and research compatibility

---

## Future Enhancements

### Planned Features

1. **Annotation Collections**: W3C AnnotationCollections for grouping related annotations
2. **Annotation Pages**: Pagination support for large annotation sets
3. **External Targets**: Annotate resources outside Semiont
4. **Embedded Content**: Embed rich media in TextualBody
5. **Style States**: Visual styling hints for rendering
6. **Rights and Licenses**: Copyright and licensing metadata
7. **Provenance**: Detailed annotation history and versioning
8. **Agents**: Distinguish human vs automated creators

### W3C Features Not Yet Implemented

- `generator` - Software that created the annotation
- `audience` - Intended audience for the annotation
- `accessibility` - Accessibility features
- `rights` - Copyright and licensing
- `canonical` - Canonical version IRI
- `via` - Source/provenance information

---

## References

- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [W3C Web Annotation Vocabulary](https://www.w3.org/TR/annotation-vocab/)
- [W3C Web Annotation Protocol](https://www.w3.org/TR/annotation-protocol/)
- [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/)
- [Semiont Documentation](https://github.com/The-AI-Alliance/semiont)

---

## Appendix: Complete Example

Here's a complete lifecycle example showing stub creation, entity type updates, and resolution:

### 1. Create Stub Reference

```json
POST /api/annotations
{
  "documentId": "doc-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    }
  ]
}
```

### 2. Update Entity Types

```json
PUT /api/annotations/anno-123
{
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Physicist",
      "purpose": "tagging"
    }
  ]
}
```

### 3. Update Annotation Body (Add Link)

```json
PUT /api/annotations/anno-123/body
{
  "documentId": "doc-123",
  "operations": [
    {
      "op": "add",
      "item": {
        "type": "SpecificResource",
        "source": "doc-456",
        "purpose": "linking"
      }
    }
  ]
}
```

### 4. Final Annotation State

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "anno-123",
  "motivation": "linking",
  "target": {
    "source": "doc-123",
    "selector": {
      "type": "TextQuoteSelector",
      "exact": "Albert Einstein",
      "start": 100,
      "end": 115
    }
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Scientist",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Physicist",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "doc-456",
      "purpose": "linking"
    }
  ],
  "creator": {
    "id": "user-789",
    "name": "Jane Doe",
    "type": "Person"
  },
  "created": "2025-01-15T10:00:00Z",
  "modified": "2025-01-15T11:00:00Z"
}
```

This annotation is now:
- ✅ Fully W3C-compliant
- ✅ Stored across all 4 layers
- ✅ Queryable via API, projection, and graph
- ✅ Exportable as JSON-LD
- ✅ Interoperable with other W3C systems
