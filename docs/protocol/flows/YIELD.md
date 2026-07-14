# Yield Flow

**Purpose**: Synthesize new resources from reference annotations using correlated context. A human may compose the new resource manually, or an AI agent may generate it — both paths create a new resource and link the reference annotation to it.

**Related Documentation**:
- [W3C Web Annotation Data Model](../W3C-WEB-ANNOTATION.md) - Reference annotation structure
- [Knowledge System](../../system/KNOWLEDGE-SYSTEM.md) - Event store architecture
- [Event-Bus Protocol](../EVENT-BUS.md) - Channel naming, SSE streaming, event flow
- [Mark Flow](./MARK.md) - Annotation detection and creation
- [@semiont/make-meaning](../../../packages/make-meaning/README.md) - Generation worker and detection API
- [Make-Meaning Job Workers](../../../packages/make-meaning/docs/job-workers.md) - GenerationWorker implementation

## Overview

The Yield flow introduces new resources into the system. A document is uploaded, a page is loaded, or an AI agent produces a new resource — text or structured output — that is persisted to the knowledge base as a first-class W3C Resource. In the attention framework, yielding is the step that creates new objects available for subsequent annotation, linking, and navigation.

The Yield flow creates new resources from reference annotations (motivation: `linking`) that lack resolved content. A human can compose the resource manually via the compose page, or an AI agent can generate it from correlated context. The system:

1. Identifies unresolved reference annotations (empty body or stub SpecificResource)
2. Uses AI to generate contextually relevant content based on the reference text
3. Creates a new resource with the generated content
4. Updates the reference annotation body to link to the new resource
5. Broadcasts real-time updates via SSE so UI reflects changes immediately

**Supported Formats**: Currently available for text-based formats (`text/plain`, `text/markdown`). Generated resources take the requested `outputMediaType`, defaulting to `text/markdown`; the worker rejects any media type outside `text/markdown` | `text/plain`. Support for generating from annotations in images and PDFs is planned for future releases

## Using the SDK

Generation is a long-running job. `client.yield.fromAnnotation()`
returns an Observable that emits `progress` events during LLM
generation and finally a `complete` event on completion (or errors on
failure). Under the hood it emits `job:create` via the bus gateway
with `jobType: 'generation'`, then the generation worker picks it up
and publishes lifecycle events back on the unified job channels
(`job:report-progress` / `job:complete` / `job:fail`), which the
namespace filters by `jobId`.

```typescript
import { lastValueFrom } from 'rxjs';

// First, gather context for the annotation (see Gather flow)
const gather = await lastValueFrom(
  client.gather.annotation(resourceId, annotationId, { contextWindow: 2000 }),
);
const context = (gather as { response: GatheredContext }).response;

// Generate a new resource from the reference annotation. Optional
// `entityTypes` are stamped on the synthesized resource (so
// `browse.resources({ entityType: 'Deity' })` can find it) and also
// fed into the LLM prompt as a topical bias.
client.yield.fromAnnotation(resourceId, annotationId, {
  title: 'Ouranos',
  language: 'en',
  storageUri: 'file://...',
  context,
  entityTypes: ['Person', 'Deity'],
}).subscribe({
  next: (event) => console.log('progress:', event),
  complete: () => console.log('done'),
  error: (err) => console.error(err),
});

// Events seen by subscribers (discriminated YieldGenerationEvent):
//   { kind: 'progress', data: JobProgress }          — from job:report-progress
//   { kind: 'complete', data: JobCompleteCommand }   — from job:complete (terminal)
// Failure (job:fail) surfaces as the Observable's error.
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
Frontend → client.yield.fromAnnotation(...) emits job:create via /bus/emit
    ↓
Backend job:create handler builds a PendingJob, persists to queue, returns job:created
    ↓
Worker (separate process, subscribed to job:queued) claims it via job:claim bus command
    ↓
Worker generates content → uploads via client.yield.resource() (content over HTTP)
    ↓
Backend persists content, emits yield:create → Stower appends yield:created
    ↓
Worker emits job:report-progress, then job:complete (job:fail on error)
on the unified job channels — client filters by jobId
    ↓
Stower auto-binds the source reference (sourceAnnotationId): emits mark:update-body
→ Stower persists → mark:body-updated
    ↓
Every connected frontend receives the enriched mark:body-updated on /bus/subscribe
    ↓
BrowseNamespace updates the cached annotation in place
    ↓
UI updates: ❓ → 🔗 in real-time (<50ms latency)
```

## Backend Implementation

### Generation Dispatch

Generation has no dedicated REST endpoint — it runs as a bus job. The SDK's `yield` namespace emits `job:create` with `jobType: 'generation'`; the worker synthesizes content and uploads it through the standard resource-create path.

**Dispatch**: [packages/sdk/src/namespaces/yield.ts](../../../packages/sdk/src/namespaces/yield.ts) → `job:create`, handled by [job-commands.ts](../../../packages/make-meaning/src/handlers/job-commands.ts)

**Generation params** — the SDK's `yield` namespace maps `GenerationOptions`
([packages/sdk/src/namespaces/types.ts](../../../packages/sdk/src/namespaces/types.ts)) into the `job:create` event's
`params`, alongside the top-level `jobType: 'generation'` and the source
`resourceId`:
```typescript
{
  referenceId: string;        // fromAnnotation only — the annotation being resolved
  title: string;              // Title of the synthesized resource; also the LLM topic
  storageUri: string;         // Where the generated content is written (file://…)
  context: GatheredContext;   // Correlated context from the Gather flow (grounds the prompt)
  prompt?: string;            // Freeform user instructions — rendered as an authoritative
                              // "Instruction: …" line directly under the task framing
                              // (task = what to produce, prompt = how; they compose)
  entityTypes?: string[];     // Stamped on the synthesized resource AND injected into the
                              // prompt as a topical bias ("Focus on these entity types: …"),
                              // so `browse.resources({ entityType: … })` can later find it
  language?: string;          // Body locale — the language the resource is written in
  sourceLanguage?: string;    // Source locale — language of the referenced content, named in
                              // the prompt so the LLM reads the embedded source snippets (BCP-47)
  temperature?: number;       // LLM sampling temperature (worker default 0.7)
  maxTokens?: number;         // Target LLM response length in tokens (worker default 500)
  outputMediaType?: SupportedMediaType; // Output format; the worker defaults to text/markdown
                              // and fails the job for anything outside text/markdown | text/plain
  task?: 'resource' | 'answer' | 'summary' | (string & {});
                              // Framing — what the model is asked to DO. Canonical values map to
                              // tested lead lines; any other string is used VERBATIM as the framing
                              // (loud degrade: worker warns, never silently falls back). Default 'resource'
  structure?: 'prose' | 'sections' | 'chat' | (string & {});
                              // Shape — how text-bearing output is internally segmented; subordinate
                              // to outputMediaType, never its peer. Unknown strings become a freeform
                              // "Organize the output as: …" directive (+ warn). UNSET ⇒ NO structure
                              // directive at all — the task framing and the model determine shape
  cite?: boolean;             // Inline citations: the model is instructed to emit [[<id>]] transport
                              // tokens next to each claim; the worker strips them pre-upload and mints
                              // each as a W3C linking annotation on the derived resource (see
                              // "Citation convention" below). Off by default — when unset, [[…]] in
                              // generated content is left alone as legitimate content
}
```

`outputMediaType` is the one **universal** axis (it selects the modality);
`task` and `structure` are subordinate detail under it, not co-equal axes.
`structure` values are per-modality — `prose | sections | chat` is what shape
means for text-bearing output; other modalities (image, audio, video) get
their own canonical sets if/when their generators exist. Length knobs
(`maxTokens`, and one day duration/dimensions) are a separate axis and never
imply structure.

**Dispatch responsibilities** (SDK `yield` namespace + [job-commands.ts](../../../packages/make-meaning/src/handlers/job-commands.ts)):
1. Validate params and authentication
2. Create a generation job and submit it to the queue (`job:create` → `job:created`)
3. Surface progress to the client over SSE via the unified job channels

**Progress events**: generation reports on `job:report-progress` (ephemeral) and finishes with `job:complete` / `job:fail`. These are global, `jobId`-keyed signals (the dispatcher filters by `jobId`; resource viewers filter the same global stream by `resourceId`) — not resource-scoped delivery. The job keeps running even if the client disconnects.

### Generation Worker

Generation runs as a job processor in [@semiont/jobs](../../../packages/jobs/) — `processGenerationJob` dispatches by `jobType` and calls `generateResourceFromTopic()` for the AI synthesis.

**Processor**: [processGenerationJob](../../../packages/jobs/src/processors.ts)
**Synthesis**: [resource-generation.ts](../../../packages/jobs/src/workers/generation/resource-generation.ts) — `generateResourceFromTopic()`

**Processing Stages**:

1. **Load Source Resource (20%)**
   - Fetch source resource from Materialized Views
   - Load reference annotation by ID
   - Extract reference text and context

2. **Generate Content (40-70%)**
   - Build generation prompt with reference text and context
   - Apply user parameters (prompt, entity types, language, source language, temperature, max tokens)
   - Call AI inference using `generateResourceFromTopic()`
   - Parse and validate generated content

3. **Create Resource (85%)**
   - Upload content via `client.yield.resource()` (HTTP multipart — content is not bus traffic)
   - Backend persists content and emits `yield:create` → Stower appends `yield:created`
   - Worker receives the new resource ID from the upload response

4. **Link Source Reference (95%)**
   - Annotation-focus: the upload's `sourceAnnotationId` drives the Stower's auto-bind,
     which emits `mark:update-body` → `mark:body-updated`
   - Resource-focus: the worker emits `mark:create` to mint a source→derived provenance reference
   - Domain event broadcasts to SSE subscribers (document viewers)

5. **Complete (100%)**
   - Emit `job:complete` event on EventBus with new resource ID
   - Frontend receives completion via generation progress SSE
   - Document viewer receives `mark:body-updated` via resource events SSE

See [Job Workers Documentation](../../../packages/make-meaning/docs/job-workers.md) for complete implementation details and error handling.

### AI Generation Prompt

The generation prompt is enriched with graph context from the [Gather flow](./GATHER.md) when available. This includes connected resources, citations, and an optional LLM-generated relationship summary.

**Prompt Structure** (assembled by `generateResourceFromTopic`; every section
below is omitted when its underlying data is absent):
```
{task framing}                                                      // task: 'resource' → Generate a concise, informative resource about "{title}".
                                                                    //       'answer'   → Answer the following question directly and concisely,
                                                                    //                    grounded in the provided context: "{title}"
                                                                    //       'summary'  → Write a concise summary of "{title}".
                                                                    //       any other string → used verbatim as the framing (+ Topic: "{title}", worker warns)
Instruction: {prompt}                                               // when a freeform prompt was supplied — authoritative, directly under the framing
Focus on these entity types: {comma-separated entity types}.        // when entityTypes is non-empty

Annotation context:                                                 // annotation-focus (fromAnnotation)
- Annotation motivation: {motivation}
- Source resource: {source resource name} [{resourceId}]
- Comment|Assessment: {body text}                                   // commenting/assessing annotations only

Source document context:                                            // annotation-focus, when a passage is selected
---
...{before} **[{selected text}]** {after}...
---

Resource context:                                                   // resource-focus (fromResource)
- Resource: {resource name} [{resourceId}]
- Summary: {summary}
- Suggested references: {…}
{focal content, capped at 4000 chars}                               // RESOURCE_CONTENT_CAP
[{resourceId}]                                                      // related content: one id-labelled
{related content, capped at 4000 chars per resource}                // block per related resource

Knowledge graph context:                                            // shared, from the gathered graph
- Connected resources: {name (entity types) [resourceId], …}
- This resource is cited by {N} other resources: {name [resourceId], …}
- Related entity types in this document: {sibling entity types}
- Relationship summary: {inferredRelationshipSummary}

Related passages from the knowledge base:                           // shared; top-3 by score, 240 chars each
- [{resourceId}] ({score}) {passage text}                           // [{resourceId}/{annotationId}] when the
                                                                    // match is annotation-derived

The source resource and embedded context are in {source language}.  // when sourceLanguage is set
IMPORTANT: Write the entire resource in {language}.                 // when language is not English

Requirements:
- Aim for approximately {maxTokens} tokens of content
- Be factual and informative
- {structure directive}                                             // ONLY when `structure` is set:
                                                                    //   'sections' → titled sections (## Section) + Start with a clear heading (# Title)
                                                                    //   'prose'    → flowing paragraphs, no section headings
                                                                    //   'chat'     → conversational transcript — alternating, speaker-labeled turns
                                                                    //   any other string → Organize the output as: {structure} (worker warns)
- Ground every claim … cite its source by emitting [[<id>]] …      // ONLY when `cite` is set — the model may
                                                                    // cite only ids shown in the context above
                                                                    // (input label [abc] → output token [[abc]])
- Use markdown formatting                                           // text/plain instead: no markup; title on its own first line
- Write the response as markdown
```

There is no tone parameter. Generation is steered by the `task` framing, the
authoritative `Instruction:` line (`prompt`), the `entityTypes` bias, and the
gathered context. `maxTokens` sets the target **length only** — it never
implies structure. When `structure` is unset the prompt carries **no**
structure or heading requirement at all: the task framing and the model
determine shape (an `answer` naturally comes out prose; a `resource`
naturally article-ish). The forced `# Title` heading exists only under
canonical `sections` (markdown output). Each context section is omitted when
its data is absent — e.g. the graph section disappears for an isolated
annotation with no connections.

**Identifier convention.** Every embedded excerpt carries a stable,
model-visible identifier in one bracket form: `[<resourceId>]`, extended to
`[<resourceId>/<annotationId>]` when the excerpt is annotation-derived (a
semantic match anchored on an annotation). The label appears beside the name
on focal/source and graph lines, as the block label on related-content
blocks, and as the line prefix on semantic passages — which would otherwise
be anonymous (score + snippet) despite frequently being the answer-bearing
text. The bracket is the *text serialization* of a modality-general rule:
every context artifact is presented with its source id in whatever channel
its modality supports (binary artifacts in a future multi-modal context would
carry the id as attachment metadata, not painted into pixels). This is
input-side labelling only — it gives the model something real to attribute
facts to (and a downstream inline-citation feature something to resolve), but
nothing here instructs the model to emit citations. Prompt-size bounds are
named constants in the template: related/focal content 4,000 chars per
resource (`RESOURCE_CONTENT_CAP`), semantic passages top-3 by score at 240
chars each (`SEMANTIC_MATCH_LIMIT`/`SEMANTIC_MATCH_CHARS`), over a gather-side
pre-filter of ≤10 matches above 0.5 cosine. They become caller options only
if a consumer hits the wall.

**Citation convention** (`cite: true`). The output-side counterpart of the
identifier convention above: the model is instructed to ground every claim
and cite its source by emitting a **double-bracket token** — `[[<resourceId>]]`,
or `[[<resourceId>/<annotationId>]]` when citing an annotation-derived
passage — immediately after the claim, using only ids shown (single-bracketed)
in the embedded context. Double-bracket *out* vs single-bracket *in* means an
echoed input label is never misread as a citation. The tokens are
**transport, not content**: the worker parses them, validates each id against
the embedded context (**hallucination guard** — an id absent from the context
is stripped with a `warn`, never minted into a link to an invented source),
**strips them before upload** (stored content stays clean prose), and mints
each citation as a **W3C linking annotation on the derived resource** — the
target anchors the claim span (the sentence preceding the token, as
`TextPositionSelector` + `TextQuoteSelector` computed against the final
stored bytes), the body is a `SpecificResource` pointing at the cited source.
Citations are therefore **first-class references** — navigable, rendered by
the Browser like any other resolved reference, and edges in the knowledge
graph — not a parallel rendering path. This *complements* the post-hoc
`mark.assist('linking')` pass rather than replacing it. The token is only the
*text-modality transport*: the citation itself is the annotation, which
generalizes to other modalities (an image region, a media-fragment time
range) with their own transports. When `cite` is unset the resolver never
runs — `[[…]]` in generated content is left untouched as legitimate content.

The Q&A recipe (`my-chat`-style consumers): `task: 'answer'` with
`structure: 'prose'` (or `'chat'` for speaker-labeled turns) — ask the
question via `title`, refine with `prompt` ("cite every claim; be terse")
instead of fighting the article framing through it. Because every excerpt is
id-labelled, a `prompt` like "name the `[resourceId]` of each source you draw
from" is answerable.

**Model Parameters**:
- Model: Claude Sonnet 4.5
- Temperature: caller-supplied `temperature`; worker default 0.7
- Max tokens: caller-supplied `maxTokens`; worker default 500 (no preset tiers)

### Event Emission

The generation worker does **not** emit `yield:create` on the bus — content
never travels on the bus. The worker uploads the synthesized content over HTTP
via `client.yield.resource()` (the same multipart path the compose page uses);
the backend writes the bytes to disk and emits `yield:create`, which the Stower
persists. A second event — the reference auto-bind — is then emitted by the
**Stower**, not by the worker.

**Resource creation** — the worker uploads; the backend emits `yield:create`.
In [packages/jobs/src/worker-process.ts](../../../packages/jobs/src/worker-process.ts) the worker calls (content over HTTP,
not the bus; `sourceAnnotationId` is what later drives the auto-bind):
```typescript
const { resourceId: newResourceId } = await session.client.yield.resource({
  name: genResult.title,
  file: Buffer.from(genResult.content),
  format: genResult.format,          // requested output media type; defaults to text/markdown
  storageUri,
  sourceResourceId,
  sourceAnnotationId: referenceId,   // annotation-focus only — omitted for fromResource
  generationPrompt, language, entityTypes, generator,
});
```
The backend persists the content and emits `yield:create` → Stower appends `yield:created`.

**Reference resolution (auto-bind)** — the Stower's `yield:create` handler, *not*
the worker, resolves the source reference. When the upload carried
`sourceAnnotationId`/`sourceResourceId` (persisted as `generatedFrom`), the Stower
emits `mark:update-body` to add the new resource as a linking body
([packages/make-meaning/src/stower.ts](../../../packages/make-meaning/src/stower.ts)):
```typescript
this.eventBus.get('mark:update-body').next({
  annotationId: generatedFrom.annotationId,   // the source reference
  resourceId: generatedFrom.resourceId,       // the source resource
  operations: [{
    op: 'add',
    item: { type: 'SpecificResource', source: rId, purpose: 'linking' },
  }],
});
```
Resource-focus generation (`fromResource`, no triggering reference) has nothing to
auto-bind; instead the worker emits `mark:create` to mint a navigable
source→derived provenance reference annotation.

**Why two events?**
- `yield:create` (backend, after the HTTP upload) → Stower persists → `yield:created`: creates the new generated resource
- `mark:update-body` (Stower auto-bind) → Stower persists → `mark:body-updated`: resolves the source reference in the original document

Both events flow through EventBus → Stower → Event Store → Materialized Views → Graph Database, enabling:
- Source document viewer sees the reference resolve in real-time
- New resource is immediately queryable and browsable
- Graph database tracks relationship: (Source)-[:HAS_ANNOTATION]->(Reference)-[:LINKS_TO]->(Generated)

## Frontend Implementation

### Generation UI

**Components**:
- [ReferenceWizardModal.tsx](../../../packages/react-ui/src/components/modals/ReferenceWizardModal.tsx) — wizard for resolving an unresolved reference annotation (drives `yield.fromAnnotation`)
- [ConfigureGenerationStep.tsx](../../../packages/react-ui/src/components/modals/ConfigureGenerationStep.tsx) — generation config form, shared with the resource-derived flow

Resolving an unresolved reference (❓) opens `ReferenceWizardModal`. It first
gathers correlated context (see [Gather flow](./GATHER.md) — the gather step
renders the reference text, entity-type tags, and knowledge-graph context),
then offers three resolution strategies:

- **Bind** — search existing resources and link to a match (Match flow)
- **Generate** — synthesize a new resource with AI (this flow)
- **Compose** — author the resource by hand

Choosing **Generate** advances to `ConfigureGenerationStep`, whose controls map
directly onto `GenerationOptions`:

- **Resource title** (text, required) → `title`
- **Save location** (`file://` path, required) → `storageUri`
- **Additional instructions** (textarea, optional) → `prompt`
- **Language** (locale select) → `language`
- **Creativity** (slider 0–1, default 0.7) → `temperature`
- **Max length** (number 100–4000, default 500) → `maxTokens`

There is no tone or length control — steering is the freeform **Additional
instructions** prompt plus the entity-type tags carried on the annotation. The
resource-derived variant ([ResourceGenerateModal.tsx](../../../packages/react-ui/src/components/modals/ResourceGenerateModal.tsx), driving
`yield.fromResource`) reuses the same `ConfigureGenerationStep`.

**Progress Display**:
- Modal shows real-time progress during generation
- Progress bar with percentage
- Status messages:
  - "Generating content with AI..."
  - "Creating resource..."
  - "Linking reference..."
  - "Complete! View resource →"
- Link to view newly generated resource

### Yield Namespace (Observable API)

**File**: [packages/sdk/src/namespaces/yield.ts](../../../packages/sdk/src/namespaces/yield.ts)

`yield.fromAnnotation()` returns an Observable of `YieldGenerationEvent`s,
backed by the bus gateway. The namespace emits `job:create` (jobType:
`generation`) via `/bus/emit`; the generation worker picks it up,
generates the resource, and publishes the unified
`job:report-progress` / `job:complete` / `job:fail` lifecycle as it
works. The namespace filters those by the `jobId` returned from
`job:create` and re-emits them as discriminated
`{ kind: 'progress' }` / `{ kind: 'complete' }` events (failure
surfaces as the Observable's error).

```typescript
const subscription = client.yield.fromAnnotation(resourceId, referenceId, {
  title: 'Ouranos',
  storageUri: 'file://...',
  context,
  language: 'en',
}).subscribe({
  next: (event) => {
    if (event.kind === 'progress') {
      // event.data is a JobProgress
      setYieldProgress(event.data);
    }
    // event.kind === 'complete' carries the final JobCompleteCommand
  },
  complete: () => {
    toast.success('Resource generated successfully');
    // The Stower auto-binds the source reference, broadcasting
    // mark:body-updated on the bus; BrowseNamespace updates the cached
    // annotation in place, UI flips ❓ → 🔗 automatically.
  },
  error: (err) => {
    toast.error(err.message);
    setIsGenerating(false);
  },
});

subscription.unsubscribe();  // cleanup
```

### Real-Time Reference Resolution

**Single bus connection delivers everything**:

Job lifecycle events (`job:report-progress`, `job:complete`,
`job:fail`) and domain events (`mark:body-updated`) all flow through
the same `/bus/subscribe` SSE connection. The frontend's
`YieldStateUnit` observes the `yield.fromAnnotation()` stream — which
filters lifecycle events by the generation's `jobId` — for the modal
UI, while `BrowseNamespace` handles the domain event for cache
invalidation.

**No Page Refresh Required**

The `mark:body-updated` event flow:
1. Stower's `yield:create` handler auto-binds the source reference, emitting
   `mark:update-body` → EventBus → Stower persists →
   EventStore publishes enriched `mark:body-updated` on scoped bus
2. Frontend ActorStateUnit receives event, bridges to local EventBus
3. `BrowseNamespace.updateAnnotationInPlace` writes the enriched
   annotation into the cached Observable
4. UI re-renders with resolved reference (❓ → 🔗)

See [EVENT-BUS.md](../EVENT-BUS.md) for the bus protocol.

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
7. Verify generated content is relevant to the reference and reflects the title, prompt, and entity types

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

### Generation (@semiont/jobs)

- [processGenerationJob](../../../packages/jobs/src/processors.ts) - Generation job processor
- [resource-generation.ts](../../../packages/jobs/src/workers/generation/resource-generation.ts) - `generateResourceFromTopic()` synthesis
- [Job Workers Documentation](../../../packages/make-meaning/docs/job-workers.md) - Architecture and flow
- [Make-Meaning Examples](../../../packages/make-meaning/docs/examples.md) - Usage patterns

### Backend

- [apps/backend/src/routes/bus.ts](../../../apps/backend/src/routes/bus.ts) - Bus gateway (`/bus/emit`, `/bus/subscribe`)
- [packages/make-meaning/src/handlers/job-commands.ts](../../../packages/make-meaning/src/handlers/job-commands.ts) - `job:create`/`job:claim` handlers

### Frontend

- [packages/react-ui/src/components/modals/ReferenceWizardModal.tsx](../../../packages/react-ui/src/components/modals/ReferenceWizardModal.tsx) - Reference-resolution wizard (Bind / Generate / Compose)
- [packages/react-ui/src/components/modals/ConfigureGenerationStep.tsx](../../../packages/react-ui/src/components/modals/ConfigureGenerationStep.tsx) - Generation config form (title, prompt, language, creativity, max length)
- [packages/sdk/src/state/flows/yield-state-unit.ts](../../../packages/sdk/src/state/flows/yield-state-unit.ts) - Generation flow state unit (bus commands + progress)
- [packages/http-transport/src/transport/actor-state-unit.ts](../../../packages/http-transport/src/transport/actor-state-unit.ts) - Bus actor primitive

### Documentation

- [@semiont/make-meaning](../../../packages/make-meaning/README.md) - Package overview
- [W3C Web Annotation Data Model](../W3C-WEB-ANNOTATION.md) - Annotation structure
- [Knowledge System](../../system/KNOWLEDGE-SYSTEM.md) - Event store flow
- [Event-Bus Protocol](../EVENT-BUS.md) - Bus model, channels, enrichment, gap detection
- [Mark Flow](./MARK.md) - Reference detection
