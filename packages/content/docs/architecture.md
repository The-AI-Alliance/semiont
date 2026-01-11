# Architecture

Design principles and architectural decisions behind @semiont/content.

## Design Principles

### 1. Framework Independence

The package has no dependencies on web frameworks or HTTP libraries:

```typescript
// ✅ Works anywhere
import { FilesystemRepresentationStore } from '@semiont/content';

// CLI tools
const store = new FilesystemRepresentationStore({ basePath: './storage' });

// Background workers
const store = new FilesystemRepresentationStore({ basePath: '/var/workers/storage' });

// Lambda functions
const store = new FilesystemRepresentationStore({ basePath: '/tmp/storage' });
```

From [package.json](../package.json): Only depends on `@semiont/core` for checksum calculation.

### 2. Content-Addressed by Default

Content addressing is not optional - it's the fundamental design:

```typescript
// Storage IS content-addressed
const stored = await store.store(content, metadata);
// stored.checksum is the address

// No "location-based" mode
// No "ID-based" alternative
```

This enforces:
- Automatic deduplication
- Immutability guarantees
- Integrity verification

From [src/representation-store.ts](../src/representation-store.ts): The `RepresentationStore` interface defines only content-addressed operations.

### 3. Simple Configuration

Minimal configuration required:

```typescript
// Just provide a base path
const store = new FilesystemRepresentationStore({
  basePath: '/path/to/storage'
});

// Optional: project root for relative paths
const store = new FilesystemRepresentationStore(
  { basePath: 'data/storage' },
  '/project/root'
);
```

No complex initialization, connection pools, or setup required.

From [src/representation-store.ts](../src/representation-store.ts): Constructor (lines 90-106) accepts minimal configuration.

### 4. Interface-Based Design

Storage backends implement a common interface:

```typescript
interface RepresentationStore {
  store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>;
  retrieve(checksum: string, mediaType: string): Promise<Buffer>;
}
```

This enables:
- Multiple backend implementations (filesystem, S3, IPFS)
- Testing with mock implementations
- Runtime backend selection

From [src/representation-store.ts](../src/representation-store.ts): Interface defined at lines 64-82.

## Package Structure

```
packages/content/
├── src/
│   ├── index.ts                           # Public API exports
│   ├── representation-store.ts            # Core storage implementation
│   ├── mime-extensions.ts                 # MIME type utilities
│   └── __tests__/
│       └── representation-store.test.ts   # Test suite
├── docs/                                  # Topic documentation
│   ├── content-addressing.md
│   ├── sharding-strategy.md
│   ├── mime-types.md
│   └── architecture.md (this file)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

### Separation of Concerns

**representation-store.ts**: Storage operations
- Content addressing logic
- Sharding implementation
- File I/O operations

**mime-extensions.ts**: MIME type handling
- Type to extension mapping
- Extension lookup
- No storage logic

**index.ts**: Public API
- Exports only public interfaces
- No implementation details exposed

From [src/index.ts](../src/index.ts): Clean public API with type exports.

## Storage Implementation

### Filesystem Backend

The `FilesystemRepresentationStore` class provides the filesystem implementation:

```typescript
class FilesystemRepresentationStore implements RepresentationStore {
  private basePath: string;

  constructor(config: { basePath: string }, projectRoot?: string) {
    // Path resolution logic
  }

  async store(content: Buffer, metadata: RepresentationMetadata) {
    // 1. Calculate checksum
    // 2. Determine storage path
    // 3. Create directories
    // 4. Write file
    // 5. Return metadata
  }

  async retrieve(checksum: string, mediaType: string) {
    // 1. Determine storage path
    // 2. Read file
    // 3. Return content
  }
}
```

From [src/representation-store.ts](../src/representation-store.ts): Complete implementation at lines 87-196.

### Path Resolution

Supports both absolute and relative paths:

```typescript
// Absolute path - used directly
new FilesystemRepresentationStore({
  basePath: '/var/semiont/storage'
});

// Relative with project root
new FilesystemRepresentationStore(
  { basePath: 'data/storage' },
  '/project/root'
);
// Resolves to: /project/root/data/storage

// Relative without project root - uses cwd
new FilesystemRepresentationStore({
  basePath: 'data/storage'
});
// Resolves to: {cwd}/data/storage
```

From [src/representation-store.ts](../src/representation-store.ts): Lines 94-105 handle path resolution.

## Data Flow

### Storage Flow

```
Content (Buffer)
    ↓
Calculate SHA-256 checksum
    ↓
Extract base media type
    ↓
Determine shard path (first 4 hex)
    ↓
Encode media type for filesystem
    ↓
Get file extension
    ↓
Build complete path
    ↓
Create directories (if needed)
    ↓
Write file
    ↓
Return metadata with checksum
```

From [src/representation-store.ts](../src/representation-store.ts): The `store()` method implements this flow.

### Retrieval Flow

```
Checksum + Media Type
    ↓
Extract base media type
    ↓
Determine shard path
    ↓
Encode media type for filesystem
    ↓
Get file extension
    ↓
Build complete path
    ↓
Read file
    ↓
Return content (Buffer)
```

From [src/representation-store.ts](../src/representation-store.ts): The `retrieve()` method implements this flow.

## Type System

### Metadata Interfaces

```typescript
// Input metadata
interface RepresentationMetadata {
  mediaType: string;        // REQUIRED
  filename?: string;
  encoding?: string;
  language?: string;
  rel?: 'original' | 'thumbnail' | 'preview' | 'optimized' | 'derived' | 'other';
}

// Output with computed fields
interface StoredRepresentation extends RepresentationMetadata {
  '@id': string;           // Content address
  byteSize: number;        // Computed
  checksum: string;        // Computed
  created: string;         // Computed
}
```

From [src/representation-store.ts](../src/representation-store.ts): Interfaces defined at lines 43-59.

### Type Safety

TypeScript ensures:
- `mediaType` is always provided (required field)
- Checksums are string type (not Buffer or other)
- Metadata is properly typed
- Return types are predictable

## Error Handling

### Validation Errors

```typescript
// Invalid checksum format
await store.retrieve('', 'text/plain');
// Throws: "Invalid checksum: "

await store.retrieve('abc', 'text/plain');
// Throws: "Invalid checksum: abc"
```

From [src/representation-store.ts](../src/representation-store.ts): Checksum validation at lines 118-120 and 158-160.

### File Not Found

```typescript
// Non-existent content
await store.retrieve('a'.repeat(64), 'text/plain');
// Throws: "Representation not found for checksum aaa... with mediaType text/plain"
```

From [src/representation-store.ts](../src/representation-store.ts): Error handling at lines 179-182.

### Filesystem Errors

Other filesystem errors propagate naturally:
- Permission denied
- Disk full
- I/O errors

## Testing Strategy

### Unit Tests

The package includes comprehensive unit tests:

```typescript
describe('FilesystemRepresentationStore', () => {
  describe('store()', () => {
    it('should store content and return metadata');
    it('should use checksum-based sharding');
    it('should be idempotent');
    it('should create directory structure automatically');
  });

  describe('retrieve()', () => {
    it('should retrieve content by checksum');
    it('should throw error for non-existent checksum');
    it('should require both checksum AND mediaType');
    it('should reject invalid checksum format');
  });

  describe('Content deduplication', () => {
    it('should deduplicate identical content');
  });

  // ... more test suites
});
```

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): Complete test suite with 14 test cases.

### Test Coverage

Tests verify:
- ✅ Basic storage and retrieval
- ✅ Checksum format and consistency
- ✅ Sharding behavior
- ✅ Idempotent operations
- ✅ Deduplication
- ✅ Directory creation
- ✅ Error handling
- ✅ Large file support (>1MB)
- ✅ Binary content handling
- ✅ Media type requirements

## Future Extensibility

### Additional Backends

The interface-based design allows adding new backends:

```typescript
// S3 backend (future)
class S3RepresentationStore implements RepresentationStore {
  async store(content: Buffer, metadata: RepresentationMetadata) {
    // Upload to S3 with checksum as key
  }

  async retrieve(checksum: string, mediaType: string) {
    // Download from S3
  }
}

// IPFS backend (future)
class IPFSRepresentationStore implements RepresentationStore {
  async store(content: Buffer, metadata: RepresentationMetadata) {
    // Add to IPFS, use CID
  }

  async retrieve(checksum: string, mediaType: string) {
    // Fetch from IPFS
  }
}
```

All backends share the same interface and content-addressing model.

### Streaming Support

Currently uses Buffer for in-memory operations. Could add streaming:

```typescript
interface StreamingRepresentationStore {
  storeStream(stream: Readable, metadata: RepresentationMetadata): Promise<StoredRepresentation>;
  retrieveStream(checksum: string, mediaType: string): Readable;
}
```

Not implemented yet - most content is small enough for Buffer.

From CONTENT-PACKAGE.md: Decision #8 chose Buffer-only initially (YAGNI principle).

## Design Trade-offs

### In-Memory vs Streaming

**Choice**: Buffer (in-memory)

**Rationale**:
- Most representations are small (text, code, documents)
- Simpler implementation
- Can add streaming later if needed

**Trade-off**: Cannot efficiently handle multi-GB files

### Two-Level vs Three-Level Sharding

**Choice**: Two levels (4 hex chars)

**Rationale**:
- 65,536 shards sufficient for most use cases
- Simpler path structure
- Less directory traversal overhead

**Trade-off**: Not optimal for systems with >100 million files

### Filesystem vs Database

**Choice**: Filesystem

**Rationale**:
- Direct file access for external tools
- No database overhead
- Simple backup/recovery
- Natural fit for content blobs

**Trade-off**: Less flexible querying, no ACID transactions

## References

- Content-addressing: [IPFS Docs](https://docs.ipfs.tech/concepts/content-addressing/)
- Interface-based design: [Gang of Four Design Patterns](https://en.wikipedia.org/wiki/Design_Patterns)
- From [src/representation-store.ts](../src/representation-store.ts): Complete implementation
- From [package.json](../package.json): Minimal dependencies
- From CONTENT-PACKAGE.md: Architectural decisions and rationale
