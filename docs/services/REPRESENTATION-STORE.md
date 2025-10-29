# Representation Storage Architecture (Layer 1)

**Layer 1** of the Semiont data architecture provides W3C-compliant storage of document representations using a filesystem-based approach with checksum-based content addressing.

## Overview

RepresentationStore is the foundation layer that stores document representations (content) according to W3C standards. Content is stored by checksum (content-addressable storage), enabling deduplication and integrity verification.

**Key Characteristics:**
- **Content-Addressed**: Files stored by checksum (SHA-256)
- **W3C Compliant**: Implements W3C representation metadata
- **Deduplication**: Identical content stored once
- **Sharding**: 4-hex sharding for scalability
- **Independence**: No dependencies on other layers
- **Integrity**: Checksums verify content integrity

**Related Documentation:**
- [Event Store (Layer 2)](./EVENT-STORE.md) - Immutable event log
- [Projection Storage (Layer 3)](./PROJECTION.md) - Materialized views
- [Graph Database (Layer 4)](./GRAPH.md) - Relationship traversal
- [Architecture Overview](./ARCHITECTURE.md) - Complete system architecture

## Module Organization

```
apps/backend/src/storage/
├── representation/                    # Layer 1: W3C representations
│   └── representation-store.ts        # Content-addressed storage
└── shared/                           # Shared utilities
    ├── path-builder.ts                # Path construction & sharding
    └── shard-utils.ts                # Jump consistent hash
```

## Storage Structure

### Filesystem Layout

```
{basePath}/
└── representations/                  # Representation namespace
    ├── 00/
    │   ├── 00/
    │   │   └── sha256-abc123def.dat # Shard [00,00]
    │   ├── 01/
    │   │   └── sha256-def456ghi.dat # Shard [00,01]
    │   └── ff/
    │       └── sha256-ghi789jkl.dat # Shard [00,ff]
    ├── ab/
    │   ├── cd/
    │   │   └── sha256-jkl012mno.dat # Shard [ab,cd]
    │   └── ef/
    │       └── sha256-mno345pqr.dat # Shard [ab,ef]
    └── ff/
        └── ff/
            └── sha256-pqr678stu.dat # Shard [ff,ff]
```

### Content-Addressed Storage

**Checksum-Based Addressing** using SHA-256:

1. **Input**: Content buffer (any format)
2. **Calculate**: SHA-256 checksum
3. **Hash**: Jump Consistent Hash on checksum → bucket (0-65535)
4. **Path**: `basePath/representations/ab/cd/sha256-{checksum}.dat`

**Benefits:**
- **Deduplication**: Identical content stored once
- **Integrity**: Checksum verifies content hasn't changed
- **Content-Addressed**: Natural key for retrieval
- **W3C Compliance**: Follows W3C representation model

### File Format

Representation files (`.dat`) store raw content:

- **Text**: UTF-8 encoded strings
- **Binary**: Raw bytes (PDFs, images, etc.)
- **No wrapping**: Pure content
- **Checksum as key**: Filename is `sha256-{checksum}.dat`

## API Reference

### Instantiation

```typescript
import { FilesystemRepresentationStore } from './storage/representation/representation-store';

// Create instance
const repStore = new FilesystemRepresentationStore({
  basePath: '/data/storage'
});
```

### RepresentationStore Interface

**W3C-compliant representation storage.**

#### Store Representation

```typescript
// Store content (returns checksum and metadata)
const storedRep: StoredRepresentation = await repStore.store(
  content: Buffer,
  metadata: {
    mediaType: string;      // MIME type (e.g., 'text/plain')
    language?: string;      // ISO language code (e.g., 'en')
    rel?: string;           // Relationship ('original', 'derived', etc.)
  }
);

// Returns:
// {
//   checksum: 'sha256:abc123...',
//   mediaType: 'text/plain',
//   language: 'en',
//   rel: 'original',
//   size: 1024
// }
```

#### Retrieve Representation

```typescript
// Get content by checksum
const buffer: Buffer = await repStore.get(checksum: string);

// Get content as string
const text: string = buffer.toString('utf-8');
```

#### Delete Representation

```typescript
// Delete by checksum
await repStore.delete(checksum: string): Promise<void>;
```

#### Check Existence

```typescript
// Check if representation exists
const exists: boolean = await repStore.exists(checksum: string);
```

## W3C Representation Model

### ResourceDescriptor Integration

RepresentationStore implements the storage layer for W3C ResourceDescriptor representations:

```typescript
// ResourceDescriptor (Layer 3/4 metadata)
const resource: ResourceDescriptor = {
  '@context': 'https://schema.org/',
  '@id': 'http://localhost:4000/documents/doc-123',
  name: 'My Document',
  representations: [{
    mediaType: 'text/plain',
    checksum: 'sha256:abc123...',  // Points to Layer 1 storage
    rel: 'original',
    language: 'en'
  }],
  // ... other metadata
};

// Layer 1: RepresentationStore
// Content retrieved by checksum
const content = await repStore.get('sha256:abc123...');
```

### Multiple Representations

W3C allows multiple representations per resource:

```typescript
// Store original
const original = await repStore.store(
  Buffer.from('Original text'),
  { mediaType: 'text/plain', rel: 'original' }
);

// Store translation
const translation = await repStore.store(
  Buffer.from('Texto original'),
  { mediaType: 'text/plain', rel: 'translation', language: 'es' }
);

// Store derived format
const markdown = await repStore.store(
  Buffer.from('# Original text'),
  { mediaType: 'text/markdown', rel: 'derived' }
);

// All three stored separately, deduplicated if content matches
```

## Common Patterns

### Save Document (Full Flow)

```typescript
// 1. Store representation (Layer 1)
const contentBuffer = Buffer.from(documentText);
const storedRep = await repStore.store(contentBuffer, {
  mediaType: 'text/plain',
  language: 'en',
  rel: 'original'
});

// 2. Emit event with checksum (Layer 2)
await eventStore.appendEvent({
  type: 'document.created',
  documentId,
  userId: user.id,
  payload: {
    name: 'My Document',
    format: 'text/plain',
    contentChecksum: storedRep.checksum,  // Reference to Layer 1
    creationMethod: 'api'
  }
});

// 3. Event consumer builds ResourceDescriptor (Layer 3/4)
// GraphDB stores metadata with checksum reference
```

### Get Document (Full Flow)

```typescript
// 1. Get metadata from GraphDB (Layer 4)
const resource = await graphDb.getDocument(documentId);

// 2. Extract checksum from representations
const checksum = resource.representations[0]?.checksum;

// 3. Retrieve content from RepresentationStore (Layer 1)
const content = await repStore.get(checksum);

// 4. Return to client
return {
  ...resource,
  content: content.toString('utf-8')
};
```

### Delete Document (Full Flow)

```typescript
// 1. Get resource to find checksums
const resource = await graphDb.getDocument(documentId);

// 2. Delete all representations (Layer 1)
for (const rep of resource.representations) {
  await repStore.delete(rep.checksum);
}

// 3. Delete metadata (Layers 3/4)
await projectionManager.delete(documentId);
await graphDb.deleteDocument(documentId);
```

## Content Deduplication

### Automatic Deduplication

Since storage is content-addressed, identical content is automatically deduplicated:

```typescript
// Store same content twice
const rep1 = await repStore.store(
  Buffer.from('Same content'),
  { mediaType: 'text/plain', rel: 'original' }
);

const rep2 = await repStore.store(
  Buffer.from('Same content'),
  { mediaType: 'text/plain', rel: 'copy' }
);

// rep1.checksum === rep2.checksum
// Only stored once on disk
// Both documents reference same checksum
```

### Storage Efficiency

```typescript
// 100 documents with identical content
// Traditional storage: 100 files × 10KB = 1MB
// Content-addressed: 1 file × 10KB = 10KB
// Space saved: 99%
```

## Performance Characteristics

### Fast Operations

- **Store**: O(1) - SHA-256 calculation + write
- **Get by checksum**: O(1) - direct path calculation
- **Exists check**: O(1) - filesystem stat
- **Delete**: O(1) - direct path calculation

### Checksum Overhead

- **SHA-256 calculation**: ~500 MB/s (typical)
- **Small files (<1KB)**: Negligible overhead
- **Large files (>10MB)**: Consider streaming

## Architecture Decisions

### Why Content-Addressed Storage?

- **W3C Compliance**: Natural fit for W3C representation model
- **Deduplication**: Free storage savings
- **Integrity**: Built-in verification
- **Immutability**: Content never changes for given checksum

### Why SHA-256?

- **Security**: Cryptographically secure
- **Speed**: Fast on modern CPUs
- **Collision Resistance**: Practically impossible collisions
- **Standard**: Widely supported, well-understood

### Why Layer 1?

RepresentationStore is Layer 1 (not Layer 3) because:
- **No event dependency**: Direct storage, no event replay needed
- **Foundation layer**: Other layers build on top
- **Simple model**: Content in → checksum out
- **Content-agnostic**: Doesn't know about documents/annotations

## Testing

RepresentationStore has comprehensive test coverage:

```typescript
// Store and retrieve
const rep = await store.store(content, metadata);
const retrieved = await store.get(rep.checksum);
assert(retrieved.equals(content));

// Deduplication
const rep1 = await store.store(content, meta1);
const rep2 = await store.store(content, meta2);
assert(rep1.checksum === rep2.checksum);

// Integrity
const corrupted = await store.get('invalid-checksum');
// Throws error or returns null
```

## Troubleshooting

### Missing Representation

Check if checksum exists:

```typescript
const checksum = resource.representations[0]?.checksum;
const exists = await repStore.exists(checksum);

if (!exists) {
  console.error('Representation not found:', checksum);
  // Re-upload content or fix reference
}
```

### Checksum Mismatch

Verify content integrity:

```typescript
const content = await repStore.get(checksum);
const calculated = calculateSha256(content);

if (calculated !== checksum) {
  console.error('Content corrupted!');
  // Content has been modified
}
```

### Storage Space

Content-addressed storage is efficient, but monitor usage:

```bash
# Check representation storage size
du -sh {basePath}/representations/

# Find large representations
find {basePath}/representations/ -type f -size +10M
```

## Migration from ContentManager

Old pattern (removed):
```typescript
// ❌ OLD: ContentManager
const contentManager = createContentManager({ basePath });
await contentManager.save(documentId, content);
const retrieved = await contentManager.get(documentId);
```

New pattern (current):
```typescript
// ✅ NEW: RepresentationStore
const repStore = new FilesystemRepresentationStore({ basePath });
const stored = await repStore.store(content, { mediaType, language, rel });
const retrieved = await repStore.get(stored.checksum);
```

**Key Differences:**
- Content-addressed (checksum) instead of document ID
- Returns metadata with checksum
- W3C-compliant structure
- Built-in deduplication

## Related Documentation

- [PROJECTION.md](./PROJECTION.md) - Layer 3 projection storage
- [EVENT-STORE.md](./EVENT-STORE.md) - Layer 2 event sourcing
- [GRAPH.md](./GRAPH.md) - Layer 4 graph database
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Complete system architecture
- [W3C-RESOURCES.md](../../W3C-RESOURCES.md) - W3C migration details
