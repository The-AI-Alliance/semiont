# @semiont/content

Content-addressed storage for resource representations with automatic deduplication.

## Overview

This package provides framework-independent content storage infrastructure for the Semiont annotation system. It uses content-addressed storage where the SHA-256 checksum IS the filename, enabling automatic deduplication and idempotent storage operations.

## Installation

```bash
npm install @semiont/content
```

## Usage

### Basic Storage

Store and retrieve content using the filesystem implementation:

```typescript
import { FilesystemRepresentationStore } from '@semiont/content';

const store = new FilesystemRepresentationStore({
  basePath: '/path/to/storage'
});

// Store content
const content = Buffer.from('Hello, World!');
const stored = await store.store(content, {
  mediaType: 'text/plain',
  rel: 'original'
});

console.log(stored.checksum);  // SHA-256 hash as filename
console.log(stored.byteSize);   // Content size in bytes
console.log(stored['@id']);     // Content address (same as checksum)

// Retrieve content
const retrieved = await store.retrieve(stored.checksum, 'text/plain');
console.log(retrieved.toString());  // 'Hello, World!'
```

From [src/representation-store.ts](src/representation-store.ts): Content-addressed storage with checksum-based sharding.

### Storage Structure

Content is stored with automatic sharding based on checksum:

```
basePath/
└── representations/
    └── {mediaType}/     # e.g., "text~1markdown" (/ encoded as ~1)
        └── {ab}/        # First 2 hex digits of checksum
            └── {cd}/    # Next 2 hex digits of checksum
                └── rep-{checksum}.{ext}  # Full checksum + extension
```

Example for markdown content with checksum `5aaa0b72abc123...`:
```
basePath/representations/text~1markdown/5a/aa/rep-5aaa0b72abc123....md
```

### Character Encoding

Character sets are preserved in metadata while storage paths use only base MIME types:

```typescript
const content = Buffer.from('Héllo', 'latin1');
const stored = await store.store(content, {
  mediaType: 'text/plain; charset=iso-8859-1',  // Full type with charset
  rel: 'original'
});

// Storage path uses base type: .../text~1plain/.../rep-{checksum}.txt
// Full mediaType "text/plain; charset=iso-8859-1" preserved in metadata
```

From [src/representation-store.ts](src/representation-store.ts): Charset parameters preserved in metadata but stripped from directory structure.

### Automatic Deduplication

Identical content is stored only once, regardless of metadata:

```typescript
const content = Buffer.from('Same content');

const stored1 = await store.store(content, {
  mediaType: 'text/plain',
  language: 'en'
});

const stored2 = await store.store(content, {
  mediaType: 'text/plain',
  language: 'es'  // Different metadata
});

// Same checksum and file location
console.log(stored1.checksum === stored2.checksum);  // true
```

From [src/representation-store.ts](src/representation-store.ts): Content-addressed design automatically deduplicates identical bytes.

### MIME Type Extensions

Get file extensions for MIME types:

```typescript
import { getExtensionForMimeType, hasKnownExtension } from '@semiont/content';

const ext = getExtensionForMimeType('text/markdown');
console.log(ext);  // '.md'

const hasExt = hasKnownExtension('image/png');
console.log(hasExt);  // true

const unknown = getExtensionForMimeType('unknown/type');
console.log(unknown);  // '.dat' (fallback)
```

From [src/mime-extensions.ts](src/mime-extensions.ts): Mapping of 80+ MIME types to file extensions.

## API Reference

### FilesystemRepresentationStore

Content-addressed storage implementation using the filesystem.

**Constructor**:
```typescript
new FilesystemRepresentationStore(
  config: { basePath: string },
  projectRoot?: string
)
```

**Methods**:

- `store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>`
  - Store content and return metadata with checksum
  - Idempotent: same content = same file

- `retrieve(checksum: string, mediaType: string): Promise<Buffer>`
  - Retrieve content by checksum and media type
  - Both parameters required (checksum + mediaType determine path)

### RepresentationMetadata

Metadata for content being stored:

```typescript
interface RepresentationMetadata {
  mediaType: string;  // REQUIRED - MIME type (e.g., "text/markdown; charset=utf-8")
  filename?: string;
  encoding?: string;
  language?: string;
  rel?: 'original' | 'thumbnail' | 'preview' | 'optimized' | 'derived' | 'other';
}
```

From [src/representation-store.ts](src/representation-store.ts): Metadata interface for content storage.

### StoredRepresentation

Complete representation information after storage:

```typescript
interface StoredRepresentation extends RepresentationMetadata {
  '@id': string;       // Content address (same as checksum)
  byteSize: number;    // Size in bytes
  checksum: string;    // SHA-256 hex hash (64 characters)
  created: string;     // ISO 8601 timestamp
}
```

From [src/representation-store.ts](src/representation-store.ts): Stored representation metadata.

### RepresentationStore

Interface for storage backends (filesystem, S3, IPFS, etc.):

```typescript
interface RepresentationStore {
  store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>;
  retrieve(checksum: string, mediaType: string): Promise<Buffer>;
}
```

From [src/representation-store.ts](src/representation-store.ts): Interface enabling multiple storage backends.

## Architecture

### Content-Addressed Design

The storage system uses content addressing where the checksum IS the identifier:

1. **Automatic Deduplication**: Same bytes = same file
2. **Idempotent Operations**: Storing identical content multiple times has no effect
3. **O(1) Retrieval**: Direct lookup by checksum + mediaType
4. **Integrity Verification**: Checksum guarantees content hasn't changed

### Sharding Strategy

Content is sharded using the first 4 hex digits of the checksum:

```
Checksum: 5aaa0b72abc123...
Shard:    5a/aa/
```

This provides:
- Balanced distribution across directories
- Maximum ~65,536 directories per media type
- Efficient filesystem performance

### Media Type Encoding

Forward slashes in MIME types are encoded for filesystem compatibility:

```
text/markdown     → text~1markdown
application/json  → application~1json
image/svg+xml     → image~1svg+xml
```

## Dependencies

- `@semiont/core`: For `calculateChecksum` utility

## Package Structure

```
packages/content/
├── src/
│   ├── index.ts                           # Public API exports
│   ├── representation-store.ts            # FilesystemRepresentationStore implementation
│   ├── mime-extensions.ts                 # MIME type to extension mapping
│   └── __tests__/
│       └── representation-store.test.ts   # Unit tests
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

## Testing

The package includes comprehensive unit tests:

```bash
npm test
```

Tests cover:
- Content storage and retrieval
- Checksum-based sharding
- Idempotent operations
- Automatic deduplication
- Directory creation
- Character encoding preservation
- Binary content handling
- Large file handling (>1MB)
- Error handling (missing content, invalid checksums)

From [src/__tests__/representation-store.test.ts](src/__tests__/representation-store.test.ts): Complete test suite.

## Future Storage Backends

The `RepresentationStore` interface supports multiple backends:

- **Filesystem** ✅ (implemented)
- **S3** (planned)
- **IPFS** (planned)
- **Cloud Storage** (planned)

All backends share the same content-addressed design and API.

## License

Apache-2.0
