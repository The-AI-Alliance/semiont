# Real-Time Event Architecture

**Purpose**: Server-Sent Events (SSE) streaming architecture for delivering real-time updates from backend Event Store to frontend subscribers with <50ms latency.

**Related Documentation**:
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Event Store and event sourcing
- [Detection](../../docs/ai/DETECTION.md) - Real-time annotation detection
- [Generation](../../docs/ai/GENERATION.md) - Real-time resource generation

## Overview

Semiont uses Server-Sent Events (SSE) to push real-time updates from the backend Event Store to frontend clients. This enables:

- **Annotation updates** appear in document viewers immediately (<50ms)
- **Progress tracking** for long-running jobs (detection, generation)
- **Multi-tab synchronization** - changes in one tab appear in others instantly
- **No polling** - persistent connections eliminate constant HTTP requests

## Architecture Components

### Event Flow

```
Event Source (Worker/Route)
    ↓
Event Store (append event)
    ↓
Event Bus (broadcast to subscribers)
    ↓
SSE Streams (one per resource per client)
    ↓
Frontend SSE Client (EventSource wrapper)
    ↓
React Query Cache Invalidation
    ↓
UI Update (automatic re-render)
```

### Resource-Scoped Subscriptions

Events are scoped to specific resources, not broadcast globally:

- **Resource URI**: `http://localhost:8080/resources/doc-123`
- **SSE Endpoint**: `GET /resources/doc-123/events/stream`
- **Events Received**: All events for `doc-123` (annotations, jobs, document changes)
- **Subscribers**: Multiple clients can subscribe to same resource (multi-tab, collaborative editing)

**Why Resource-Scoped?**
- Scalability: Clients only receive events they care about
- Security: Authorization enforced at subscription time
- Efficiency: Backend maintains separate event streams per resource

## Backend Implementation

### SSE Streaming Endpoint

**File**: [src/routes/resources/routes/events-stream.ts](../src/routes/resources/routes/events-stream.ts)

**Route**: `GET /resources/:id/events/stream`

**Responsibilities**:
1. Validate resource exists and user has read access
2. Subscribe to Event Store for resource-specific events
3. Stream events via SSE with Hono's `streamSSE()`
4. Handle keep-alive pings (30-second interval)
5. Clean up subscription on client disconnect

**Key Implementation Details**:

```typescript
// Subscribe to Event Store for this resource
const unsubscribe = eventSubscriptions.subscribe(rUri, (storedEvent) => {
  // Write event to SSE stream
  await stream.writeSSE({
    data: JSON.stringify(storedEvent.event),
    event: storedEvent.event.type,
    id: storedEvent.metadata.sequenceNumber.toString(),
  });
});

// Keep-alive ping every 30 seconds
const keepAliveInterval = setInterval(() => {
  stream.writeSSE({ data: '', event: 'keep-alive' });
}, 30000);

// Cleanup on disconnect
stream.onAbort(() => {
  unsubscribe();
  clearInterval(keepAliveInterval);
});
```

### Event Store Broadcasting

**File**: [packages/event-sourcing/src/event-bus.ts](../../packages/event-sourcing/src/event-bus.ts)

**Mechanism**:
1. Worker/route emits event via `eventStore.append()`
2. Event persisted to append-only log
3. Event Store broadcasts to all subscribers for that resource
4. Each subscriber's callback receives the event
5. SSE stream writes event to client

**Example Event Emission**:

```typescript
// Worker emits annotation.body.updated
await eventStore.append({
  type: 'annotation.body.updated',
  resourceId: sourceResourceId,
  payload: {
    annotationId: referenceId,
    operations: [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: newResourceUri,
        purpose: 'linking'
      }
    }]
  }
});
```

**Broadcast Flow**:
```
append() → Event Store → notify subscribers → SSE writeSSE() → client
```

## Frontend Implementation

### SSE Client Hook

**File**: [packages/react-ui/src/hooks/useResourceEvents.ts](../../packages/react-ui/src/hooks/useResourceEvents.ts)

**Usage**:

```typescript
const { status, isConnected } = useResourceEvents({
  rUri: resourceUri('http://localhost:8080/resources/doc-123'),
  onAnnotationAdded: (event) => {
    queryClient.invalidateQueries(['annotations', rUri]);
  },
  onAnnotationBodyUpdated: (event) => {
    queryClient.invalidateQueries(['annotations', rUri]);
  }
});
```

**Features**:
- Auto-connect on mount (configurable)
- Event Handler Refs Pattern for stable callbacks
- Automatic reconnection with exponential backoff
- Connection state tracking (`connecting`, `connected`, `disconnected`, `error`)
- Event-specific handlers for different event types

### Event Handler Refs Pattern

**Problem**: Event handler props change on re-render, causing `useEffect` cleanup to disconnect SSE, then reconnect, missing events in between.

**Solution**: Store handlers in refs, sync refs on every render, use refs in stable callbacks:

```typescript
// Store handlers in refs
const onAnnotationAddedRef = useRef(onAnnotationAdded);
const onAnnotationBodyUpdatedRef = useRef(onAnnotationBodyUpdated);

// Sync refs with latest props (no effect re-run)
useEffect(() => {
  onAnnotationAddedRef.current = onAnnotationAdded;
  onAnnotationBodyUpdatedRef.current = onAnnotationBodyUpdated;
});

// Stable callback with empty deps
const handleEvent = useCallback((event: ResourceEvent) => {
  // Use refs - always calls latest handler
  switch (event.type) {
    case 'annotation.added':
      onAnnotationAddedRef.current?.(event);
      break;
    case 'annotation.body.updated':
      onAnnotationBodyUpdatedRef.current?.(event);
      break;
  }
}, []); // Empty deps - never recreated!
```

**Why This Works**:
- Refs don't trigger re-renders or effect re-runs
- Refs always point to latest handler functions
- Callbacks stay stable across renders
- SSE connection stays alive

**Sources**:
- [React Docs: Removing Effect Dependencies](https://react.dev/learn/removing-effect-dependencies)
- [react-use-websocket library](https://github.com/robtaussig/react-use-websocket) uses this pattern

### Reconnection Strategy

**Immediate Reconnection** for transient network errors:

```typescript
// First reconnection: 100ms delay
// Subsequent: exponential backoff up to 30 seconds
const delay = reconnectAttemptsRef.current === 1
  ? 100
  : Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 2), 30000);
```

**No Reconnection** for permanent failures:
- 404 errors (resource not found)
- Authentication failures

### React Strict Mode Handling

**Problem**: React 18 Strict Mode double-mounts components in development, causing:
1. First mount → connect SSE
2. First unmount → disconnect SSE
3. Second mount → try to connect again
4. Guard blocks connection (connectingRef still true)

**Solution**: Reset `connectingRef` in `disconnect()`:

```typescript
const disconnect = useCallback(() => {
  if (streamRef.current) {
    streamRef.current.close();
    streamRef.current = null;
  }
  connectingRef.current = false; // CRITICAL: Reset for Strict Mode
  reconnectAttemptsRef.current = 0;
  setStatus('disconnected');
}, []);
```

## Proxy Configuration

### Envoy Timeout Settings

**File**: [apps/cli/templates/envoy.yaml](../../apps/cli/templates/envoy.yaml)

**Critical Configuration** (lines 68-72):

```yaml
- match:
    prefix: "/resources/"
  route:
    cluster: backend
    timeout: 0s  # No timeout for SSE long-lived connections
    idle_timeout: 3600s  # 1 hour idle timeout
```

**Why Needed**:
- Default 30-second timeout closes SSE connections prematurely
- `timeout: 0s` disables request timeout
- `idle_timeout: 3600s` allows 1-hour idle before disconnect
- SSE keep-alive pings (every 30s) prevent idle timeout

**Without This Fix**:
- SSE connections close after 30 seconds
- Frontend sees network error and reconnects
- Events emitted during reconnection are missed
- References don't resolve in real-time

## Event Types

### Annotation Events

**`annotation.added`**: New annotation created
```json
{
  "type": "annotation.added",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "annotationId": "/annotations/abc123",
    "annotation": { /* W3C annotation */ }
  }
}
```

**`annotation.removed`**: Annotation deleted
```json
{
  "type": "annotation.removed",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "annotationId": "/annotations/abc123"
  }
}
```

**`annotation.body.updated`**: Annotation body modified
```json
{
  "type": "annotation.body.updated",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "annotationId": "/annotations/abc123",
    "operations": [
      { "op": "add", "item": { "type": "SpecificResource", "source": "..." } }
    ]
  }
}
```

### Job Events

**`job.started`**: Long-running job initiated
```json
{
  "type": "job.started",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "jobId": "job-456",
    "jobType": "detection"
  }
}
```

**`job.progress`**: Job progress update
```json
{
  "type": "job.progress",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "jobId": "job-456",
    "status": "detecting-references",
    "percentage": 50
  }
}
```

**`job.completed`**: Job finished successfully
```json
{
  "type": "job.completed",
  "resourceId": "http://localhost:8080/resources/doc-123",
  "payload": {
    "jobId": "job-456",
    "result": { /* job-specific result */ }
  }
}
```

### Document Events

**`document.archived`**: Document archived
**`document.unarchived`**: Document restored
**`entitytag.added`**: Entity type tag added
**`entitytag.removed`**: Entity type tag removed

## Two-Stream Architecture

Some features use **two SSE streams** working together:

### Example: Resource Generation

1. **Generation Progress Stream** (job-specific)
   - Endpoint: `POST /resources/{id}/generate-resource-from-annotation-stream`
   - Purpose: Job progress updates (generating, creating, linking)
   - Lifecycle: Opens when generation starts, closes when complete
   - Events: `generation-started`, `generation-progress`, `generation-complete`

2. **Resource Events Stream** (document-wide)
   - Endpoint: `GET /resources/{id}/events/stream`
   - Purpose: All resource events (annotations, tags, jobs)
   - Lifecycle: Long-lived, stays open while document is viewed
   - Events: `annotation.body.updated`, `annotation.added`, etc.

**Why Two Streams?**
- Progress stream provides job-specific updates for modal UI
- Resource events stream updates document viewer in real-time
- When generation completes:
  - Progress stream sends `generation-complete` → modal closes
  - Resource events stream sends `annotation.body.updated` → reference icon updates

**Critical**: Both streams must stay alive during generation for real-time updates to work.

## React Query Integration

### Cache Invalidation

Frontend uses React Query for caching. SSE events trigger cache invalidation:

```typescript
const queryClient = useQueryClient();

useResourceEvents({
  rUri: resourceUri,
  onAnnotationBodyUpdated: (event) => {
    // Invalidate annotations cache
    queryClient.invalidateQueries(['annotations', resourceUri]);

    // React Query refetches in background
    // UI updates automatically when data arrives
  }
});
```

### Optimistic Updates

For immediate feedback, combine SSE with optimistic updates:

```typescript
// Optimistically update cache
queryClient.setQueryData(['annotations', rUri], (old) => {
  return [...old, newAnnotation];
});

// SSE event confirms and corrects if needed
onAnnotationAdded: (event) => {
  queryClient.invalidateQueries(['annotations', rUri]);
};
```

## Performance Characteristics

### Latency

**Event Emission to UI Update**: <50ms typical
- Event Store append: ~1ms
- Broadcast to subscribers: <1ms
- SSE write: ~1-5ms
- Network transmission: ~10-30ms (local)
- React Query invalidation + refetch: ~10ms
- UI re-render: ~5ms

**Keep-Alive Overhead**: Minimal
- Ping every 30 seconds
- ~10 bytes per ping
- Prevents proxy/firewall timeout

### Connection Scaling

**Per-Resource Subscriptions**:
- 1 SSE connection per document viewer per client
- Multiple tabs = multiple connections
- Collaborative editing: N users × M tabs = N×M connections
- Backend maintains separate stream per connection

**Memory Usage**:
- ~1-2 KB per SSE connection
- Event Store maintains subscriber list per resource
- No buffering of old events (new subscribers get events after subscribe)

## Debugging

### Frontend Console

Filter by `[ResourceEvents]` to see connection lifecycle:

```
[ResourceEvents] Connecting to SSE stream for resource http://localhost:8080/resources/doc-123
[ResourceEvents] Stream connected event received
[ResourceEvents] Received event: annotation.body.updated
```

### Backend Logs

Filter by `[EventStream]` to see server-side SSE activity:

```bash
tail -f apps/backend/logs/app.log | grep EventStream
```

Expected output:
```
[EventStream:stream-123] New SSE connection established for resource doc-123
[EventStream:stream-123] Received event annotation.body.updated, attempting to write
[EventStream:stream-123] Successfully wrote event to SSE stream in 2ms
[EventStream] Client disconnected
```

### Network Tab

1. Open DevTools → Network tab
2. Filter by "stream"
3. Find `/events/stream` request
4. Should show:
   - **Status**: 200 or "pending" (still connected)
   - **Type**: eventsource
   - **EventStream tab**: Lists all events received

### Common Issues

**Duplicate Connections**:
- Symptom: Multiple "Connecting to SSE stream" logs in quick succession
- Cause: Event handlers changing on re-render
- Fix: Verify Event Handler Refs Pattern is implemented

**Premature Disconnection**:
- Symptom: "Client disconnected" in backend logs during generation
- Cause: Envoy timeout or useEffect cleanup running
- Fix: Check Envoy config has `timeout: 0s`, verify refs pattern

**Missing Events**:
- Symptom: Backend logs "Successfully wrote event" but frontend doesn't receive it
- Cause: Event sent to old (closed) connection
- Fix: Ensure connection stays alive during operation

**404 Errors**:
- Symptom: SSE connection fails immediately with 404
- Cause: Resource doesn't exist or user lacks read access
- Fix: Verify resource ID and authentication

## Related Files

### Backend
- [src/routes/resources/routes/events-stream.ts](../src/routes/resources/routes/events-stream.ts) - SSE endpoint
- [packages/event-sourcing/src/event-bus.ts](../../packages/event-sourcing/src/event-bus.ts) - Event broadcasting
- [packages/event-sourcing/src/event-store.ts](../../packages/event-sourcing/src/event-store.ts) - Event persistence

### Frontend
- [packages/react-ui/src/hooks/useResourceEvents.ts](../../packages/react-ui/src/hooks/useResourceEvents.ts) - SSE client hook
- [packages/api-client/src/sse/stream.ts](../../packages/api-client/src/sse/stream.ts) - SSE stream wrapper
- [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts) - SSE client methods

### Configuration
- [apps/cli/templates/envoy.yaml](../../apps/cli/templates/envoy.yaml) - Envoy proxy config template

### Documentation
- [W3C Web Annotation Implementation](./W3C-WEB-ANNOTATION.md) - Event Store architecture
- [Detection](../../docs/ai/DETECTION.md) - Real-time annotation detection
- [Generation](../../docs/ai/GENERATION.md) - Real-time resource generation
