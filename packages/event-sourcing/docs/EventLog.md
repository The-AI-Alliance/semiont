# EventLog - Event Persistence Layer

The `EventLog` class handles event persistence using append-only JSONL files. It provides **single responsibility**: event storage only.

**Does NOT handle:**
- Pub/sub notifications (see EventBus)
- View updates (see ViewManager)

## Creating an EventLog

```typescript
import { EventLog } from '@semiont/event-sourcing';

const eventLog = new EventLog({
  basePath: './data',
  dataDir: './data/events',
  enableSharding: true,
  maxEventsPerFile: 10000,
});
```

### Configuration

- `basePath` - Base directory for all data
- `dataDir` - Directory for event JSONL files
- `enableSharding` - Enable automatic file sharding (default: true)
- `maxEventsPerFile` - Max events before file rotation (default: 10000)

## Appending Events

```typescript
import { resourceId, userId } from '@semiont/core';

const storedEvent = await eventLog.append(
  {
    type: 'resource.created',
    resourceId: resourceId('doc-abc123'),
    userId: userId('user@example.com'),
    payload: {
      name: 'My Document',
      format: 'text/plain',
      contentChecksum: 'sha256:...',
      entityTypes: [],
    },
  },
  resourceId('doc-abc123')
);
```

### What Happens on Append

1. **Generate metadata** - Assign sequence number, timestamp, checksum
2. **Write to JSONL** - Append event as single line to file
3. **Return stored event** - Event with full metadata

The append operation is **atomic** - either the full event is written or nothing is written.

## Retrieving Events

### Get All Events for a Resource

```typescript
const events = await eventLog.getEvents(resourceId('doc-abc123'));

// Returns: StoredEvent[]
// [
//   {
//     event: {
//       id: 'evt-1',
//       type: 'resource.created',
//       timestamp: '2024-01-01T00:00:00Z',
//       resourceId: 'doc-abc123',
//       userId: 'user@example.com',
//       payload: { /* ... */ }
//     },
//     metadata: {
//       sequenceNumber: 1,
//       checksum: 'sha256:...',
//       version: '1.0'
//     }
//   }
// ]
```

Events are returned in **sequence order** (oldest to newest).

### Get All Resource IDs

```typescript
const resourceIds = await eventLog.getAllResourceIds();

// Returns: ResourceId[]
// ['doc-abc123', 'doc-def456', ...]
```

This scans the event directory and returns all resource IDs that have events.

## Querying Events

Filter events with `EventQuery`:

```typescript
import type { EventQuery } from '@semiont/core';

const query: EventQuery = {
  eventTypes: ['resource.created', 'annotation.added'],
  fromSequence: 10,
  toSequence: 100,
  fromTimestamp: '2024-01-01T00:00:00Z',
  toTimestamp: '2024-12-31T23:59:59Z',
  userId: userId('user@example.com'),
};

const filtered = await eventLog.queryEvents(resourceId('doc-abc123'), query);
```

### Query Filters

All filters are **ANDed** together (all must match):

| Filter | Type | Description |
|--------|------|-------------|
| `eventTypes` | `string[]` | Only return these event types |
| `fromSequence` | `number` | Events with sequence >= this value |
| `toSequence` | `number` | Events with sequence <= this value |
| `fromTimestamp` | `string` | Events after this ISO timestamp |
| `toTimestamp` | `string` | Events before this ISO timestamp |
| `userId` | `UserId` | Events by this user only |

### Query Examples

**Recent events:**

```typescript
const recent = await eventLog.queryEvents(resourceId('doc-123'), {
  fromTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
});
```

**Specific event types:**

```typescript
const annotations = await eventLog.queryEvents(resourceId('doc-123'), {
  eventTypes: ['annotation.added', 'annotation.deleted'],
});
```

**User-specific events:**

```typescript
const userEvents = await eventLog.queryEvents(resourceId('doc-123'), {
  userId: userId('alice@example.com'),
});
```

**Sequence range:**

```typescript
const range = await eventLog.queryEvents(resourceId('doc-123'), {
  fromSequence: 10,
  toSequence: 20,
});
```

## Storage Format

### JSONL Files

Events are stored as **JSONL** (JSON Lines) - one event per line:

```
data/events/ab/cd/doc-abc123.jsonl
```

Each line is a complete `StoredEvent`:

```json
{"event":{"id":"evt-1","type":"resource.created","timestamp":"2024-01-01T00:00:00Z","resourceId":"doc-abc123","userId":"user@example.com","payload":{}},"metadata":{"sequenceNumber":1,"checksum":"sha256:...","version":"1.0"}}
{"event":{"id":"evt-2","type":"annotation.added","timestamp":"2024-01-02T00:00:00Z","resourceId":"doc-abc123","userId":"user@example.com","payload":{}},"metadata":{"sequenceNumber":2,"checksum":"sha256:...","version":"1.0"}}
```

### Sharding

When `enableSharding: true`, files are distributed across 65,536 shards using **Jump Consistent Hash**:

```
data/events/
  00/
    00/doc-xyz.jsonl
    01/doc-abc.jsonl
    ...
  01/
    00/doc-def.jsonl
    ...
  ff/
    ff/doc-ghi.jsonl
```

This prevents filesystem bottlenecks when storing millions of resources.

### File Rotation

When `maxEventsPerFile` is reached, a new file is created:

```
doc-abc123.jsonl          ← Active file
doc-abc123.jsonl.1        ← Rotated file
doc-abc123.jsonl.2        ← Older rotated file
```

**Note:** File rotation is not yet implemented - all events go to a single file per resource.

## Event Metadata

Every stored event includes metadata:

```typescript
interface StoredEvent {
  event: ResourceEvent;  // The actual event
  metadata: {
    sequenceNumber: number;    // Monotonic counter (1, 2, 3, ...)
    checksum: string;          // SHA-256 hash of event
    version: string;           // Event format version ('1.0')
  };
}
```

### Sequence Numbers

Sequence numbers are **per-resource** and start at 1:

```typescript
// First event for doc-123
{ metadata: { sequenceNumber: 1 } }

// Second event for doc-123
{ metadata: { sequenceNumber: 2 } }

// First event for doc-456 (different resource)
{ metadata: { sequenceNumber: 1 } }
```

Sequence numbers enable:
- **Ordering** - Events processed in exact order
- **Gap detection** - Missing sequence numbers indicate data loss
- **Idempotency** - Prevent duplicate processing

### Checksums

Each event has a SHA-256 checksum of its content:

```typescript
const checksum = sha256(JSON.stringify(event));
// "sha256:a1b2c3d4..."
```

Checksums enable:
- **Integrity verification** - Detect corruption
- **Content-addressable IDs** - Reference events by hash
- **Deduplication** - Detect identical events

## Performance

### Read Performance

- **Sequential reads** - JSONL is optimized for sequential access
- **Indexed by resource ID** - O(1) file lookup with sharding
- **In-memory filtering** - Queries filter after loading (fast for small event counts)

### Write Performance

- **Append-only** - No updates, only appends (fast)
- **No indexes** - No index maintenance overhead
- **Buffered writes** - Node.js buffers I/O automatically

### Sharding Benefits

Without sharding (1 directory):

```
events/                    ← 1,000,000 files in one directory!
  doc-1.jsonl
  doc-2.jsonl
  ...
  doc-1000000.jsonl
```

With sharding (65,536 directories):

```
events/
  00/00/doc-1.jsonl       ← ~15 files per directory
  00/01/doc-2.jsonl
  ...
```

Sharding keeps directory sizes manageable and filesystem operations fast.

## Error Handling

### File System Errors

```typescript
try {
  await eventLog.append(event, resourceId);
} catch (error) {
  if (error.code === 'ENOENT') {
    // Directory doesn't exist
  } else if (error.code === 'EACCES') {
    // Permission denied
  } else if (error.code === 'ENOSPC') {
    // Disk full
  }
  throw error;
}
```

### Corrupted Events

If a JSONL file is corrupted, `getEvents()` will throw:

```typescript
try {
  const events = await eventLog.getEvents(resourceId);
} catch (error) {
  // Invalid JSON in JSONL file
  console.error('Corrupted event log:', error);
}
```

**Recovery:** Restore from backup or manually fix the JSONL file.

## Best Practices

### 1. Use Sharding in Production

```typescript
// ✅ Good - Sharding enabled
const log = new EventLog({ enableSharding: true, /* ... */ });

// ❌ Bad - Single directory (doesn't scale)
const log = new EventLog({ enableSharding: false, /* ... */ });
```

### 2. Set Appropriate maxEventsPerFile

```typescript
// ✅ Good - Reasonable limit
const log = new EventLog({ maxEventsPerFile: 10000, /* ... */ });

// ❌ Bad - Too many events per file (slow reads)
const log = new EventLog({ maxEventsPerFile: 1000000, /* ... */ });
```

### 3. Query with Filters

```typescript
// ✅ Good - Filtered query
const events = await log.queryEvents(resourceId, {
  eventTypes: ['annotation.added'],
  fromSequence: lastProcessed,
});

// ❌ Bad - Load all events then filter in app code
const allEvents = await log.getEvents(resourceId);
const filtered = allEvents.filter(e => e.event.type === 'annotation.added');
```

### 4. Use Checksums for Integrity

```typescript
import { sha256 } from '@semiont/event-sourcing';

const event = await log.getEvents(resourceId)[0];
const actualChecksum = sha256(JSON.stringify(event.event));

if (actualChecksum !== event.metadata.checksum) {
  console.error('Event corrupted!');
}
```

## Advanced Usage

### Manual Event Log Inspection

```bash
# View events for a resource
cat data/events/ab/cd/doc-abc123.jsonl | jq

# Count events
wc -l data/events/ab/cd/doc-abc123.jsonl

# Get last event
tail -1 data/events/ab/cd/doc-abc123.jsonl | jq
```

### Backup and Restore

```bash
# Backup event logs
tar -czf events-backup.tar.gz data/events/

# Restore
tar -xzf events-backup.tar.gz
```

### Event Log Migration

To migrate event logs to a new storage system:

```typescript
async function migrateEvents(oldLog: EventLog, newLog: EventLog) {
  const resourceIds = await oldLog.getAllResourceIds();

  for (const id of resourceIds) {
    const events = await oldLog.getEvents(id);

    for (const storedEvent of events) {
      await newLog.append(storedEvent.event, id);
    }
  }
}
```

## See Also

- [EventStore.md](./EventStore.md) - Orchestration layer
- [EventBus.md](./EventBus.md) - Pub/sub subscriptions
- [Configuration.md](./Configuration.md) - Setup options
