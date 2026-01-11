# Content-Addressed Storage

Understanding the content-addressing system used by @semiont/content.

## What is Content-Addressed Storage?

Content-addressed storage is a system where data is identified by its content rather than by location. The content itself determines its address through cryptographic hashing.

From [src/representation-store.ts](../src/representation-store.ts): The package uses SHA-256 checksums as content addresses.

## How It Works

### 1. Checksum as Address

When content is stored, a SHA-256 hash is computed:

```typescript
const content = Buffer.from('Hello, World!');
const checksum = calculateChecksum(content);
// checksum: "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"
```

This checksum becomes the filename and the content's unique identifier.

From [src/representation-store.ts](../src/representation-store.ts): The `store()` method computes checksums using `calculateChecksum()` from @semiont/core.

### 2. Content Determines Identity

Two pieces of content with identical bytes will ALWAYS have the same checksum:

```typescript
const content1 = Buffer.from('Same content');
const content2 = Buffer.from('Same content');

const stored1 = await store.store(content1, { mediaType: 'text/plain' });
const stored2 = await store.store(content2, { mediaType: 'text/plain' });

// Always true - same bytes = same address
stored1.checksum === stored2.checksum;
stored1['@id'] === stored2['@id'];
```

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): Tests verify checksum consistency in the "Content deduplication" test suite.

### 3. Location Independence

Content can be retrieved using only its checksum and media type, regardless of:
- When it was stored
- Who stored it
- What metadata was provided
- How many times it was stored

```typescript
// Store with metadata A
const stored = await store.store(content, {
  mediaType: 'text/plain',
  language: 'en',
  rel: 'original'
});

// Retrieve using only checksum + mediaType
const retrieved = await store.retrieve(stored.checksum, 'text/plain');
// Returns identical content
```

From [src/representation-store.ts](../src/representation-store.ts): The `retrieve()` method requires only checksum and mediaType parameters.

## Benefits

### Automatic Deduplication

Storing identical content multiple times creates only one file:

```typescript
// Store same content 1000 times
for (let i = 0; i < 1000; i++) {
  await store.store(
    Buffer.from('Repeated content'),
    { mediaType: 'text/plain' }
  );
}
// Result: Only ONE file on disk
```

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): The "should deduplicate identical content across different metadata" test verifies this behavior.

### Idempotent Operations

Storing is idempotent - repeated operations have no additional effect:

```typescript
const result1 = await store.store(content, metadata);
const result2 = await store.store(content, metadata);
const result3 = await store.store(content, metadata);

// All return same checksum
result1.checksum === result2.checksum === result3.checksum;
```

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): The "should be idempotent" test confirms this property.

### Integrity Verification

The checksum guarantees content integrity:

```typescript
// Store content
const stored = await store.store(content, { mediaType: 'text/plain' });

// Later: retrieve and verify
const retrieved = await store.retrieve(stored.checksum, 'text/plain');
const verifyChecksum = calculateChecksum(retrieved);

// If checksums match, content is guaranteed identical
verifyChecksum === stored.checksum; // Always true if not corrupted
```

### Efficient Caching

Content can be safely cached forever because:
- The checksum uniquely identifies the content
- Content at a checksum address NEVER changes
- If content changes, it gets a new checksum (new address)

### Immutability

Once stored, content at a checksum address is effectively immutable:
- Changing the content would change its checksum
- A new checksum means a new address
- The original content remains at its original address

## Storage Structure

Content is organized by checksum with sharding for filesystem efficiency:

```
basePath/
└── representations/
    └── text~1plain/              # Media type (/ encoded as ~1)
        └── df/                   # First 2 hex digits of checksum
            └── fd/               # Next 2 hex digits of checksum
                └── rep-dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f.txt
```

From [src/representation-store.ts](../src/representation-store.ts): The `store()` method creates this directory structure using the first 4 hex digits for sharding.

### Sharding Strategy

The first 4 hex characters (2 bytes) of the checksum create a two-level directory hierarchy:

```typescript
const checksum = "5aaa0b72abc123...";
const ab = checksum.substring(0, 2);  // "5a"
const cd = checksum.substring(2, 4);  // "aa"

// Path: .../5a/aa/rep-5aaa0b72abc123....ext
```

This provides:
- **Balanced distribution**: Uniform distribution across 65,536 possible directories (16^4)
- **Filesystem efficiency**: Avoids too many files in one directory
- **O(1) lookup**: Direct path calculation from checksum

From [src/representation-store.ts](../src/representation-store.ts): Both `store()` and `retrieve()` methods use identical sharding logic.

## Media Type Separation

Content is also separated by media type to enable:
- Proper file extensions for filesystem browsing
- Type-specific optimizations or policies
- Easier backup/migration of specific content types

```
representations/
├── text~1plain/        # Text files
├── text~1markdown/     # Markdown files
├── image~1png/         # PNG images
└── application~1json/  # JSON files
```

From [src/representation-store.ts](../src/representation-store.ts): The `encodeMediaType()` method converts MIME types to filesystem-safe paths.

## Checksum Format

Checksums are raw SHA-256 hex strings (64 hexadecimal characters):

```typescript
// Correct format
"dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

// NO prefix (old format, rejected)
"sha256:dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"
```

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): Tests verify checksum format matches `/^[0-9a-f]{64}$/` pattern.

## Comparison with Location-Based Storage

### Location-Based (Traditional)

```typescript
// Content identified by path
const path = "/files/document-v1.txt";
await writeFile(path, content);

// Problems:
// - Same content, different paths = duplication
// - Path changes break references
// - No integrity verification
// - Mutable (content at path can change)
```

### Content-Addressed (This Package)

```typescript
// Content identified by its hash
const stored = await store.store(content, metadata);
await retrieve(stored.checksum, mediaType);

// Benefits:
// - Same content always has same address
// - Address never changes
// - Automatic integrity verification
// - Immutable (checksum guarantees content)
```

## Use Cases

Content-addressed storage is ideal for:

1. **Resource Representations**: Store byte-level renditions of annotated resources
2. **Deduplication**: Automatically eliminate duplicate content
3. **Caching**: Safe permanent caching using checksum as cache key
4. **Version Control**: Each version gets unique address
5. **Distributed Systems**: Content can be verified across nodes
6. **IPFS Integration**: Compatible with IPFS content addressing model

## References

- Content-addressing concept: [IPFS Documentation](https://docs.ipfs.tech/concepts/content-addressing/)
- SHA-256 hashing: [NIST FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf)
- From [src/representation-store.ts](../src/representation-store.ts): Implementation uses Node.js crypto module via @semiont/core's calculateChecksum
