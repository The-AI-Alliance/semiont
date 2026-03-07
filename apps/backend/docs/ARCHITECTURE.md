# Backend Architecture

This document describes the architectural patterns and design principles that govern the Semiont backend.

## Infrastructure Management

### Centralized Infrastructure Pattern

**All infrastructure components are created once and managed by MakeMeaningService.**

This is a **critical architectural constraint** that must be followed throughout the backend codebase.

#### The Rule

```typescript
// ✅ CORRECT: Access infrastructure via MakeMeaningService
const { eventStore, graphDb, repStore, inferenceClient } = c.get('makeMeaning');

// ❌ WRONG: NEVER create infrastructure in routes or services
const graphDb = await getGraphDatabase(config);              // VIOLATION
const repStore = new FilesystemRepresentationStore(...);     // VIOLATION
const eventStore = createEventStore(...);                    // VIOLATION
const inferenceClient = await getInferenceClient(config);   // VIOLATION
```

#### What MakeMeaningService Owns

The `MakeMeaningService` created in [src/index.ts:56](../src/index.ts#L56) via `startMakeMeaning()` owns **all infrastructure**.

See [@semiont/make-meaning](../../../packages/make-meaning/) for the implementation of `startMakeMeaning()` and detailed infrastructure ownership documentation.

**Infrastructure Components:**

1. **EventStore** - Event log and materialized views
   - Single source of truth for all data
   - Manages event subscription and view materialization
   - Created once, shared across entire application

2. **GraphDatabase** - Graph database connection
   - Provides relationship traversal and backlinks
   - Single connection pool shared across requests
   - Automatically synchronized via GraphDBConsumer

3. **RepresentationStore** - Content-addressed document storage
   - Stores all document content using content hashing
   - Deduplication and efficient retrieval
   - Single instance prevents duplicate file operations

4. **InferenceClient** - LLM inference client
   - Connection to AI model provider (OpenAI, Anthropic, etc.)
   - Request pooling and rate limiting
   - Shared configuration and API keys

5. **JobQueue** - Background job processing
   - Filesystem-based job queue
   - Atomic job operations
   - Shared across all background workers

6. **Workers** - Background job processors (6 types)
   - ReferenceDetectionWorker
   - GenerationWorker
   - HighlightDetectionWorker
   - AssessmentDetectionWorker
   - CommentDetectionWorker
   - TagDetectionWorker

7. **GraphDBConsumer** - Event-to-graph synchronization
   - Subscribes to event store
   - Updates graph database on resource/annotation changes
   - Maintains graph consistency

#### Implementation Pattern

**Backend Initialization** ([src/index.ts:56](../src/index.ts#L56)):

```typescript
// Create MakeMeaningService ONCE at startup
const makeMeaning = await startMakeMeaning(config);

// Inject into Hono context for all routes
app.use('*', async (c, next) => {
  c.set('makeMeaning', makeMeaning);
  await next();
});
```

**Route Pattern**:

```typescript
router.get('/resources/:id', async (c) => {
  // ✅ Get infrastructure from context
  const { eventStore, graphDb, repStore } = c.get('makeMeaning');

  // Use infrastructure
  const resource = await graphDb.getResource(resourceUri);
  const content = await repStore.retrieve(checksum, mediaType);
  await eventStore.appendEvent(event);

  return c.json(response);
});
```

**Service Pattern** (Dependency Injection):

```typescript
// Service receives infrastructure as parameters
export class ResourceOperations {
  static async createResource(
    input: CreateResourceInput,
    user: User,
    eventStore: EventStore,        // Injected
    repStore: RepresentationStore,  // Injected
    config: EnvironmentConfig
  ): Promise<CreateResourceResponse> {
    // Use injected infrastructure
    const storedRep = await repStore.store(content, metadata);
    await eventStore.appendEvent(event);
  }
}

// Route calls service with infrastructure from context
router.post('/resources', async (c) => {
  const { eventStore, repStore } = c.get('makeMeaning');
  const response = await ResourceOperations.createResource(
    input,
    user,
    eventStore,  // Pass from context
    repStore,    // Pass from context
    config
  );
  return c.json(response);
});
```

#### Why This Pattern Matters

**1. Prevents Resource Leaks**
- Single database connection instead of one per request
- No duplicate file handles or network sockets
- Controlled lifecycle with `makeMeaning.stop()`

**2. Ensures Consistent State**
- All components use the same configuration
- No configuration drift between instances
- Centralized connection pooling

**3. Simplifies Testing**
- Single injection point for mocking
- Consistent test setup across all tests
- Easy to swap implementations

**4. Clear Ownership**
- No ambiguity about who creates/destroys resources
- Explicit dependency flow through constructor/parameters
- Easier to reason about system initialization

**5. Performance**
- Connection pooling and reuse
- Shared caches across requests
- Reduced initialization overhead

#### Verification

To verify compliance with this pattern:

```bash
# Check for violations in routes
grep -r "new FilesystemRepresentationStore\|await getGraphDatabase\|await getInferenceClient\|createEventStore(" \
  apps/backend/src/routes --include="*.ts"

# Check for violations in services
grep -r "new FilesystemRepresentationStore\|await getGraphDatabase\|await getInferenceClient\|createEventStore(" \
  apps/backend/src/services --include="*.ts"

# Should return no results (all matches should be in test files only)
```

#### Common Violations and Fixes

**❌ Violation 1: Creating GraphDatabase in route**
```typescript
// WRONG
router.get('/resources/:id/references', async (c) => {
  const graphDb = await getGraphDatabase(config);  // VIOLATION
  const refs = await graphDb.getResourceReferences(id);
});
```

**✅ Fix: Access from context**
```typescript
// CORRECT
router.get('/resources/:id/references', async (c) => {
  const { graphDb } = c.get('makeMeaning');  // ✅
  const refs = await graphDb.getResourceReferences(id);
});
```

**❌ Violation 2: Creating RepresentationStore in service**
```typescript
// WRONG
class MyService {
  static async process(input: Input, config: EnvironmentConfig) {
    const repStore = new FilesystemRepresentationStore(...);  // VIOLATION
    await repStore.store(content, metadata);
  }
}
```

**✅ Fix: Accept as parameter**
```typescript
// CORRECT
class MyService {
  static async process(
    input: Input,
    repStore: RepresentationStore,  // Injected parameter
    config: EnvironmentConfig
  ) {
    await repStore.store(content, metadata);
  }
}

// Route passes from context
router.post('/process', async (c) => {
  const { repStore } = c.get('makeMeaning');
  await MyService.process(input, repStore, config);  // ✅
});
```

**❌ Violation 3: Creating InferenceClient for one-off use**
```typescript
// WRONG
async function generateSummary(text: string, config: EnvironmentConfig) {
  const client = await getInferenceClient(config);  // VIOLATION
  return await client.generateText(prompt);
}
```

**✅ Fix: Accept as parameter**
```typescript
// CORRECT
async function generateSummary(
  text: string,
  inferenceClient: InferenceClient,  // Injected parameter
  config: EnvironmentConfig
) {
  return await inferenceClient.generateText(prompt);
}

// Route passes from context
router.post('/summarize', async (c) => {
  const { inferenceClient } = c.get('makeMeaning');
  const summary = await generateSummary(text, inferenceClient, config);  // ✅
});
```

## Related Documentation

- [Make-Meaning Package](../../../packages/make-meaning/) - Implementation of MakeMeaningService
- [Event Sourcing Package](../../../packages/event-sourcing/) - EventStore implementation
- [Graph Package](../../../packages/graph/) - GraphDatabase implementation
- [Content Package](../../../packages/content/) - RepresentationStore implementation
- [Inference Package](../../../packages/inference/) - InferenceClient implementation

---

**Last Updated**: 2026-01-29
