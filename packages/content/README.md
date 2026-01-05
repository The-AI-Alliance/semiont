# @semiont/content

Content-addressed storage for resource representations with automatic deduplication.

## Installation

```bash
npm install @semiont/content
```

## Quick Start

```typescript
import { FilesystemRepresentationStore } from '@semiont/content';

const store = new FilesystemRepresentationStore({
  basePath: '/path/to/storage'
});

// Store content - checksum becomes the address
const content = Buffer.from('Hello, World!');
const stored = await store.store(content, {
  mediaType: 'text/plain',
  rel: 'original'
});

// Retrieve by checksum
const retrieved = await store.retrieve(stored.checksum, 'text/plain');
```

From [src/representation-store.ts](src/representation-store.ts): Content-addressed storage implementation.

## Key Features

- **Content-Addressed**: SHA-256 checksum is the filename
- **Automatic Deduplication**: Same content = same file
- **Idempotent**: Storing same content multiple times has no effect
- **Sharding**: Distributes files across 65,536 directories for performance
- **MIME Type Support**: 80+ types with proper file extensions
- **Character Encoding**: Preserves charset in metadata

## Storage Structure

```
basePath/representations/{mediaType}/{ab}/{cd}/rep-{checksum}.{ext}
```

Example: `text~1markdown/5a/aa/rep-5aaa0b72abc123....md`

From [src/representation-store.ts](src/representation-store.ts): Checksum-based sharding uses first 4 hex digits.

## API Reference

### FilesystemRepresentationStore

```typescript
new FilesystemRepresentationStore(
  config: { basePath: string },
  projectRoot?: string
)

store(content: Buffer, metadata: RepresentationMetadata): Promise<StoredRepresentation>
retrieve(checksum: string, mediaType: string): Promise<Buffer>
```

### Types

```typescript
interface RepresentationMetadata {
  mediaType: string;  // REQUIRED
  filename?: string;
  encoding?: string;
  language?: string;
  rel?: 'original' | 'thumbnail' | 'preview' | 'optimized' | 'derived' | 'other';
}

interface StoredRepresentation extends RepresentationMetadata {
  '@id': string;       // Content address
  byteSize: number;
  checksum: string;    // SHA-256 hex (64 chars)
  created: string;     // ISO 8601
}
```

From [src/representation-store.ts](src/representation-store.ts): Complete type definitions.

### Utilities

```typescript
getExtensionForMimeType(mediaType: string): string  // Returns extension or '.dat'
hasKnownExtension(mediaType: string): boolean        // Check if type is known
```

From [src/mime-extensions.ts](src/mime-extensions.ts): 80+ MIME type mappings.

## Documentation

- [Content Addressing](docs/content-addressing.md) - How content-addressed storage works
- [Sharding Strategy](docs/sharding-strategy.md) - Directory distribution details
- [MIME Types](docs/mime-types.md) - Media type handling
- [Architecture](docs/architecture.md) - Design principles and implementation

## License

Apache-2.0
