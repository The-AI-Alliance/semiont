# Job Workers

Annotation workers live in **[@semiont/jobs](../../jobs/README.md)**, not in this package. This document describes how they integrate with the make-meaning actor model.

## Overview

Workers poll the `JobQueue` for pending jobs and emit commands on the EventBus when they produce annotations or resources. The **Stower** actor handles all persistence — workers never call `eventStore.appendEvent()` directly.

Workers are **not** actors. They use a polling loop (from `JobWorker` base class in @semiont/jobs), not RxJS subscriptions. However, they emit the same EventBus commands as any other caller.

## Available Workers

| Worker | Job Type | What it does |
|--------|----------|-------------|
| `ReferenceAnnotationWorker` | `reference-annotation` | Detects entity references using AI inference |
| `GenerationWorker` | `generation` | Generates new resources from annotations |
| `HighlightAnnotationWorker` | `highlight-annotation` | Identifies key passages for highlighting |
| `AssessmentAnnotationWorker` | `assessment-annotation` | Generates evaluative assessments |
| `CommentAnnotationWorker` | `comment-annotation` | Generates explanatory comments |
| `TagAnnotationWorker` | `tag-annotation` | Detects structural role tags (IRAC, IMRAD, etc.) |

## Constructor Signature

All annotation workers follow the same pattern:

```typescript
constructor(
  jobQueue: JobQueue,
  config: EnvironmentConfig,
  inferenceClient: InferenceClient,
  eventBus: EventBus,
  contentFetcher: ContentFetcher,  // (not on GenerationWorker)
  logger: Logger,
)
```

`GenerationWorker` does not take a `ContentFetcher` — it fetches content differently.

## EventBus Integration

Workers emit commands on the EventBus. The Stower subscribes and handles persistence.

### Annotation Creation

Workers build a full W3C `Annotation` with `creator` and `created`, then emit `mark:create`:

```typescript
eventBus.get('mark:create').next({
  motivation: 'highlighting',
  selector: [...],
  body: [...],
  userId: job.metadata.userId,
  resourceId: job.params.resourceId,
  annotation,  // Full Annotation with creator/created
});
```

The `creator` is built from `JobMetadata` fields (`userName`, `userEmail`, `userDomain`) using `userToAgent()`.

### Job Lifecycle

Workers emit job lifecycle events via the EventBus:

```typescript
// Job started
eventBus.get('job:start').next({ jobId, resourceId, userId, jobType });

// Progress update
eventBus.get('job:report-progress').next({ jobId, resourceId, userId, jobType, progress });

// Job completed
eventBus.get('job:complete').next({ jobId, resourceId, userId, jobType, result });

// Job failed
eventBus.get('job:fail').next({ jobId, resourceId, userId, jobType, error });
```

The Stower translates these into domain events (`job.started`, `job.progress`, `job.completed`, `job.failed`) on the EventStore.

## Instantiation

Workers are created by `startMakeMeaning()` in [service.ts](../src/service.ts). The `ContentFetcher` is backed by the KB's ViewStorage and RepresentationStore:

```typescript
const contentFetcher: ContentFetcher = async (resourceId) => {
  const view = await kb.views.get(resourceId);
  if (!view) return null;
  const primaryRep = getPrimaryRepresentation(view.resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) return null;
  const buffer = await kb.content.retrieve(primaryRep.checksum, primaryRep.mediaType);
  if (!buffer) return null;
  return Readable.from([buffer]);
};
```

## See Also

- [@semiont/jobs README](../../jobs/README.md) — Job queue, worker base class, job types
- [@semiont/jobs Workers Guide](../../jobs/docs/Workers.md) — Building custom workers
- [Architecture](./architecture.md) — Actor model and data flow
