# Graph Database API Reference

## Overview

The `@semiont/graph` package provides a unified interface for graph databases with support for multiple backends: Neo4j, AWS Neptune, JanusGraph, and in-memory.

## GraphDatabase Interface

All implementations conform to this interface:

```typescript
interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Document operations
  createDocument(document: Document): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  updateDocument(id: string, updates: Partial<Document>): Promise<Document | null>;
  deleteDocument(id: string): Promise<boolean>;
  getAllDocuments(): Promise<Document[]>;

  // Annotation operations
  createAnnotation(annotation: Annotation): Promise<Annotation>;
  getAnnotation(id: string): Promise<Annotation | null>;
  updateAnnotation(id: string, updates: Partial<Annotation>): Promise<Annotation | null>;
  deleteAnnotation(id: string): Promise<boolean>;
  getAnnotationsForDocument(documentId: string): Promise<Annotation[]>;

  // Tag collection operations
  getEntityTypes(): Promise<string[]>;
  getReferenceTypes(): Promise<string[]>;
  addEntityType(type: string): Promise<void>;
  addReferenceType(type: string): Promise<void>;

  // Query operations
  findDocumentsByEntityTypes(entityTypes: string[]): Promise<Document[]>;
  findAnnotationsByTarget(targetId: string): Promise<Annotation[]>;

  // Utility
  clear(): Promise<void>;
}
```

## Provider Implementations

### Neo4j

Native graph database with Cypher query language.

```typescript
import { Neo4jGraphDatabase } from '@semiont/graph/neo4j';

const graph = new Neo4jGraphDatabase({
  uri: 'neo4j://localhost:7687',
  username: 'neo4j',
  password: 'password'
});

await graph.connect();
```

### AWS Neptune

Managed graph database supporting Gremlin.

```typescript
import { NeptuneGraphDatabase } from '@semiont/graph/neptune';

const graph = new NeptuneGraphDatabase({
  endpoint: 'wss://your-cluster.neptune.amazonaws.com:8182/gremlin',
  region: 'us-east-1'
});

await graph.connect();
```

### JanusGraph

Distributed graph database with pluggable backends.

```typescript
import { JanusGraphDatabase } from '@semiont/graph/janusgraph';

const graph = new JanusGraphDatabase({
  endpoint: 'ws://localhost:8182/gremlin'
});

await graph.connect();
```

### In-Memory

JavaScript implementation for development and testing.

```typescript
import { MemoryGraphDatabase } from '@semiont/graph/memory';

const graph = new MemoryGraphDatabase();
await graph.connect(); // No-op for memory
```

## Data Model

### Document Vertex

Represents a document in the system.

```typescript
interface Document {
  id: string;
  name: string;
  format: string;
  entityTypes: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  provenance?: {
    clonedFrom?: string;
    createdBy: string;
    creationMethod: 'api' | 'generation' | 'clone';
  };
}
```

### Annotation Vertex

Represents a W3C Web Annotation.

```typescript
interface Annotation {
  id: string;
  target: {
    source: string;  // Document ID
    selector?: Selector[];
  };
  body: AnnotationBody[];
  creator: string;
  created: string;
  modified?: string;
}
```

### Edges

- **BELONGS_TO**: Links Annotation to its source Document
- **REFERENCES**: Links Annotation to its target Document (if resolved)

## Query Patterns

### Finding Annotations

```typescript
// Get all annotations for a document
const annotations = await graph.getAnnotationsForDocument('doc-123');

// Find annotations targeting a document
const references = await graph.findAnnotationsByTarget('doc-456');
```

### Finding Documents

```typescript
// Find documents by entity types
const persons = await graph.findDocumentsByEntityTypes(['Person']);

// Find documents with multiple entity types
const orgs = await graph.findDocumentsByEntityTypes(['Person', 'Organization']);
```

### Graph Traversal

```typescript
// Neo4j-specific Cypher query
if (graph instanceof Neo4jGraphDatabase) {
  const result = await graph.query(`
    MATCH (d:Document {id: $id})<-[:BELONGS_TO]-(a:Annotation)
    OPTIONAL MATCH (a)-[:REFERENCES]->(target:Document)
    RETURN a, target
  `, { id: 'doc-123' });
}

// Gremlin traversal (Neptune/JanusGraph)
if (graph instanceof GremlinGraphDatabase) {
  const result = await graph.g.V()
    .hasLabel('Document')
    .has('id', 'doc-123')
    .inE('BELONGS_TO')
    .outV()
    .path()
    .toList();
}
```

## Provider-Specific Features

### Array Property Handling

Different databases handle arrays differently:

| Provider | Storage | Retrieval |
|----------|---------|-----------|
| Neo4j | Native arrays | Direct access |
| Neptune | JSON strings | Parse after retrieval |
| JanusGraph | JSON strings | Parse after retrieval |
| Memory | JavaScript arrays | Direct access |

### Transaction Support

```typescript
// Neo4j transactions
const session = driver.session();
const tx = session.beginTransaction();
try {
  await tx.run('CREATE (d:Document {id: $id})', { id });
  await tx.commit();
} catch (error) {
  await tx.rollback();
  throw error;
} finally {
  await session.close();
}
```

### Performance Characteristics

| Provider | Setup | Speed | Scalability | Persistence |
|----------|-------|-------|-------------|-------------|
| Neo4j | Medium | Fast | High | Yes |
| Neptune | Complex | Medium | Very High | Yes |
| JanusGraph | Complex | Medium | Very High | Yes |
| Memory | None | Very Fast | Low | No |