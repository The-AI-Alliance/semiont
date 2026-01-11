# @semiont/content

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+content%22)
[![npm version](https://img.shields.io/npm/v/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/content.svg)](https://www.npmjs.com/package/@semiont/content)
[![License](https://img.shields.io/npm/l/@semiont/content.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Content-addressed storage using SHA-256 checksums with automatic deduplication and W3C compliance.

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
  language: 'en',
  rel: 'original'
});

console.log(stored.checksum); // sha256:abc123...

// Retrieve by checksum
const retrieved = await store.retrieve(stored.checksum, 'text/plain');
console.log(retrieved.toString()); // "Hello, World!"

// Same content = same checksum (deduplication)
const duplicate = await store.store(content, {
  mediaType: 'text/plain',
  rel: 'copy'
});

console.log(duplicate.checksum === stored.checksum); // true
```

## Features

- 🔐 **Content-Addressed** - SHA-256 checksum as identifier
- 🎯 **Automatic Deduplication** - Identical content stored once
- 🗂️ **Smart Sharding** - 65,536 directories for scalability
- 📊 **W3C Compliant** - Full representation metadata support
- 🏷️ **MIME Type Support** - 80+ types with proper extensions
- 🌍 **Multilingual** - Language and encoding metadata

## Documentation

- [API Reference](./docs/API.md) - Complete API documentation
- [Architecture](./docs/ARCHITECTURE.md) - Design principles
- [Patterns](./docs/PATTERNS.md) - Usage patterns and best practices

## Examples

- [Basic Example](./examples/basic.ts) - Storage and retrieval
- [Deduplication](./examples/deduplication.ts) - Content addressing benefits
- [Binary Content](./examples/binary.ts) - Images and documents

## Storage Architecture

### Content Addressing

Every piece of content is addressed by its SHA-256 checksum:

```typescript
const checksum = calculateChecksum(content);
// sha256:5aaa0b72c1f4d8e7a9f2c8b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3
```

### Storage Path Structure

```
basePath/
└── representations/
    └── {mediaType}/        # URL-encoded MIME type
        └── {ab}/           # First 2 hex chars of checksum
            └── {cd}/       # Next 2 hex chars (65,536 shards)
                └── rep-{checksum}.{ext}
```

Example paths:
```
representations/text~1plain/5a/aa/rep-5aaa0b72...abc.txt
representations/image~1png/ff/12/rep-ff123456...def.png
representations/application~1json/ab/cd/rep-abcd1234...123.json
```

### Deduplication

Content-addressed storage provides automatic deduplication:

```typescript
// Store same content 100 times
for (let i = 0; i < 100; i++) {
  await store.store(identicalContent, metadata);
}
// Result: Only ONE file on disk
```

## API Overview

### FilesystemRepresentationStore

```typescript
const store = new FilesystemRepresentationStore({
  basePath: '/data/storage'  // Root storage directory
});
```

### Store Content

```typescript
const stored = await store.store(
  content: Buffer,
  metadata: {
    mediaType: string;      // Required: MIME type
    filename?: string;      // Optional: Original filename
    encoding?: string;      // Optional: Character encoding
    language?: string;      // Optional: ISO language code
    rel?: string;          // Optional: Relationship type
  }
): Promise<StoredRepresentation>
```

### Retrieve Content

```typescript
const buffer = await store.retrieve(
  checksum: string,        // SHA-256 checksum
  mediaType: string        // MIME type for path lookup
): Promise<Buffer>
```

### Types

```typescript
interface StoredRepresentation {
  '@id': string;           // Content URI
  checksum: string;        // SHA-256 hex (64 chars)
  byteSize: number;        // Content size in bytes
  mediaType: string;       // MIME type
  created: string;         // ISO 8601 timestamp
  language?: string;       // ISO language code
  encoding?: string;       // Character encoding
  rel?: string;           // Relationship type
}
```

## Supported MIME Types

The package includes 80+ MIME type mappings:

| Type | Extensions | Example |
|------|-----------|---------|
| Text | `.txt`, `.md`, `.html`, `.csv` | `text/plain` → `.txt` |
| Documents | `.pdf`, `.doc`, `.docx` | `application/pdf` → `.pdf` |
| Images | `.png`, `.jpg`, `.gif`, `.webp` | `image/png` → `.png` |
| Audio | `.mp3`, `.wav`, `.ogg` | `audio/mpeg` → `.mp3` |
| Video | `.mp4`, `.webm`, `.mov` | `video/mp4` → `.mp4` |
| Code | `.js`, `.ts`, `.py`, `.java` | `text/javascript` → `.js` |
| Data | `.json`, `.xml`, `.yaml` | `application/json` → `.json` |

Unknown types default to `.dat` extension.

## W3C Compliance

Full support for W3C representation metadata:

```typescript
const stored = await store.store(content, {
  mediaType: 'text/html',
  language: 'en-US',
  encoding: 'UTF-8',
  rel: 'original'
});

// W3C-compliant metadata
{
  "@id": "urn:sha256:abc123...",
  "@type": "Representation",
  "checksum": "sha256:abc123...",
  "mediaType": "text/html",
  "language": "en-US",
  "encoding": "UTF-8",
  "rel": "original",
  "byteSize": 1234,
  "created": "2024-01-01T00:00:00Z"
}
```

## Performance

- **SHA-256 Calculation**: ~500 MB/s on modern CPUs
- **Write Performance**: Limited by filesystem (typically ~100 MB/s)
- **Read Performance**: O(1) direct path lookup
- **Sharding**: 65,536 directories prevent filesystem bottlenecks
- **Deduplication**: 100% space savings for duplicate content

## Best Practices

1. **Use Buffers**: Always pass content as Buffer for binary safety
2. **Specify MIME Types**: Required for proper file extensions
3. **Add Language Metadata**: Important for multilingual content
4. **Handle Missing Content**: Check existence before retrieval
5. **Monitor Storage**: Track disk usage and shard distribution

## Error Handling

```typescript
try {
  const retrieved = await store.retrieve(checksum, mediaType);
} catch (error) {
  if (error.code === 'ENOENT') {
    // Content not found
  } else if (error.code === 'EACCES') {
    // Permission denied
  } else {
    // Other filesystem error
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build package
npm run build

# Run tests
npm test

# Type checking
npm run typecheck
```

## License

Apache-2.0