# Filesystem Service

File storage service for uploads, assets, and binary content in Semiont.

## Overview

The Filesystem service provides persistent storage for user-uploaded files, document attachments, and binary assets. It abstracts the underlying storage backend (local filesystem, AWS S3, EFS) with a unified interface.

**Service Type**: `posix` (local), `aws` (S3/EFS in production)

**Primary Use Cases**:
- Document file uploads (PDF, images, etc.)
- User profile images
- Generated document exports
- Temporary file storage

## Architecture

### Storage Layers

The filesystem integrates with Semiont's 4-layer architecture:

**Layer 1 (Content Store)**:
- Raw document binary/text files
- Sharded storage (65,536 shards via Jump Consistent Hash)
- Content-addressed with document IDs
- See [CONTENT-STORE.md](./CONTENT-STORE.md) for details

**Upload Directory**:
- Separate from content store
- User-uploaded files before processing
- Temporary staging area

### Directory Structure

```
data/
├── uploads/          # User uploads (managed by filesystem service)
│   ├── profiles/     # User profile images
│   ├── documents/    # Document attachments
│   └── temp/         # Temporary files
└── documents/        # Content store (Layer 1)
    └── shards/       # 65,536 sharded directories
        ├── 00/
        │   ├── 00/
        │   ├── 01/
        │   └── ...
        └── ff/
```

## Configuration

### Local Development

Configured in `environments/local.json`:

```json
{
  "filesystem": {
    "platform": {
      "type": "posix"
    },
    "path": "./data/uploads",
    "description": "Local filesystem storage for uploads and assets"
  }
}
```

### AWS Production

Uses S3 for uploads and EFS for content store:

```json
{
  "filesystem": {
    "platform": {
      "type": "aws"
    },
    "s3Bucket": "semiont-uploads-prod",
    "efsId": "fs-12345678",
    "mountPath": "/mnt/efs"
  }
}
```

**Environment Variables**:
- `AWS_REGION` - AWS region for S3/EFS
- `S3_BUCKET` - S3 bucket name for uploads
- `EFS_MOUNT_PATH` - EFS mount point for content store

## Key Features

### 1. File Upload

Handle multipart file uploads with validation:

**API Endpoint**: `POST /api/uploads` (future)

**Validation**:
- File type checking (MIME type)
- Size limits (configurable)
- Virus scanning (production)
- User quota enforcement

### 2. Sharded Content Storage

Efficient storage of document content files:

**Sharding Strategy**:
- Jump Consistent Hash (JCH) with 65,536 shards
- 4-hex directory structure (00/00 to ff/ff)
- O(1) lookup by document ID
- Balanced distribution

**File Organization**:
```
documents/shards/a3/4f/doc-a34f8901.dat  # Document binary
documents/shards/b2/1c/doc-b21c7623.txt  # Text content
```

See [CONTENT-STORE.md](./CONTENT-STORE.md) for complete details.

### 3. Temporary File Management

Handle temporary files with automatic cleanup:

**Use Cases**:
- Export generation
- File processing pipeline
- Thumbnail generation

**Cleanup Policy**:
- Files older than 24 hours deleted
- Orphaned files detected and removed
- Configurable retention period

## Storage Backends

### Local Filesystem (POSIX)

For local development and testing:

**Pros**:
- Simple setup
- Fast access
- No external dependencies

**Cons**:
- Not scalable
- No redundancy
- Single point of failure

### AWS S3

For production uploads:

**Pros**:
- Highly scalable
- Durable (99.999999999%)
- CDN integration (CloudFront)

**Cons**:
- Network latency
- API costs
- Eventual consistency

### AWS EFS

For production content store:

**Pros**:
- POSIX-compliant
- Shared across ECS tasks
- Automatic scaling

**Cons**:
- Higher cost than S3
- Regional availability
- Performance tiers

## Integration Points

### Content Store Integration

The filesystem service works with Layer 1 (Content Store):

**Content Manager**: [apps/backend/src/storage/content/content-manager.ts](../../apps/backend/src/storage/content/content-manager.ts)
- Handles document binary storage
- Manages sharding
- Provides streaming access

**Storage Implementation**: [apps/backend/src/storage/content/content-storage.ts](../../apps/backend/src/storage/content/content-storage.ts)
- File I/O operations
- Shard path calculation
- Error handling

### Upload Handling

**Backend Routes**: [apps/backend/src/routes/uploads/](../../apps/backend/src/routes/uploads/)
- Multipart upload handling
- Validation and sanitization
- Temporary file management

## Performance

### Sharding Benefits

- **O(1) Lookup**: Direct path calculation from document ID
- **Balanced Load**: Even distribution across shards
- **Filesystem Limits**: Avoid directory entry limits (typically 32K-64K)
- **Parallel Access**: Multiple shards enable concurrent I/O

### Caching Strategy

- **Read-Through Cache**: Frequently accessed files cached in memory
- **Write-Through**: Immediate persistence with async cache update
- **Invalidation**: Content-addressed, so immutable (no invalidation needed)

### Streaming

All file operations support streaming:
- Memory-efficient for large files
- Progressive download/upload
- Backpressure handling

## Security

### Access Control

- User-scoped uploads (only owner can access)
- Signed URLs for temporary access (S3)
- Path traversal prevention
- Symlink attack mitigation

### Encryption

**At Rest**:
- EFS encryption enabled (AWS KMS)
- S3 SSE-S3 or SSE-KMS
- Local: filesystem-level encryption

**In Transit**:
- HTTPS for all uploads/downloads
- TLS 1.2+ required

### Validation

- MIME type verification
- File extension allow-list
- Content scanning (ClamAV in production)
- Size limit enforcement

## CLI Management

The Filesystem service is managed via the Semiont CLI:

```bash
# Check filesystem status
semiont check --service filesystem --environment local

# Provision filesystem (creates directories, sets permissions)
semiont provision --service filesystem --environment local

# Backup filesystem
semiont backup --service filesystem --environment production
```

## Monitoring

### Metrics to Track

- **Disk Usage**: Total storage consumed
- **Shard Distribution**: Balance across shards
- **Upload Rate**: Files per second
- **Error Rate**: Failed uploads/downloads

### Alerts

- Disk space < 10% free
- Shard imbalance > 5% deviation
- High error rate (> 1%)
- Quota exceeded

## Troubleshooting

### Disk Space Issues

```bash
# Check usage by shard
du -sh data/documents/shards/*/* | sort -h

# Find large files
find data/documents -type f -size +100M
```

### Permission Problems

```bash
# Fix permissions on content store
chmod -R 755 data/documents/shards
chown -R app:app data/documents
```

### Orphaned Files

```bash
# Find files not referenced in database
# (Script in scripts/cleanup-orphaned-files.sh)
npm run cleanup:orphans
```

## Related Documentation

- [CONTENT-STORE.md](./CONTENT-STORE.md) - Layer 1 content storage details
- [Backend README](../../apps/backend/README.md) - API implementation
- [CLI Service Implementation](../../apps/cli/src/services/filesystem-service.ts) - CLI integration
- [AWS Deployment](../platforms/AWS.md) - S3 and EFS setup

---

**Service Type**: POSIX (local), AWS (production)
**Storage**: Local filesystem, AWS S3, AWS EFS
**Sharding**: 65,536 shards via Jump Consistent Hash
