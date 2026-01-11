# Content Storage API Reference

## Overview

The `@semiont/content` package provides content-addressed storage using SHA-256 checksums, enabling automatic deduplication and integrity verification.

## RepresentationStore Interface

### Initialization

```typescript
import { FilesystemRepresentationStore } from '@semiont/content';

const store = new FilesystemRepresentationStore({
  basePath: '/data/storage'
});
```

### Storing Content

```typescript
// Store content (returns checksum and metadata)
const storedRep = await store.store(
  Buffer.from('Document content'),
  {
    mediaType: 'text/plain',
    language: 'en',
    rel: 'original'
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

### Retrieving Content

```typescript
// Get content by checksum
const buffer = await store.get('sha256:abc123...');

// Convert to string for text content
const text = buffer.toString('utf-8');
```

### Managing Content

```typescript
// Check if content exists
const exists = await store.exists('sha256:abc123...');

// Delete content
await store.delete('sha256:abc123...');
```

## Content Addressing

### How It Works

1. **Input**: Content buffer (any format)
2. **Calculate**: SHA-256 checksum
3. **Determine**: File extension from MIME type
4. **Store**: At path based on checksum

### Storage Path Structure

```
basePath/
└── representations/
    ├── text~1plain/
    │   └── ab/
    │       └── cd/
    │           └── rep-abcd1234.txt
    ├── text~1markdown/
    │   └── 5a/
    │       └── aa/
    │           └── rep-5aaa0b72.md
    └── image~1png/
        └── ff/
            └── ff/
                └── rep-ffff8888.png
```

Path components:
- `representations/` - Namespace
- `text~1plain/` - URL-encoded media type
- `ab/cd/` - 4-hex sharding from checksum
- `rep-abcd1234.txt` - Filename with checksum and extension

## W3C Representation Model

### StoredRepresentation

```typescript
interface StoredRepresentation {
  checksum: string;      // SHA-256 checksum
  mediaType: string;     // MIME type
  language?: string;     // ISO language code
  rel?: string;          // Relationship type
  size: number;          // Content size in bytes
}
```

### Multiple Representations

Store different representations of the same resource:

```typescript
// Store original
const original = await store.store(
  Buffer.from('Original text'),
  { mediaType: 'text/plain', rel: 'original' }
);

// Store translation
const translation = await store.store(
  Buffer.from('Texto original'),
  { mediaType: 'text/plain', rel: 'translation', language: 'es' }
);

// Store derived format
const markdown = await store.store(
  Buffer.from('# Original text'),
  { mediaType: 'text/markdown', rel: 'derived' }
);
```

## Deduplication

### Automatic Deduplication

Identical content is stored only once:

```typescript
const rep1 = await store.store(
  Buffer.from('Same content'),
  { mediaType: 'text/plain' }
);

const rep2 = await store.store(
  Buffer.from('Same content'),
  { mediaType: 'text/plain' }
);

console.log(rep1.checksum === rep2.checksum); // true
// Only one file on disk
```

### Storage Efficiency

```typescript
// Example: 100 documents with identical content
// Traditional: 100 files × 10KB = 1MB
// Content-addressed: 1 file × 10KB = 10KB
// Space saved: 99%
```

## Binary Content

### Storing Binary Files

```typescript
import { readFileSync } from 'fs';

// Store image
const imageBuffer = readFileSync('photo.jpg');
const imageRep = await store.store(imageBuffer, {
  mediaType: 'image/jpeg'
});

// Store PDF
const pdfBuffer = readFileSync('document.pdf');
const pdfRep = await store.store(pdfBuffer, {
  mediaType: 'application/pdf'
});
```

### Retrieving Binary Content

```typescript
const imageBuffer = await store.get(imageRep.checksum);
// Use buffer directly or save to file
writeFileSync('retrieved.jpg', imageBuffer);
```

## Checksum Utilities

### Calculate Checksum

```typescript
import { calculateChecksum } from '@semiont/content';

const checksum = calculateChecksum(Buffer.from('content'));
console.log(checksum); // sha256:abc123...
```

### Verify Integrity

```typescript
import { verifyChecksum } from '@semiont/content';

const isValid = await verifyChecksum(
  buffer,
  'sha256:abc123...'
);

if (!isValid) {
  throw new Error('Content corrupted');
}
```

## Sharding Strategy

### 4-Hex Sharding

Uses first 4 hex characters of checksum for directory structure:

```typescript
// Checksum: sha256:abcd1234...
// Path: ab/cd/rep-abcd1234...

// Provides 65,536 shards (16^4)
// Uniform distribution via SHA-256
```

### Jump Consistent Hash

```typescript
import { getShardPath } from '@semiont/content';

const shardPath = getShardPath('sha256:abc123...');
// Returns: 'ab/c1'
```

## Error Handling

```typescript
try {
  const content = await store.get(checksum);
} catch (error) {
  if (error.code === 'ENOENT') {
    // Content not found
  } else if (error.code === 'EACCES') {
    // Permission denied
  } else if (error.code === 'ENOSPC') {
    // No space left on device
  } else {
    // Other error
  }
}
```

## Performance Characteristics

### Operation Complexity

- **Store**: O(1) - SHA-256 calculation + write
- **Get**: O(1) - Direct path calculation
- **Exists**: O(1) - Filesystem stat
- **Delete**: O(1) - Direct path calculation

### Checksum Performance

- SHA-256 calculation: ~500 MB/s (typical)
- Small files (<1KB): Negligible overhead
- Large files (>10MB): Consider streaming

## Best Practices

1. **Buffer Management**: Use streams for large files
2. **Error Handling**: Always handle missing content gracefully
3. **Cleanup**: Implement reference counting for safe deletion
4. **Monitoring**: Track storage usage and shard distribution
5. **Backup**: Regular backups of content directory