# Filesystem Storage Patterns

## Overview

The backend uses filesystem-based storage for all document and annotation data, with PostgreSQL used only for user authentication.

## Storage Architecture

```
dataDir/
├── representations/          # Content-addressed document storage
│   └── {mediaType}/         # Organized by MIME type
│       └── {shard}/         # 4-hex sharding
│           └── rep-{checksum}.{ext}
├── events/                  # Immutable event log
│   └── {shard}/            # Resource-based sharding
│       └── {resourceId}/
│           └── events-{seq}.jsonl
├── views/                   # Materialized current state
│   └── {shard}/
│       └── {resourceId}.json
└── jobs/                    # Job queue
    ├── pending/
    ├── running/
    ├── complete/
    └── failed/
```

## Content-Addressed Storage

Document content is stored by SHA-256 checksum:

### Storage Path
```typescript
// Checksum: sha256:abcd1234...
// Path: representations/text~1plain/ab/cd/rep-abcd1234.txt
```

### Benefits
- Automatic deduplication
- Content integrity verification
- Efficient storage utilization

See [@semiont/content](../../../packages/content/docs/API.md) for implementation details.

## Event Storage

Events stored as append-only JSONL files:

### File Structure
```jsonl
{"event":{"id":"evt-123","type":"resource.created",...},"metadata":{...}}
{"event":{"id":"evt-124","type":"annotation.added",...},"metadata":{...}}
```

### Sharding Strategy
- 4-hex sharding (65,536 shards)
- Jump consistent hash distribution
- File rotation at 10,000 events

See [@semiont/event-sourcing](../../../packages/event-sourcing/docs/) for details.

## View Storage

Materialized views stored as JSON files:

### Resource View
```json
{
  "@context": "https://schema.org/",
  "@id": "http://localhost:4000/resources/doc-123",
  "name": "Document Title",
  "representations": [{
    "checksum": "sha256:abc123...",
    "mediaType": "text/plain"
  }],
  "annotations": [...]
}
```

## Job Queue Storage

Filesystem-based job queue with atomic operations:

### State Transitions
```
pending/ → running/ → complete/
                   ↘ failed/
```

### Atomic Operations
- Use file moves for state changes
- Leverage filesystem atomicity
- No external dependencies

See [@semiont/jobs](../../../packages/jobs/docs/API.md) for implementation.

## Platform Variations

### Local Development (POSIX)
```javascript
{
  "filesystem": {
    "platform": { "type": "posix" },
    "path": "./data"
  }
}
```

### Docker Containers
```javascript
{
  "filesystem": {
    "platform": { "type": "container" },
    "path": "/data",
    "volume": "semiont-data"
  }
}
```

### AWS Production
```javascript
{
  "filesystem": {
    "platform": { "type": "aws" },
    "s3Bucket": "semiont-data",
    "efsId": "fs-12345678"
  }
}
```

## Performance Considerations

### Sharding
- 65,536 shards prevent directory size issues
- Jump hash ensures uniform distribution
- Supports millions of resources

### Caching
- Views cached in memory with TTL
- Checksum lookup table for deduplication
- Event sequence tracking per resource

### File Rotation
- Events rotate at 10,000 entries
- Old jobs cleaned after retention period
- Completed views archived periodically

## Backup Strategy

### What to Backup
1. **Critical**: `representations/` - Document content
2. **Critical**: `events/` - Complete history
3. **Optional**: `views/` - Can rebuild from events
4. **Optional**: `jobs/complete/` - Historical records

### Backup Commands
```bash
# Local backup
rsync -av dataDir/ backup/

# S3 backup
aws s3 sync dataDir/ s3://backup-bucket/

# Incremental backup
rsync -av --link-dest=backup/latest dataDir/ backup/$(date +%Y%m%d)/
```

## Disaster Recovery

### Rebuild from Events
```typescript
// Rebuild all views from event log
await eventStore.rebuildAllViews();

// Rebuild graph from events
await graphConsumer.rebuildAll();
```

### Verify Integrity
```bash
# Check event chain integrity
find dataDir/events -name "*.jsonl" -exec \
  node scripts/verify-event-chain.js {} \;

# Verify content checksums
find dataDir/representations -type f -exec \
  node scripts/verify-checksum.js {} \;
```

## Monitoring

### Disk Usage
```bash
# Monitor storage growth
du -sh dataDir/*

# Find large files
find dataDir -type f -size +10M

# Check shard distribution
for dir in dataDir/events/*/; do
  echo "$(basename $dir): $(find $dir -type f | wc -l) files"
done
```

### Performance Metrics
- Write latency per operation
- Read cache hit rate
- Shard distribution uniformity
- File rotation frequency

## Related Documentation

- [Event Store Architecture](../../../packages/event-sourcing/docs/ARCHITECTURE.md)
- [Content Storage API](../../../packages/content/docs/API.md)
- [Job Queue Patterns](../../../packages/jobs/docs/API.md)
- [Database Guide](./DATABASE.md) - User authentication only