# Yield Flow

**Purpose**: Synthesize new resources from reference annotations using correlated context. A human may compose the new resource manually, or an AI agent may generate it — both paths create a new resource and link the reference annotation to it.

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Reference annotation structure
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store architecture
- [Real-Time Event Architecture](../../apps/backend/docs/REAL-TIME.md) - SSE streaming and event flow
- [Mark Flow](./MARK.md) - Annotation detection and creation
- [@semiont/make-meaning](../../packages/make-meaning/README.md) - Generation worker and detection API
- [Make-Meaning Job Workers](../../packages/make-meaning/docs/job-workers.md) - GenerationWorker implementation

## Overview

The Yield flow introduces new resources into the system. A document is uploaded, a page is loaded, or an AI agent produces a new resource — text or structured output — that is persisted to the knowledge base as a first-class W3C Resource. In the attention framework, yielding is the step that creates new objects available for subsequent annotation, linking, and navigation.

The Yield flow creates new resources from reference annotations (motivation: `linking`) that lack resolved content. A human can compose the resource manually via the compose page, or an AI agent can generate it from correlated context. The system:

1. Identifies unresolved reference annotations (empty body or stub SpecificResource)
2. Uses AI to generate contextually relevant content based on the reference text
3. Creates a new resource with the generated content
4. Updates the reference annotation body to link to the new resource
5. Broadcasts real-time updates via SSE so UI reflects changes immediately

**Supported Formats**: Currently available for text-based formats (`text/plain`, `text/markdown`). Generated resources are always created as `text/plain`. Support for generating from annotations in images and PDFs is planned for future releases

## Using the API Client

Generate a new resource from a reference annotation via SSE:

```typescript
import { SemiontApiClient } from '@semiont/api-client';

const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });

// First, correlate context for the annotation (see Gather flow)
const { context } = await client.getAnnotationLLMContext(
  resourceId, annotationId, { contextWindow: 2000 }
);

// Generate a new resource from the reference annotation
client.sse.generateResourceFromAnnotation(
  resourceId,
  annotationId,
  {
    title: 'Ouranos',
    language: 'en',
    context,
  },
  { eventBus }
);

// Progress and completion events auto-emit to the event bus:
//   yield:progress  — { status, percentage, message }
//   yield:finished  — { resourceId, resourceName }
//   yield:failed    — { error }
```

## Reference Annotation Structure

**Unresolved Reference** (needs generation):
```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "http://localhost:8080/annotations/abc123",
  "motivation": "linking",
  "target": {
    "type": "SpecificResource",
    "source": "http://localhost:8080/resources/doc-456",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 52,
        "end": 59
      },
      {
        "type": "TextQuoteSelector",
        "exact": "Ouranos",
        "prefix": "In the beginning, ",
        "suffix": " ruled the universe"
      }
    ]
  },
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Deity",
      "purpose": "tagging"
    }
  ]
}
```

**Resolved Reference** (after generation):
```json
{
  "body": [
    {
      "type": "TextualBody",
      "value": "Person",
      "purpose": "tagging"
    },
    {
      "type": "TextualBody",
      "value": "Deity",
      "purpose": "tagging"
    },
    {
      "type": "SpecificResource",
      "source": "http://localhost:8080/resources/generated-789",
      "purpose": "linking"
    }
  ]
}
```

## Yield Flow

```
User clicks "Generate" on reference annotation ❓
    ↓
Frontend → POST /resources/{sourceId}/generate-resource-from-annotation-stream
    ↓
Route validates request, creates job → submits to queue
    ↓
Route subscribes to job progress events (job-specific SSE)
    ↓
Worker picks up job from queue
    ↓
Worker generates content → creates resource → updates annotation
    ↓
Worker emits mark:update-body → EventBus → Stower persists → mark:body-updated
    ↓
Document viewer's SSE receives event → invalidates cache → refetches annotations
    ↓
UI updates: ❓ → 🔗 in real-time (<50ms latency)
```

## Backend Implementation

### Generation Route

**File**: [apps/backend/src/routes/resources/routes/generate-resource-from-annotation-stream.ts](../../apps/backend/src/routes/resources/routes/generate-resource-from-annotation-stream.ts)

**Request Body**:
```typescript
{
  referenceId: string;      // Annotation ID to generate from
  title?: string;           // Optional custom title
  language?: string;        // Content language (default: 'en')
  tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical';
  length?: 'brief' | 'moderate' | 'detailed';
  maxTokens?: number;       // Max LLM response tokens
}
```

**Responsibilities**:
1. Validate request body and authentication
2. Verify source resource and reference annotation exist
3. Create generation job and submit to queue
4. Subscribe to EventBus for job events
5. Forward progress events to client via SSE (<50ms latency)
6. Handle client disconnection (job continues running)

**SSE Event Types**:
- `generation-started`: Job initiated
- `generation-progress`: Status updates (generating content, creating resource, linking)
- `generation-complete`: Generation finished with new resource ID
- `generation-error`: Generation failed

### Generation Worker

The GenerationWorker is part of [@semiont/make-meaning](../../packages/make-meaning/docs/job-workers.md#generationworker) and handles AI-powered resource generation.

**File**: [packages/jobs/src/workers/generation-worker.ts](../../packages/jobs/src/workers/generation-worker.ts)

**Processing Stages**:

1. **Load Source Resource (20%)**
   - Fetch source resource from Materialized Views
   - Load reference annotation by ID
   - Extract reference text and context

2. **Generate Content (40-70%)**
   - Build generation prompt with reference text and context
   - Apply user parameters (tone, length, language)
   - Call AI inference using `generateResourceFromTopic()`
   - Parse and validate generated content

3. **Create Resource (85%)**
   - Store content in Content Store
   - Emit `yield:create` on EventBus → Stower persists to Event Store
   - Generate resource ID from content checksum

4. **Link Reference (95%)**
   - Build SpecificResource body linking to new resource
   - Emit `mark:update-body` on EventBus → Stower persists to Event Store
   - Domain event broadcasts to SSE subscribers (document viewers)

5. **Complete (100%)**
   - Emit `job:complete` event on EventBus with new resource ID
   - Frontend receives completion via generation progress SSE
   - Document viewer receives `mark:body-updated` via resource events SSE

See [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md#generationworker) for complete implementation details including dependency injection and error handling.

### AI Generation Prompt

The generation prompt is enriched with graph context from the [Gather flow](./GATHER.md) when available. This includes connected resources, citations, and an optional LLM-generated relationship summary.

**Prompt Structure**:
```
You are generating content for a reference to "{referenceText}" in a document.

Context from source document:
{surrounding text from source document}

Entity types: {comma-separated entity type tags}

Knowledge graph context:
- Connected resources: {names of connected resources}
- Cited by: {names of citing resources}
- Related entity types: {sibling entity types from graph neighborhood}
- Relationship summary: {inferredRelationshipSummary, if available}

Generate {length} content in a {tone} tone about "{referenceText}".

The generated content should:
- Be factually accurate and informative
- Match the requested tone and length
- Provide relevant context and background
- Be written in {language}

Generate the content as plain text (no markdown formatting).
```

The graph context section is omitted when no graph context is available (e.g., for isolated annotations with no graph connections).

**Model Parameters**:
- Model: Claude Sonnet 4.5
- Temperature: 0.4 (balanced between accuracy and creativity)
- Max tokens: Configurable (default 500 for brief, 1500 for moderate, 3000 for detailed)

**Tone Guidelines**:
- **Scholarly**: Academic style, formal language, citation-oriented
- **Explanatory**: Educational, clear explanations for general audience
- **Conversational**: Casual, friendly, approachable
- **Technical**: Precise, detailed, expert-level terminology

**Length Guidelines**:
- **Brief**: ~100-200 words, concise overview
- **Moderate**: ~300-500 words, balanced coverage
- **Detailed**: ~800-1200 words, comprehensive treatment

### Event Emission

The GenerationWorker emits events on the EventBus. The Stower subscribes to these and persists them to the Event Store.

**Resource Creation** — worker emits `yield:create` on EventBus:
```typescript
eventBus.get('yield:create').next({
  name: generatedTitle,
  content: contentBuffer,
  format: 'text/plain',
  language: language,
  creationMethod: 'generated',
  userId,
});
```

**Annotation Update** — worker emits `mark:update-body` on EventBus:
```typescript
eventBus.get('mark:update-body').next({
  annotationId: referenceId,
  resourceId: sourceResourceId,
  operations: [{
    op: 'add',
    item: {
      type: 'SpecificResource',
      source: newResourceId,
      purpose: 'linking'
    }
  }]
});
```

**Why Two Events?**
- `yield:create` → Stower persists → `yield:created`: Creates the new generated resource
- `mark:update-body` → Stower persists → `mark:body-updated`: Updates the reference in source document

Both events flow through EventBus → Stower → Event Store → Materialized Views → Graph Database, enabling:
- Source document viewer sees reference resolve in real-time
- New resource is immediately queryable and browsable
- Graph database tracks relationship: (Source)-[:HAS_ANNOTATION]->(Reference)-[:LINKS_TO]->(Generated)

## Frontend Implementation

### Generation UI

**Component**: [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx)

**UI Elements**:
- Reference annotations display with ❓ icon for unresolved references
- "Generate" button triggers generation modal
- Generation modal shows:
  - Reference text preview
  - Entity type tags
  - Knowledge graph context (connected resources, cited-by with counts, sibling entity types)
  - Optional title input
  - Tone selector (scholarly/explanatory/conversational/technical)
  - Length selector (brief/moderate/detailed)
  - Language selector
  - Advanced options (max tokens override)

**Progress Display**:
- Modal shows real-time progress during generation
- Progress bar with percentage
- Status messages:
  - "Generating content with AI..."
  - "Creating resource..."
  - "Linking reference..."
  - "Complete! View resource →"
- Link to view newly generated resource

### SSE Client Usage

**File**: [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts)

```typescript
// Initiate generation
const stream = client.sse.generateResourceFromAnnotation(
  resourceId,
  referenceId,
  {
    tone: 'scholarly',
    length: 'moderate',
    language: 'en'
  }
);

// Handle progress
stream.onProgress((progress) => {
  setYieldProgress({
    status: progress.status,
    percentage: progress.percentage,
    message: progress.message
  });
});

// Handle completion
stream.onComplete((result) => {
  toast.success('Resource generated successfully');
  // Generation progress SSE closes
  // Document viewer's resource events SSE receives annotation.body.updated
  // React Query cache invalidates and refetches
  // UI updates: ❓ → 🔗
});

// Handle errors
stream.onError((error) => {
  toast.error(error.message);
  setIsGenerating(false);
});
```

### Real-Time Reference Resolution

**Two SSE Streams Work Together**:

1. **Generation Progress Stream** (`POST /resources/{id}/generate-resource-from-annotation-stream`)
   - Job-specific progress updates
   - Closes when generation completes
   - Shows progress in modal

2. **Resource Events Stream** (`GET /resources/{id}/events/stream`)
   - Long-lived connection per document viewer
   - Receives `mark:body-updated` event
   - Triggers React Query cache invalidation
   - UI updates icon: ❓ → 🔗

**Critical: No Page Refresh Required**

The `mark:body-updated` event flow ensures real-time updates:
1. Worker emits `mark:update-body` → EventBus → Stower persists → emits `mark:body-updated`
2. Document viewer's SSE receives event (<50ms latency)
3. Frontend `onAnnotationBodyUpdated` handler invalidates React Query cache
4. Annotations refetch from Materialized Views
5. UI re-renders with resolved reference

See [REAL-TIME.md](../../apps/backend/docs/REAL-TIME.md) for complete SSE architecture details.

## Error Handling

**Generation Failures**:
- Worker logs detailed error to backend console
- Generic error sent to frontend: "Generation failed. Please try again."
- Job marked as `status: 'failed'` in queue
- Frontend shows error toast with retry option

**Client Disconnection**:
- Generation job continues running even if progress SSE disconnects
- Resource still created and annotation still updated
- User sees resolved reference on page refresh (from Materialized Views)
- Resource events SSE delivers real-time update if still connected

**Validation Errors**:
- Invalid reference ID: 404 error returned immediately
- Missing source resource: 404 error
- Reference already resolved: 400 error with message
- Invalid parameters: 400 error with validation details

**Retry Strategy**:
- Max 1 retry on transient LLM failures
- Permanent failures (404, validation) not retried
- Retry delay: 5 seconds

## Validation

### End-to-End Test Scenarios

**Happy Path**:
1. Create reference annotation with entity type tags
2. Click "Generate" → modal opens
3. Configure options → click "Generate"
4. Progress updates appear in real-time
5. Reference icon changes ❓ → 🔗 without page refresh
6. Click 🔗 → navigate to generated resource
7. Verify generated content is relevant and matches tone/length

**Error Scenarios**:
- Invalid reference ID → 404 error, no job created
- Reference already resolved → 400 error with message
- LLM timeout → retry once, then fail gracefully
- Client disconnects during generation → job completes, refresh shows result

**Real-Time Event Delivery**:
- Multiple references generated in quick succession → all resolve in real-time
- Multiple browser tabs viewing same document → all see updates simultaneously
- SSE connection drops and reconnects → updates resume after reconnection

### Known Limitations

1. **Content Quality**: LLM generation quality varies based on reference text clarity and available context
2. **Factual Accuracy**: Generated content should be reviewed for accuracy, especially for scholarly use
3. **Single Language**: Each generated resource is single-language (no multilingual generation)
4. **No Iterative Refinement**: Generation is one-shot, no revision or refinement cycle
5. **Context Window**: Prompt includes limited context from source document (~2000 characters) plus graph neighborhood
6. **Duplicate Detection**: No automatic detection of duplicate/similar generated resources

## Related Files

### Generation Package (@semiont/make-meaning)

- [GenerationWorker](../../packages/jobs/src/workers/generation-worker.ts) - Worker implementation
- [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md#generationworker) - Architecture and flow
- [Make-Meaning Examples](../../packages/make-meaning/docs/examples.md) - Usage patterns

### Backend Routes

- [apps/backend/src/routes/resources/routes/generate-resource-from-annotation-stream.ts](../../apps/backend/src/routes/resources/routes/generate-resource-from-annotation-stream.ts) - Generation route
- [apps/backend/src/routes/resources/routes/events-stream.ts](../../apps/backend/src/routes/resources/routes/events-stream.ts) - Resource events SSE endpoint

### Frontend

- [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx) - Generation UI
- [packages/react-ui/src/hooks/useYieldFlow.ts](../../packages/react-ui/src/hooks/useYieldFlow.ts) - Generation flow hook (manages SSE, modal state, and progress state)
- [packages/react-ui/src/hooks/useResourceEvents.ts](../../packages/react-ui/src/hooks/useResourceEvents.ts) - Resource events hook
- [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts) - SSE client

### Documentation

- [@semiont/make-meaning](../../packages/make-meaning/README.md) - Package overview
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Annotation structure
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store flow
- [Real-Time Event Architecture](../../apps/backend/docs/REAL-TIME.md) - SSE streaming details
- [Mark Flow](./MARK.md) - Reference detection
