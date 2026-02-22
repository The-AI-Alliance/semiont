# Event Bridging: Make-Meaning → Frontend

This document explains how events flow from make-meaning workers through the backend SSE layer to the frontend, enabling real-time progress updates in the UI.

## Architecture Overview

```
┌─────────────────┐
│  Make-Meaning   │
│   (Workers)     │
│                 │
│  eventBus.scope │
│  (resourceId)   │
└────────┬────────┘
         │ Events emitted to resource-scoped channels
         ↓
┌─────────────────┐
│  EventBus       │
│  (Backend)      │
│                 │
│  Shared by      │
│  make-meaning   │
│  and backend    │
└────────┬────────┘
         │ SSE routes subscribe to channels
         ↓
┌─────────────────┐
│  Backend SSE    │
│  Routes         │
│                 │
│  /sse/resources │
│  /sse/detect-*  │
└────────┬────────┘
         │ HTTP SSE stream (Server-Sent Events)
         ↓
┌─────────────────┐
│  API Client     │
│  (Browser)      │
│                 │
│  EventSource    │
└────────┬────────┘
         │ Events forwarded to frontend EventBus
         ↓
┌─────────────────┐
│  EventBus       │
│  (Frontend)     │
│                 │
│  eventBus.scope │
│  (resourceId)   │
└────────┬────────┘
         │ React hooks subscribe
         ↓
┌─────────────────┐
│  React UI       │
│  Components     │
│                 │
│  useEffect()    │
└─────────────────┘
```

## Event Emission in Make-Meaning

Events are emitted using the shared EventBus instance that's passed to `startMakeMeaning()`.

### Worker Event Emission

Workers emit events to **resource-scoped channels** using `eventBus.scope(resourceId)`:

```typescript
// In ReferenceDetectionWorker (packages/make-meaning/src/jobs/reference-detection-worker.ts)
const resourceBus = this.eventBus.scope(resourceId);

// Lifecycle events
resourceBus.get('detection:started').next({
  resourceId,
  entityTypes: params.entityTypes
});

resourceBus.get('detection:progress').next({
  status: 'extracting',
  message: 'Analyzing content...',
  percentage: 50
});

resourceBus.get('detection:completed').next({
  resourceId,
  annotationCount: results.length
});

resourceBus.get('detection:failed').next({
  resourceId,
  error: error.message
});
```

### Job Queue Event Emission

The JobQueue emits job lifecycle events (packages/jobs/src/queue.ts):

```typescript
const resourceBus = this.eventBus.scope(job.params.resourceId);

resourceBus.get('job:queued').next({
  jobId: job.metadata.id,
  jobType: 'detect-references',
  resourceId: job.params.resourceId
});
```

### EventStore Event Emission

Domain events are emitted when events are appended (packages/event-sourcing/src/store.ts):

```typescript
const resourceBus = this.bus.scope(resourceId);

resourceBus.get('event:appended').next({
  resourceId,
  event: appendedEvent
});
```

## Event Bridging via Backend SSE

The backend provides SSE endpoints that subscribe to EventBus channels and stream events to HTTP clients.

### Resource Events Endpoint

**Route**: `GET /sse/resources/:id/events`

**Purpose**: Stream ALL events for a specific resource (generic monitoring)

**Implementation** (apps/backend/src/routes/sse/resource-events.ts):

```typescript
export async function resourceEventsSSE(
  req: Request,
  res: Response,
  eventBus: EventBus,
  resourceId: ResourceId
) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Get resource-scoped bus
  const resourceBus = eventBus.scope(resourceId);

  // Subscribe to all event types
  const subscriptions = [
    // Domain events
    resourceBus.get('event:appended').subscribe(event => {
      res.write(`event: event:appended\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),

    // Job events
    resourceBus.get('job:queued').subscribe(event => {
      res.write(`event: job:queued\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),

    // Detection lifecycle
    resourceBus.get('detection:started').subscribe(event => {
      res.write(`event: detection:started\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),
    resourceBus.get('detection:progress').subscribe(event => {
      res.write(`event: detection:progress\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),
    resourceBus.get('detection:completed').subscribe(event => {
      res.write(`event: detection:completed\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),

    // ... similar for generation, highlight, assessment, comment, tag
  ];

  // Cleanup on disconnect
  req.on('close', () => {
    subscriptions.forEach(sub => sub.unsubscribe());
  });
}
```

### Detection Job Endpoint

**Route**: `POST /sse/resources/:id/detect-references`

**Purpose**: Start detection job AND stream progress (task-specific)

**Implementation** (apps/backend/src/routes/sse/detect-references.ts):

```typescript
export async function detectReferencesSSE(
  req: Request,
  res: Response,
  eventBus: EventBus,
  resourceId: ResourceId,
  params: DetectionParams
) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const resourceBus = eventBus.scope(resourceId);

  // Subscribe to detection events
  const subscriptions = [
    resourceBus.get('detection:started').subscribe(event => {
      res.write(`event: detection:started\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),
    resourceBus.get('detection:progress').subscribe(event => {
      res.write(`event: detection:progress\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }),
    resourceBus.get('detection:completed').subscribe(event => {
      res.write(`event: detection:completed\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end(); // Close stream when complete
    }),
    resourceBus.get('detection:failed').subscribe(event => {
      res.write(`event: detection:failed\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end(); // Close stream on failure
    })
  ];

  // Enqueue the detection job
  await jobQueue.createJob({
    status: 'pending',
    metadata: {
      id: jobId(),
      type: 'detection',
      userId: req.user.id,
      created: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3
    },
    params: {
      resourceId,
      entityTypes: params.entityTypes
    }
  });

  // Cleanup on disconnect
  req.on('close', () => {
    subscriptions.forEach(sub => sub.unsubscribe());
  });
}
```

### Other SSE Endpoints

Similar patterns for:
- `POST /sse/resources/:id/detect-tags` - Tag detection
- `POST /sse/resources/:id/detect-highlights` - Highlight detection
- `POST /sse/resources/:id/detect-assessments` - Assessment detection
- `POST /sse/resources/:id/detect-comments` - Comment detection
- `POST /sse/resources/:id/generate` - Resource generation

## Frontend Event Reception

The frontend API client connects to SSE endpoints and forwards events to the frontend EventBus.

### SSE Client

**Implementation** (packages/api-client/src/sse-client.ts):

```typescript
export class SSEClient {
  // Generic resource events stream
  public resourceEvents(
    resourceUri: ResourceUri,
    options: SSERequestOptions
  ): EventSource {
    const rId = uriToResourceId(resourceUri);
    const url = `${this.baseUrl}/sse/resources/${rId}/events`;

    const eventSource = new EventSource(url, {
      headers: {
        Authorization: `Bearer ${options.auth?.token}`
      }
    });

    // Forward all events to frontend EventBus
    const resourceBus = options.eventBus.scope(rId);

    eventSource.addEventListener('event:appended', (e) => {
      resourceBus.get('event:appended').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('job:queued', (e) => {
      resourceBus.get('job:queued').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('detection:started', (e) => {
      resourceBus.get('detection:started').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('detection:progress', (e) => {
      resourceBus.get('detection:progress').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('detection:completed', (e) => {
      resourceBus.get('detection:completed').next(JSON.parse(e.data));
    });

    // ... similar for other event types

    return eventSource;
  }

  // Task-specific detection stream
  public detectReferences(
    resourceUri: ResourceUri,
    params: DetectionParams,
    options: SSERequestOptions
  ): EventSource {
    const rId = uriToResourceId(resourceUri);
    const url = `${this.baseUrl}/sse/resources/${rId}/detect-references`;

    const eventSource = new EventSource(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.auth?.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    });

    // Forward detection events to frontend EventBus
    const resourceBus = options.eventBus.scope(rId);

    eventSource.addEventListener('detection:started', (e) => {
      resourceBus.get('detection:started').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('detection:progress', (e) => {
      resourceBus.get('detection:progress').next(JSON.parse(e.data));
    });

    eventSource.addEventListener('detection:completed', (e) => {
      resourceBus.get('detection:completed').next(JSON.parse(e.data));
      eventSource.close();
    });

    eventSource.addEventListener('detection:failed', (e) => {
      resourceBus.get('detection:failed').next(JSON.parse(e.data));
      eventSource.close();
    });

    return eventSource;
  }
}
```

### React Hook Consumption

**Implementation** (packages/react-ui/src/hooks/useDetectionFlow.ts):

```typescript
export function useDetectionFlow(resourceId: ResourceId) {
  const eventBus = useEventBus();
  const [status, setStatus] = useState<'idle' | 'detecting' | 'complete'>('idle');
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    // Get resource-scoped EventBus
    const resourceBus = eventBus.scope(resourceId);

    // Subscribe to detection events
    const subscriptions = [
      resourceBus.get('detection:started').subscribe(() => {
        setStatus('detecting');
        setProgress(0);
      }),

      resourceBus.get('detection:progress').subscribe((event) => {
        setProgress(event.percentage || 0);
      }),

      resourceBus.get('detection:completed').subscribe(() => {
        setStatus('complete');
        setProgress(100);
      })
    ];

    return () => {
      subscriptions.forEach(sub => sub.unsubscribe());
    };
  }, [resourceId, eventBus]);

  return { status, progress };
}
```

## Event Types Reference

### Job Lifecycle Events

| Event Type | Emitted By | Payload |
|------------|------------|---------|
| `job:queued` | JobQueue | `{ jobId, jobType, resourceId }` |
| `job:started` | Worker | `{ jobId, resourceId }` |
| `job:completed` | Worker | `{ jobId, resourceId }` |
| `job:failed` | Worker | `{ jobId, resourceId, error }` |

### Detection Events

| Event Type | Emitted By | Payload |
|------------|------------|---------|
| `detection:started` | ReferenceDetectionWorker | `{ resourceId, entityTypes }` |
| `detection:progress` | ReferenceDetectionWorker | `{ status, message, percentage }` |
| `detection:completed` | ReferenceDetectionWorker | `{ resourceId, annotationCount }` |
| `detection:failed` | ReferenceDetectionWorker | `{ resourceId, error }` |

### Generation Events

| Event Type | Emitted By | Payload |
|------------|------------|---------|
| `generation:started` | GenerationWorker | `{ resourceId, annotationId }` |
| `generation:progress` | GenerationWorker | `{ status, message, percentage }` |
| `generation:completed` | GenerationWorker | `{ resourceId, generatedResourceId }` |
| `generation:failed` | GenerationWorker | `{ resourceId, error }` |

### Other Detection Types

Similar event patterns for:
- `highlight:*` - HighlightDetectionWorker
- `assessment:*` - AssessmentDetectionWorker
- `comment:*` - CommentDetectionWorker
- `tag:*` - TagDetectionWorker

### Domain Events

| Event Type | Emitted By | Payload |
|------------|------------|---------|
| `event:appended` | EventStore | `{ resourceId, event }` |

## Resource Scoping

All events use **resource-scoped channels** via `eventBus.scope(resourceId)`:

1. **Make-meaning emits**: `eventBus.scope(resourceId).get('detection:completed').next(data)`
2. **Backend subscribes**: `eventBus.scope(resourceId).get('detection:completed').subscribe(...)`
3. **Backend streams**: HTTP SSE to client
4. **Frontend receives**: HTTP SSE EventSource
5. **Frontend emits**: `eventBus.scope(resourceId).get('detection:completed').next(data)`
6. **React subscribes**: `eventBus.scope(resourceId).get('detection:completed').subscribe(...)`

### Benefits of Resource Scoping

- **Isolation**: Events for one resource don't leak to other resources
- **Efficiency**: No manual filtering - EventBus handles routing
- **Type Safety**: Channel names are defined in EventMap
- **Scalability**: Each resource's events are independent

## EventBus Lifecycle

### Backend EventBus

The backend creates a single EventBus and shares it with make-meaning:

```typescript
// In backend startup (apps/backend/src/index.ts)
const eventBus = new EventBus();
const makeMeaning = await startMakeMeaning(config, eventBus);

// Same EventBus is used by SSE routes
app.get('/sse/resources/:id/events', (req, res) => {
  resourceEventsSSE(req, res, eventBus, resourceId);
});
```

The backend owns the EventBus lifecycle:
- Created at backend startup
- Shared with make-meaning (passed to `startMakeMeaning()`)
- Used by SSE routes for subscriptions
- Destroyed at backend shutdown

### Frontend EventBus

The frontend creates its own separate EventBus in the browser:

```typescript
// In frontend root (apps/frontend/src/app/providers.tsx)
const eventBus = new EventBus();

<EventBusContext.Provider value={eventBus}>
  <App />
</EventBusContext.Provider>
```

The frontend EventBus is completely separate from the backend EventBus:
- Lives in browser memory
- Receives events via SSE HTTP stream
- Used by React hooks for UI updates
- Destroyed when app unmounts

## Key Implementation Details

1. **Two EventBuses**: Backend and frontend each have their own EventBus instance
2. **SSE as Bridge**: HTTP Server-Sent Events provide the network boundary
3. **Manual Forwarding**: SSE client manually forwards events from HTTP to frontend EventBus
4. **Shared Backend**: Make-meaning and backend SSE routes share the same EventBus
5. **Type Safety**: Event types defined in `@semiont/core` EventMap used throughout stack

## Example: End-to-End Flow

Let's trace a detection event from worker to UI:

```typescript
// 1. Worker emits (make-meaning/src/jobs/reference-detection-worker.ts)
const resourceBus = this.eventBus.scope(resourceId);
resourceBus.get('detection:completed').next({
  resourceId,
  annotationCount: 5
});

// 2. Backend SSE subscribes (backend/src/routes/sse/detect-references.ts)
const resourceBus = eventBus.scope(resourceId);
resourceBus.get('detection:completed').subscribe(event => {
  res.write(`event: detection:completed\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});

// 3. HTTP SSE stream sends to browser
// Content-Type: text/event-stream
// event: detection:completed
// data: {"resourceId":"abc123","annotationCount":5}

// 4. Frontend SSE client receives (api-client/src/sse-client.ts)
eventSource.addEventListener('detection:completed', (e) => {
  const data = JSON.parse(e.data);
  const resourceBus = options.eventBus.scope(data.resourceId);
  resourceBus.get('detection:completed').next(data);
  eventSource.close();
});

// 5. React hook updates UI (react-ui/src/hooks/useDetectionFlow.ts)
const resourceBus = eventBus.scope(resourceId);
resourceBus.get('detection:completed').subscribe((event) => {
  setStatus('complete');
  setAnnotationCount(event.annotationCount);
});
```

## Related Documentation

- [Real-Time Communication (SSE)](./REAL-TIME.md)
- [Architecture Overview](./ARCHITECTURE.md)
- [EventBus Scoping (root)](../../EVENT-BUS-SCOPING.md)
- [Job Event Emission (root)](../../JOB-EVENTS.md)
- [Make-Meaning Scripting](../../packages/make-meaning/docs/SCRIPTING.md)
