# GraphDatabase Interface

The `GraphDatabase` interface defines the contract that all graph database implementations must follow.

## Interface Definition

From [src/interface.ts](../src/interface.ts):

```typescript
export interface GraphDatabase {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Resource operations
  createResource(resource: ResourceDescriptor): Promise<ResourceDescriptor>;
  getResource(id: ResourceUri): Promise<ResourceDescriptor | null>;
  updateResource(id: ResourceUri, input: UpdateResourceInput): Promise<ResourceDescriptor>;
  deleteResource(id: ResourceUri): Promise<void>;
  listResources(filter: ResourceFilter): Promise<{ resources: ResourceDescriptor[]; total: number }>;
  searchResources(query: string, limit?: number): Promise<ResourceDescriptor[]>;

  // Annotation operations
  createAnnotation(input: CreateAnnotationInternal): Promise<Annotation>;
  getAnnotation(id: AnnotationUri): Promise<Annotation | null>;
  updateAnnotation(id: AnnotationUri, updates: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: AnnotationUri): Promise<void>;
  listAnnotations(filter: { resourceId?: ResourceId; type?: AnnotationCategory }): Promise<{ annotations: Annotation[]; total: number }>;

  // Highlight operations
  getHighlights(resourceId: ResourceId): Promise<Annotation[]>;

  // Reference operations
  resolveReference(annotationId: AnnotationId, source: ResourceId): Promise<Annotation>;
  getReferences(resourceId: ResourceId): Promise<Annotation[]>;
  getEntityReferences(resourceId: ResourceId, entityTypes?: string[]): Promise<Annotation[]>;

  // Relationship queries
  getResourceAnnotations(resourceId: ResourceId): Promise<Annotation[]>;
  getResourceReferencedBy(resourceUri: ResourceUri, motivation?: string): Promise<Annotation[]>;

  // Graph traversal
  getResourceConnections(resourceId: ResourceId): Promise<GraphConnection[]>;
  findPath(fromResourceId: ResourceId, toResourceId: ResourceId, maxDepth?: number): Promise<GraphPath[]>;

  // Analytics
  getEntityTypeStats(): Promise<EntityTypeStats[]>;
  getStats(): Promise<{
    resourceCount: number;
    annotationCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  }>;

  // Bulk operations
  createAnnotations(inputs: CreateAnnotationInternal[]): Promise<Annotation[]>;
  resolveReferences(inputs: { annotationId: AnnotationId; source: ResourceId }[]): Promise<Annotation[]>;

  // Auto-detection
  detectAnnotations(resourceId: ResourceId): Promise<Annotation[]>;

  // Tag Collections
  getEntityTypes(): Promise<string[]>;
  addEntityType(tag: string): Promise<void>;
  addEntityTypes(tags: string[]): Promise<void>;

  // Utility
  generateId(): string;
  clearDatabase(): Promise<void>;
}
```

## Type Definitions

The interface uses types from `@semiont/api-client` and `@semiont/core`:

- `ResourceDescriptor` - W3C Web Annotation Data Model resource
- `Annotation` - W3C Web Annotation
- `ResourceUri` - Branded type for resource URIs
- `AnnotationUri` - Branded type for annotation URIs
- `ResourceId` - Short resource identifier
- `AnnotationId` - Short annotation identifier
- `ResourceFilter` - Filtering options for resources
- `UpdateResourceInput` - Fields allowed for resource updates
- `CreateAnnotationInternal` - Internal annotation creation input
- `AnnotationCategory` - Annotation type/category
- `GraphConnection` - Graph connection data
- `GraphPath` - Path between resources
- `EntityTypeStats` - Entity type statistics

## Implementations

All four implementations satisfy this interface:

- [Neo4jGraphDatabase](../src/implementations/neo4j.ts) - Cypher-based
- [NeptuneGraphDatabase](../src/implementations/neptune.ts) - Gremlin-based (AWS)
- [JanusGraphDatabase](../src/implementations/janusgraph.ts) - Gremlin-based (open source)
- [MemoryGraphDatabase](../src/implementations/memorygraph.ts) - In-memory for testing
