# Job Worker Service

**Status**: Prototype Implementation (Not Yet a Proper Service)

**Purpose**: Background job processing for long-running AI operations

**Current Implementation**: Embedded in backend process

**Future State**: Standalone service with CLI integration and environment configuration

## Overview

The Job Worker service provides asynchronous background processing for computationally expensive AI operations that shouldn't block HTTP requests. Currently implemented as embedded workers within the backend process, this will eventually become a standalone service that can scale independently.

**What Works Today**:
- Filesystem-based job queue with atomic operations
- Two worker implementations (entity detection, document generation)
- Progress tracking and SSE streaming
- Retry logic and graceful shutdown
- Event emission to Layer 2 (Event Store)

**What's Missing**:
- CLI service integration (no environment config)
- Independent deployment (currently coupled to backend)
- Service lifecycle management (start/stop/check)
- Platform abstraction (POSIX, Container, AWS)
- Health checks and monitoring endpoints

## Current Architecture

### Job Queue (Filesystem-Based)

**Implementation**: [apps/backend/src/jobs/job-queue.ts](../../apps/backend/src/jobs/job-queue.ts)

**Storage Structure**:
```
data/jobs/
├── pending/       # Jobs waiting to be processed
├── running/       # Jobs currently being processed
├── complete/      # Successfully completed jobs
├── failed/        # Jobs that failed after retries
└── cancelled/     # Jobs cancelled by user or system
```

**Operations**:
- `createJob()` - Create new job in pending status
- `pollNextPendingJob()` - FIFO retrieval of next pending job
- `updateJobStatus()` - Atomic state transitions via filesystem moves
- `updateJobProgress()` - Best-effort progress updates for SSE streaming
- `listJobs()` - Filter and paginate jobs by status, type, userId
- `getStats()` - Queue metrics (pending, running, complete, failed, cancelled counts)
- `cleanupOldJobs()` - Remove completed/failed jobs older than retention period (default 24 hours)

**Key Characteristics**:
- **Atomic Operations**: Job state changes use atomic file moves
- **No External Dependencies**: Pure filesystem (no Redis, no database queue tables)
- **FIFO Processing**: Jobs processed in creation order
- **Automatic Retry**: Failed jobs retried up to `maxRetries` times
- **Self-Cleaning**: Old jobs automatically removed after retention period

### Worker Base Class

**Implementation**: [apps/backend/src/jobs/workers/job-worker.ts](../../apps/backend/src/jobs/workers/job-worker.ts)

**Abstract Worker Pattern**:
```typescript
abstract class JobWorker {
  abstract getWorkerName(): string;
  abstract canProcessJob(job: Job): boolean;
  abstract executeJob(job: Job): Promise<void>;

  async start(): Promise<void>;        // Polling loop
  async stop(): Promise<void>;         // Graceful shutdown
  protected async updateJobProgress(); // Progress tracking
}
```

**Worker Behavior**:
- **Polling Loop**: Continuously polls job queue at configurable intervals (default 1000ms)
- **Error Backoff**: Backs off for 5000ms on errors to avoid tight error loops
- **State Machine**: Handles `pending` → `running` → `complete`/`failed` transitions
- **Retry Handling**: Retries failed jobs up to `maxRetries` times before moving to `failed` status
- **Graceful Shutdown**: Waits up to 60 seconds for current job to complete before forcing shutdown
- **Progress Updates**: Provides `updateJobProgress()` for best-effort progress tracking without throwing

### Job Types

**Implementation**: [apps/backend/src/jobs/types.ts](../../apps/backend/src/jobs/types.ts)

#### DetectionJob

**Purpose**: Find entities in documents using AI inference

**Properties**:
```typescript
{
  id: string;                    // job-${nanoid()}
  type: 'detection';
  status: JobStatus;             // pending|running|complete|failed|cancelled
  userId: string;
  documentId: string;
  entityTypes: string[];         // Entity types to detect
  progress?: {
    totalEntityTypes: number;
    processedEntityTypes: number;
    currentEntityType?: string;
    entitiesFound: number;
    entitiesEmitted: number;
  };
  result?: {
    totalFound: number;
    totalEmitted: number;
    errors: number;
  };
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}
```

**Worker Implementation**: [apps/backend/src/jobs/workers/detection-worker.ts](../../apps/backend/src/jobs/workers/detection-worker.ts)

**Processing Flow**:
1. Fetch document content from RepresentationStore (Layer 1)
2. For each entity type:
   - Call AI inference to detect entities
   - Update progress with current entity type
3. For each detected annotation:
   - Generate W3C TextPositionSelector and TextQuoteSelector
   - Emit `annotation.added` event to Event Store (Layer 2)
4. Track total found, emitted, and errors in result
5. Mark job complete with final statistics

**API Endpoints**:
- `POST /api/documents/:id/detect-entities` - Create detection job
- `POST /api/documents/:id/detect-annotations-stream` - Create job and stream progress via SSE
- `GET /api/jobs/:jobId` - Get job status and progress

**Files**:
- Route: [apps/backend/src/routes/documents/routes/detect-entities.ts](../../apps/backend/src/routes/documents/routes/detect-entities.ts)
- Streaming: [apps/backend/src/routes/documents/routes/detect-annotations-stream.ts](../../apps/backend/src/routes/documents/routes/detect-annotations-stream.ts)

#### GenerationJob

**Purpose**: Generate new documents from annotations using AI

**Properties**:
```typescript
{
  id: string;                    // job-${nanoid()}
  type: 'generation';
  status: JobStatus;             // pending|running|complete|failed|cancelled
  userId: string;
  referenceId: string;           // Annotation ID that triggered generation
  sourceDocumentId: string;
  prompt?: string;               // Optional user-provided prompt
  title?: string;                // Optional document title
  entityTypes?: string[];        // Optional entity context
  language?: string;             // Optional language hint
  progress?: {
    stage: 'fetching' | 'generating' | 'creating' | 'linking';
    percentage: number;
    message?: string;
  };
  result?: {
    documentId: string;
    documentName: string;
  };
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
}
```

**Worker Implementation**: [apps/backend/src/jobs/workers/generation-worker.ts](../../apps/backend/src/jobs/workers/generation-worker.ts)

**Processing Flow**:
1. **Fetching Stage**: Fetch source annotation and document metadata (25% progress)
2. **Generating Stage**: Call AI inference to generate document content (50% progress)
3. **Creating Stage**: Save generated content to RepresentationStore (Layer 1), emit `document.created` event to Event Store (Layer 2) (75% progress)
4. **Linking Stage**: Emit `annotation.body.updated` event to link reference annotation to new document (100% progress)
5. Return `documentId` and `documentName` in job result

**API Endpoints**:
- `POST /api/annotations/:id/generate-document` - Create generation job
- `POST /api/annotations/:id/generate-document-stream` - Create job and stream progress via SSE
- `GET /api/jobs/:jobId` - Get job status and progress

**Files**:
- Route: [apps/backend/src/routes/annotations/routes/generate-document.ts](../../apps/backend/src/routes/annotations/routes/generate-document.ts)
- Streaming: [apps/backend/src/routes/annotations/routes/generate-document-stream.ts](../../apps/backend/src/routes/annotations/routes/generate-document-stream.ts)

### Startup and Initialization

**Backend Index**: [apps/backend/src/index.ts:308-345](../../apps/backend/src/index.ts)

```typescript
// Initialize Job Queue
await initializeJobQueue({ dataDir });

// Start Job Workers (non-blocking background tasks)
const detectionWorker = new DetectionWorker();
const generationWorker = new GenerationWorker();

detectionWorker.start().catch((error) => {
  console.error('Detection worker stopped with error:', error);
});

generationWorker.start().catch((error) => {
  console.error('Generation worker stopped with error:', error);
});
```

**Current Reality**: Workers start automatically when backend starts. No independent lifecycle control.

## Integration with Data Architecture

### Event Emission

Workers emit events to the Event Store (Layer 2):

**Detection Worker Events**:
- `annotation.added` - For each detected entity

**Generation Worker Events**:
- `document.created` - When new document is generated
- `annotation.body.updated` - To link reference annotation to new document

### Event-Driven Consumer

**Implementation**: [apps/backend/src/events/consumers/graph-consumer.ts](../../apps/backend/src/events/consumers/graph-consumer.ts)

The GraphDB Consumer subscribes to events emitted by workers and updates Layer 4 (Graph Database):

**Subscribed Events**:
- `document.created` - Add document vertex to graph
- `annotation.added` - Add annotation vertex and edges to graph
- `annotation.body.updated` - Update annotation edges (e.g., link to generated document)

**Pattern**: Workers → Event Store (L2) → Event Consumer → Graph DB (L4)

## Why This Is a Temporary Solution

### Current Limitations

1. **No CLI Integration**
   - Not defined in `apps/cli/src/services/`
   - Not configurable in `environments/*.json`
   - Can't be started/stopped independently

2. **No Platform Abstraction**
   - Runs only as embedded backend workers
   - Can't deploy to Container platform
   - Can't scale independently on AWS ECS
   - No support for external job queue services (Redis, SQS)

3. **No Health Checks**
   - No `/health` endpoint for workers
   - CLI `check` command can't monitor worker status
   - No metrics or observability

4. **Tight Coupling**
   - Workers live in backend process
   - Backend can't run without workers
   - Workers can't run without backend

5. **No Environment Config**
   - Hardcoded polling intervals
   - Hardcoded retry counts
   - No platform-specific configuration

### Future Proper Service Implementation

**What It Should Look Like**:

**CLI Service Definition**: `apps/cli/src/services/job-worker-service.ts`
```typescript
export class JobWorkerService extends Service {
  getServiceType(): ServiceType { return 'job-worker'; }
  // Platform-specific start/stop/check implementations
}
```

**Environment Configuration**: `environments/local.json`
```json
{
  "services": {
    "job-worker": {
      "platform": { "type": "posix" },
      "command": "npm run worker",
      "env": {
        "POLL_INTERVAL": "1000",
        "MAX_RETRIES": "3",
        "WORKER_TYPES": "detection,generation"
      }
    }
  }
}
```

**Production Configuration**: `environments/production.json`
```json
{
  "services": {
    "job-worker": {
      "platform": {
        "type": "aws",
        "taskDefinition": "semiont-job-worker",
        "desiredCount": 2
      },
      "env": {
        "QUEUE_TYPE": "sqs",
        "SQS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/..."
      }
    }
  }
}
```

**Independent Deployment**:
- Separate Docker image for workers
- ECS task definition for AWS
- Can scale workers independently of backend
- Can use Redis or SQS instead of filesystem queue

**CLI Commands**:
```bash
semiont start --service job-worker --environment local
semiont check --service job-worker --environment local
semiont stop --service job-worker --environment local
```

## Current API Endpoints

### Job Management

**Create Job** (via detection/generation endpoints):
- `POST /api/documents/:id/detect-entities`
- `POST /api/annotations/:id/generate-document`

**Get Job Status**:
- `GET /api/jobs/:jobId`

**Stream Job Progress**:
- `POST /api/documents/:id/detect-annotations-stream` (SSE)
- `POST /api/annotations/:id/generate-document-stream` (SSE)

**Response Format**:
```json
{
  "jobId": "job_abc123",
  "status": "running",
  "type": "detection",
  "progress": {
    "totalEntityTypes": 5,
    "processedEntityTypes": 2,
    "currentEntityType": "Person",
    "entitiesFound": 12,
    "entitiesEmitted": 12
  },
  "created": "2025-10-25T12:00:00Z",
  "startedAt": "2025-10-25T12:00:01Z"
}
```

### Missing Endpoints

**No Worker Health Endpoint**:
- Should have `GET /api/workers/health` or similar
- Should expose queue stats and worker status

**No Job Cancellation**:
- Should have `DELETE /api/jobs/:jobId` to cancel running jobs

**No Queue Management**:
- Should have `GET /api/jobs?status=pending&limit=10` for queue inspection

## Test Coverage

**Integration Tests**: [apps/backend/src/__tests__/integration/generate-document-stream.test.ts](../../apps/backend/src/__tests__/integration/generate-document-stream.test.ts)

Tests verify real job queue usage (not stubs) for document generation streaming.

## When Will This Become a Proper Service?

**Trigger**: When one of these happens:

1. **Scale Requirements**: Need to run workers on separate machines from backend
2. **Queue Backend Change**: Need to use Redis, SQS, or database queue instead of filesystem
3. **Worker Specialization**: Need different workers for different entity types or generation models
4. **Production Deployment**: AWS deployment requires ECS task definitions for workers

**Effort Required**:
- Extract worker code into standalone package/app
- Create CLI service definition
- Add platform implementations (POSIX, Container, AWS)
- Add health check endpoints
- Update environment configurations
- Document service management

**Timeline**: Not yet scheduled (prototype is sufficient for current needs)

## Related Documentation

### Job Processing Flow
- [Backend README](../../apps/backend/README.md) - Backend architecture overview
- [Event Store](./EVENT-STORE.md) - Layer 2 event log that workers write to
- [Graph Consumer](../../apps/backend/src/events/consumers/graph-consumer.ts) - Event subscription

### AI Integration
- [Inference Service](./INFERENCE.md) - LLM APIs used by workers
- [W3C Web Annotation](../../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation format for detected entities

### Service Architecture
- [Architecture Overview](../ARCHITECTURE.md) - Overall system design
- [CLI Service Management](../../apps/cli/README.md) - How proper services work
- [Adding Services](../../apps/cli/docs/ADDING_SERVICES.md) - How to add new service types

---

**Implementation**: [apps/backend/src/jobs/](../../apps/backend/src/jobs/)
**Status**: Prototype (embedded in backend)
**CLI Integration**: None (not yet a proper service)
**Last Updated**: 2025-10-25
