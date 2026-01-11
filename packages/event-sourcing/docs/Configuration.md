# Configuration Guide

This guide covers all configuration options for the event-sourcing package components.

## EventStore Configuration

The `EventStore` is the main entry point and orchestrates all components:

```typescript
import { EventStore, FilesystemViewStorage } from '@semiont/event-sourcing';

const eventStore = new EventStore({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
  eventLogConfig: {
    basePath: './data/events',
  },
  viewManagerConfig: {
    storage: new FilesystemViewStorage({
      basePath: './data/views',
    }),
  },
});
```

### EventStore Options

```typescript
interface EventStoreConfig {
  identifierConfig: IdentifierConfig;
  eventLogConfig?: EventLogConfig;
  viewManagerConfig?: ViewManagerConfig;
}
```

#### identifierConfig (required)

Configuration for converting IDs to HTTP URIs:

```typescript
interface IdentifierConfig {
  baseUrl: string;  // Base URL for HTTP URIs (e.g., 'http://localhost:4000')
}
```

**Example:**

```typescript
identifierConfig: {
  baseUrl: 'https://api.example.com',
}

// Converts:
// resourceId('doc-123') → 'https://api.example.com/resources/doc-123'
// annotationId('anno-456') → 'https://api.example.com/annotations/anno-456'
```

#### eventLogConfig (optional)

Configuration passed to EventLog:

```typescript
interface EventLogConfig {
  basePath: string;  // Directory for event storage (default: './data/events')
}
```

**Example:**

```typescript
eventLogConfig: {
  basePath: '/var/lib/semiont/events',
}
```

#### viewManagerConfig (optional)

Configuration passed to ViewManager:

```typescript
interface ViewManagerConfig {
  storage: ViewStorage;  // Storage implementation for views
}
```

**Example:**

```typescript
viewManagerConfig: {
  storage: new FilesystemViewStorage({
    basePath: '/var/lib/semiont/views',
  }),
}
```

### Default Configuration

EventStore provides sensible defaults:

```typescript
const eventStore = new EventStore({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
  // Uses defaults:
  // - eventLogConfig.basePath: './data/events'
  // - viewManagerConfig.storage: FilesystemViewStorage with './data/views'
});
```

## EventLog Configuration

EventLog can be used standalone:

```typescript
import { EventLog } from '@semiont/event-sourcing';

const eventLog = new EventLog({
  basePath: './data/events',
});
```

### EventLog Options

```typescript
interface EventLogConfig {
  basePath: string;  // Directory for JSONL event files
}
```

#### basePath

Directory where event files are stored:

```typescript
{
  basePath: './data/events'
}
```

**Creates structure:**

```
./data/events/
├── 00/
│   ├── 00/
│   │   └── events.jsonl
│   └── 01/
│       └── events.jsonl
└── ff/
    └── ff/
        └── events.jsonl
```

**Sharding:** Events are distributed across 65,536 shards (256 × 256) using jump consistent hash.

### Storage Requirements

**Disk Space:** Each event is ~0.5-5 KB depending on payload size.

```
1,000 events: ~1-5 MB
10,000 events: ~10-50 MB
100,000 events: ~100-500 MB
1,000,000 events: ~1-5 GB
```

**IOPS:** Append operations are sequential writes (fast).

**Permissions:** EventLog needs read/write access to basePath.

## EventBus Configuration

EventBus can be used standalone:

```typescript
import { EventBus } from '@semiont/event-sourcing';

const eventBus = new EventBus({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
});
```

### EventBus Options

```typescript
interface EventBusConfig {
  identifierConfig: IdentifierConfig;
}
```

#### identifierConfig (required)

Same as EventStore's identifierConfig - used for URI conversion:

```typescript
{
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
}
```

### Global Subscription Registry

EventBus uses a **global singleton** for subscriptions:

```typescript
// All EventBus instances share subscriptions
const bus1 = new EventBus({ identifierConfig: { baseUrl: 'http://localhost:4000' } });
const bus2 = new EventBus({ identifierConfig: { baseUrl: 'http://localhost:4000' } });

bus1.subscribe(resourceId('doc-123'), callback);

// bus2 sees the same subscription
console.log(bus2.getSubscriberCount(resourceId('doc-123')));  // 1
```

**Why:** Critical for SSE (Server-Sent Events) - all parts of the application must see the same subscribers.

## ViewManager Configuration

ViewManager can be used standalone:

```typescript
import { ViewManager, FilesystemViewStorage } from '@semiont/event-sourcing';

const viewManager = new ViewManager({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
  storage: new FilesystemViewStorage({
    basePath: './data/views',
  }),
});
```

### ViewManager Options

```typescript
interface ViewManagerConfig {
  identifierConfig: IdentifierConfig;
  storage: ViewStorage;
}
```

#### identifierConfig (required)

Same as EventStore's identifierConfig - used for URI conversion.

#### storage (required)

Storage implementation for materialized views:

```typescript
import { FilesystemViewStorage } from '@semiont/event-sourcing';

{
  storage: new FilesystemViewStorage({
    basePath: './data/views',
  }),
}
```

## Storage Configuration

### FilesystemViewStorage

Stores materialized views as JSON files:

```typescript
import { FilesystemViewStorage } from '@semiont/event-sourcing';

const storage = new FilesystemViewStorage({
  basePath: './data/views',
});
```

**Options:**

```typescript
interface FilesystemViewStorageConfig {
  basePath: string;  // Directory for view files
}
```

**Creates structure:**

```
./data/views/
├── system.json                    # System view (entity types, schemas)
└── resources/
    ├── 00/00/resource-abc123.json  # Resource views (sharded)
    ├── 01/42/resource-def456.json
    └── ff/ff/resource-xyz789.json
```

**Sharding:** Resource views are distributed across 65,536 shards using jump consistent hash.

### Custom Storage Implementation

Implement `ViewStorage` interface for custom backends:

```typescript
interface ViewStorage {
  getResourceView(uri: ResourceUri): Promise<ResourceView | null>;
  saveResourceView(view: ResourceView): Promise<void>;
  getSystemView(): Promise<SystemView>;
  saveSystemView(view: SystemView): Promise<void>;
}
```

**Example:** PostgreSQL storage

```typescript
class PostgresViewStorage implements ViewStorage {
  constructor(private pool: pg.Pool) {}

  async getResourceView(uri: ResourceUri): Promise<ResourceView | null> {
    const result = await this.pool.query(
      'SELECT data FROM resource_views WHERE uri = $1',
      [uri]
    );
    return result.rows[0]?.data || null;
  }

  async saveResourceView(view: ResourceView): Promise<void> {
    await this.pool.query(
      `INSERT INTO resource_views (uri, data)
       VALUES ($1, $2)
       ON CONFLICT (uri) DO UPDATE SET data = $2`,
      [view.resourceUri, view]
    );
  }

  async getSystemView(): Promise<SystemView> {
    const result = await this.pool.query(
      'SELECT data FROM system_view WHERE id = 1'
    );
    return result.rows[0]?.data || { entityTypes: [], tagSchemas: [] };
  }

  async saveSystemView(view: SystemView): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_view (id, data)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = $1`,
      [view]
    );
  }
}

// Use with ViewManager
const viewManager = new ViewManager({
  identifierConfig: { baseUrl: 'http://localhost:4000' },
  storage: new PostgresViewStorage(pgPool),
});
```

## Environment-Specific Configuration

### Development

```typescript
const eventStore = new EventStore({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
  eventLogConfig: {
    basePath: './data/events',
  },
  viewManagerConfig: {
    storage: new FilesystemViewStorage({
      basePath: './data/views',
    }),
  },
});
```

**Characteristics:**
- Local filesystem storage (fast, easy to inspect)
- Small basePath (relative to project)
- localhost baseUrl

### Production

```typescript
const eventStore = new EventStore({
  identifierConfig: {
    baseUrl: process.env.API_BASE_URL || 'https://api.example.com',
  },
  eventLogConfig: {
    basePath: process.env.EVENT_LOG_PATH || '/var/lib/semiont/events',
  },
  viewManagerConfig: {
    storage: new FilesystemViewStorage({
      basePath: process.env.VIEW_STORAGE_PATH || '/var/lib/semiont/views',
    }),
  },
});
```

**Characteristics:**
- Absolute paths for storage
- Environment variable configuration
- HTTPS baseUrl
- Persistent storage location

### Testing

```typescript
import { afterEach } from 'vitest';

const testEventStore = new EventStore({
  identifierConfig: {
    baseUrl: 'http://test',
  },
  eventLogConfig: {
    basePath: './test-data/events',
  },
  viewManagerConfig: {
    storage: new FilesystemViewStorage({
      basePath: './test-data/views',
    }),
  },
});

afterEach(async () => {
  // Clean up test data
  await fs.rm('./test-data', { recursive: true, force: true });
});
```

**Characteristics:**
- Separate test data directory
- Simple baseUrl
- Cleanup after tests

## Configuration Validation

### Required Fields

EventStore validates required configuration:

```typescript
// ❌ Missing baseUrl
const eventStore = new EventStore({
  identifierConfig: {},  // Error: baseUrl is required
});

// ✅ Valid configuration
const eventStore = new EventStore({
  identifierConfig: {
    baseUrl: 'http://localhost:4000',
  },
});
```

### Path Validation

Storage paths are validated on first use:

```typescript
const eventLog = new EventLog({
  basePath: '/nonexistent/path',
});

// Will create directory structure on first append
await eventLog.append(event);
```

**Permissions:** Ensure the process has write access to storage paths.

## Performance Tuning

### Sharding Configuration

Both event log and view storage use **65,536 shards** by default:

```typescript
// Jump consistent hash distributes across shards
const shard = jumpConsistentHash(resourceId, 65536);
```

**Why 65,536 shards?**

- Prevents filesystem bottlenecks (modern filesystems slow down with >1,000 files per directory)
- Balances distribution vs overhead (256 × 256 directory structure)
- Enables horizontal scaling (shards can be moved to different disks/nodes)

**Customization:** To change shard count, modify `shard-utils.ts` (requires code change).

### Storage Location

**Local Disk:**

```typescript
{
  basePath: './data/events'  // Fast for development
}
```

**Network Storage:**

```typescript
{
  basePath: '/mnt/nfs/semiont/events'  // Slower, but shared across nodes
}
```

**SSD vs HDD:**

- SSD: ~100-1000x faster random I/O (better for sharded storage)
- HDD: Cheaper per GB, acceptable for sequential event log appends

### Memory Usage

**EventLog:** Minimal memory usage (~1-10 MB)

**ViewManager:** Memory usage grows with view size:

```
Small resource (10 annotations): ~10 KB in memory
Medium resource (100 annotations): ~100 KB in memory
Large resource (1,000 annotations): ~1 MB in memory
```

**EventBus:** Memory usage grows with subscriber count:

```
100 subscriptions: ~100 KB in memory
1,000 subscriptions: ~1 MB in memory
10,000 subscriptions: ~10 MB in memory
```

## Security Configuration

### File Permissions

Set appropriate permissions on storage directories:

```bash
# Restrict access to semiont user
chown -R semiont:semiont /var/lib/semiont
chmod 700 /var/lib/semiont/events
chmod 700 /var/lib/semiont/views
```

### Base URL Security

**Development:**

```typescript
{
  baseUrl: 'http://localhost:4000'  // OK for local dev
}
```

**Production:**

```typescript
{
  baseUrl: 'https://api.example.com'  // Use HTTPS
}
```

**W3C Compliance:** The Web Annotation Model requires HTTP(S) URIs for `@id` fields.

## Backup Configuration

### Event Log Backup

Events are **immutable** and **append-only** - ideal for backup:

```bash
# Incremental backup (copy only new/changed files)
rsync -av --ignore-existing /var/lib/semiont/events/ /backup/events/

# Full backup
tar -czf events-backup-$(date +%Y%m%d).tar.gz /var/lib/semiont/events/
```

### View Storage Backup

Views can be **rebuilt from events** - backup is optional:

```bash
# Backup views (faster recovery)
rsync -av /var/lib/semiont/views/ /backup/views/
```

**Recovery:** Views can always be rebuilt from event log:

```typescript
// Delete corrupted views
await fs.rm('./data/views', { recursive: true });

// Replay events to rebuild
const events = await eventLog.getAllEvents();
for (const event of events) {
  await viewManager.applyEvent(event);
}
```

## Monitoring Configuration

### Metrics to Track

**Event Log:**
- Events per second (append rate)
- Event log size on disk
- Shard distribution (events per shard)

**View Storage:**
- View size (bytes per resource)
- View query latency (ms)
- View update latency (ms)

**EventBus:**
- Active subscriptions count
- Events published per second
- Callback error rate

### Health Checks

```typescript
// Check if storage is writable
async function healthCheck() {
  try {
    // Test event append
    const testEvent = createTestEvent();
    await eventLog.append(testEvent);

    // Test view query
    const systemView = await viewManager.getSystemView();

    return { status: 'healthy' };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}
```

## Migration and Upgrades

### Changing Storage Location

```bash
# Move event log
mv /var/lib/semiont/events /mnt/ssd/semiont/events

# Update configuration
{
  eventLogConfig: {
    basePath: '/mnt/ssd/semiont/events'
  }
}
```

### Changing Base URL

When migrating to a new domain:

```typescript
// Old configuration
{
  baseUrl: 'http://old-domain.com'
}

// New configuration
{
  baseUrl: 'https://new-domain.com'
}
```

**Impact:** All new URIs will use new base URL. Existing URIs in events remain unchanged.

### Storage Format Changes

Event storage format is **stable** - no migration needed across versions.

If format changes:
1. Read old events with old format
2. Write new events with new format
3. Both formats can coexist

## Troubleshooting

### Permission Denied

**Error:** `EACCES: permission denied, mkdir '/var/lib/semiont/events'`

**Solution:** Ensure process has write access:

```bash
chown -R $USER /var/lib/semiont
```

### Disk Full

**Error:** `ENOSPC: no space left on device`

**Solution:**
1. Check disk usage: `df -h`
2. Archive old events: `tar -czf archive.tar.gz /var/lib/semiont/events/00/`
3. Delete old shards if safe
4. Increase disk capacity

### Slow Queries

**Symptom:** `getResourceView()` taking >1 second

**Causes:**
- Very large views (>10 MB)
- Network storage latency
- Filesystem issues

**Solutions:**
- Use SSD storage
- Implement view pagination
- Cache frequently accessed views
- Consider database-backed storage

## See Also

- [EventStore.md](./EventStore.md) - Main orchestration layer
- [EventLog.md](./EventLog.md) - Event persistence details
- [EventBus.md](./EventBus.md) - Pub/sub notifications
- [Views.md](./Views.md) - Materialized views
