# Sharding Strategy

How @semiont/content distributes content across directories for filesystem efficiency.

## Overview

Sharding divides content into multiple directories to avoid filesystem performance degradation from too many files in a single directory.

From [src/representation-store.ts](../src/representation-store.ts): The package uses a two-level sharding scheme based on checksum prefixes.

## The Problem

Without sharding, all content would be stored in a single directory:

```
representations/text~1plain/
├── rep-0aaa...txt  (millions of files)
├── rep-0aab...txt
├── rep-0aac...txt
└── ... (continued)
```

**Issues**:
- Most filesystems slow down with >10,000 files per directory
- Directory listing operations become expensive
- File creation/deletion performance degrades
- Backup and recovery operations slow down

## The Solution: Two-Level Sharding

Content is distributed using the first 4 hexadecimal characters of the checksum:

```
representations/text~1plain/
├── 0a/              # First 2 hex digits
│   ├── aa/          # Next 2 hex digits
│   │   └── rep-0aaa...txt
│   ├── ab/
│   │   └── rep-0aab...txt
│   └── ...
├── 0b/
│   ├── aa/
│   └── ...
└── ...
```

From [src/representation-store.ts](../src/representation-store.ts): The sharding logic appears in both `store()` and `retrieve()` methods.

## Implementation

### Shard Extraction

```typescript
const checksum = "5aaa0b72abc123def456...";

// Extract first 4 hex characters
const ab = checksum.substring(0, 2);  // "5a"
const cd = checksum.substring(2, 4);  // "aa"

// Build path: basePath/representations/{mediaType}/5a/aa/rep-{checksum}.ext
```

From [src/representation-store.ts](../src/representation-store.ts): Lines 123-124 in `store()` and lines 163-164 in `retrieve()` extract shard paths.

### Directory Structure

```typescript
const filePath = path.join(
  this.basePath,
  'representations',
  mediaTypePath,     // e.g., "text~1plain"
  ab,                // "5a"
  cd,                // "aa"
  `rep-${checksum}${extension}`  // "rep-5aaa0b72...txt"
);
```

From [src/representation-store.ts](../src/representation-store.ts): Lines 127-134 construct the complete file path.

## Distribution Properties

### Total Shards

With 4 hexadecimal characters (0-9, a-f):
- First level: 16^2 = 256 directories
- Second level: 16^2 = 256 directories per first-level directory
- **Total**: 256 × 256 = **65,536 possible shard directories**

### Expected Distribution

For uniformly distributed SHA-256 checksums:

```
Total files: 1,000,000
Shards: 65,536
Files per shard: 1,000,000 / 65,536 ≈ 15 files

Total files: 10,000,000
Shards: 65,536
Files per shard: 10,000,000 / 65,536 ≈ 153 files
```

SHA-256 produces uniformly distributed hashes, ensuring balanced distribution across shards.

### Filesystem Impact

With 10 million files:
- **Without sharding**: 10,000,000 files in one directory
- **With sharding**: ~153 files per shard directory

Most filesystems handle <1,000 files per directory efficiently.

## Path Construction

### Complete Path Example

For checksum `5aaa0b72abc123...` and media type `text/markdown`:

```
/var/semiont/storage/               # basePath
  representations/                   # Fixed prefix
    text~1markdown/                  # Media type (/ → ~1)
      5a/                            # ab = checksum[0:2]
        aa/                          # cd = checksum[2:4]
          rep-5aaa0b72abc123....md   # Full checksum + extension
```

From [src/representation-store.ts](../src/representation-store.ts): The `encodeMediaType()` method (line 193) handles "/" → "~1" conversion.

### Automatic Directory Creation

Directories are created automatically on first storage:

```typescript
await fs.mkdir(path.dirname(filePath), { recursive: true });
```

From [src/representation-store.ts](../src/representation-store.ts): Line 137 creates the directory structure programmatically.

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): The "should create directory structure automatically" test verifies this behavior.

## Alternative Sharding Schemes

### Why Not More Levels?

```
# 3 levels (6 hex chars)
text~1plain/5a/aa/0b/rep-...
# 16^6 = 16,777,216 shards
```

**Downside**: Too many directories for typical use cases. Most systems won't need millions of shards.

### Why Not Fewer Levels?

```
# 1 level (2 hex chars)
text~1plain/5a/rep-...
# 16^2 = 256 shards
```

**Downside**: For large deployments, would still have too many files per directory.

### Why This Design?

Two levels with 4 hex characters provides:
- **Sufficient distribution**: 65,536 shards handles billions of files
- **Simple implementation**: Easy to understand and debug
- **Optimal filesystem performance**: Keeps directories under 1,000 files
- **Low overhead**: Not too many directory levels to traverse

From [src/representation-store.ts](../src/representation-store.ts): The implementation is kept simple with just `substring(0, 2)` and `substring(2, 4)`.

## Sharding by Media Type

Content is first separated by media type, then sharded by checksum:

```
representations/
├── text~1plain/
│   ├── 5a/aa/...
│   ├── 5a/ab/...
│   └── ...
├── text~1markdown/
│   ├── 5a/aa/...
│   └── ...
└── image~1png/
    ├── 5a/aa/...
    └── ...
```

**Benefits**:
- Type-specific file extensions
- Easier selective backup/migration
- Potential for type-specific policies
- Better filesystem browsing experience

From [src/representation-store.ts](../src/representation-store.ts): Media type path is constructed before sharding (line 115).

## Performance Characteristics

### Storage Operation

```
O(1) - Constant time
```

1. Compute checksum: O(n) where n = content size
2. Extract shard path: O(1) - simple substring operations
3. Create directories: O(1) - filesystem operation
4. Write file: O(n) where n = content size

**Total**: O(n) dominated by content I/O

### Retrieval Operation

```
O(1) - Constant time
```

1. Extract shard path: O(1) - substring operations
2. Read file: O(n) where n = content size

**Total**: O(n) dominated by content I/O

No searching or scanning required - direct path calculation.

## Filesystem Compatibility

### Tested On

The sharding scheme works correctly on:
- **macOS**: APFS, HFS+
- **Linux**: ext4, XFS, btrfs
- **Windows**: NTFS

From [src/__tests__/representation-store.test.ts](../src/__tests__/representation-store.test.ts): Tests run on all platforms via CI.

### Path Separators

Platform-specific path separators are handled by Node.js `path.join()`:

```typescript
path.join(basePath, 'representations', mediaType, ab, cd, filename)
// macOS/Linux: basePath/representations/...
// Windows: basePath\representations\...
```

From [src/representation-store.ts](../src/representation-store.ts): Uses Node.js `path` module throughout.

## Migration Considerations

### Changing Sharding Scheme

If the sharding scheme changes, existing content must be migrated:

```typescript
// Example migration from 2-level to 3-level
async function migrateSharding(store: FilesystemRepresentationStore) {
  // 1. Enumerate all existing files
  // 2. For each file:
  //    - Extract checksum from filename
  //    - Calculate new shard path
  //    - Move file to new location
  // 3. Remove empty old directories
}
```

**Important**: The current 2-level scheme is designed to be stable and unlikely to need changing.

### Backward Compatibility

Old sharding schemes can coexist during migration:

```typescript
async retrieve(checksum: string, mediaType: string): Promise<Buffer> {
  // Try new sharding first
  const newPath = buildNewPath(checksum, mediaType);
  if (await fileExists(newPath)) {
    return fs.readFile(newPath);
  }

  // Fall back to old sharding
  const oldPath = buildOldPath(checksum, mediaType);
  return fs.readFile(oldPath);
}
```

Currently not implemented as the sharding scheme has been stable.

## References

- Filesystem performance: [Linux Kernel Documentation](https://www.kernel.org/doc/html/latest/filesystems/directory-locking.html)
- Directory scalability: [ext4 directory indexing](https://ext4.wiki.kernel.org/index.php/Ext4_Disk_Layout#Directory_Entries)
- From [src/representation-store.ts](../src/representation-store.ts): Sharding implementation uses simple substring extraction for efficiency
