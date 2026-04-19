# Mark Flow

**Purpose**: Create W3C Web Annotations on resources — manually by selecting text, or via AI-assisted detection that identifies highlights, assessments, comments, tags, and entity references. Both human and AI agents participate as peers in annotation creation.

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C specification implementation
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - TextPositionSelector and TextQuoteSelector details
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store, View Storage, Graph Database flow
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - Position accuracy and CRLF handling
- [@semiont/make-meaning](../../packages/make-meaning/README.md) - Detection API and job workers
- [Make-Meaning Job Workers](../../packages/make-meaning/docs/job-workers.md) - Worker implementation details
- [Make-Meaning API Reference](../../packages/make-meaning/docs/api-reference.md) - AnnotationDetection methods

## Overview

The Mark flow adds structured metadata to resources. The application labels, tags, categorizes, and enriches content through auto-tagging, key term highlighting, priority flagging, and status indicators. AI agents perform named entity recognition, topic classification, and semantic enrichment; human collaborators perform triage and classification — determining what each passage means, its urgency, and where it belongs. The resulting annotations serve as anchors for downstream linking, context assembly, and navigation.

Semiont creates W3C-compliant annotations through two complementary paths: **manual annotation** (a human selects text and chooses a motivation) and **AI-assisted detection** (an AI agent scans the document and proposes annotations). Both paths produce identical W3C Web Annotations and flow through the same event-sourced pipeline. This system combines:

1. **W3C Web Annotation Data Model** - Standards-compliant annotation structure with dual selectors
2. **AI Inference** - LLM-powered text analysis with configurable prompts and user instructions
3. **Backend Event Architecture** - Event Store → View Storage → Graph Database flow with <50ms latency
4. **Frontend UI** - Real-time progress display with SSE streaming and visual feedback

**Supported Formats**: Currently available for text-based formats (`text/plain`, `text/markdown`). Support for images and PDFs is planned for future releases

## Using the API Client

**Manual annotation** — create an annotation directly. The `mark`
namespace emits `mark:create-request` via the bus gateway; the backend
annotation-assembly handler builds the full W3C annotation from the
intent (using the authenticated user's DID as the creator) and passes
it to Stower.

```typescript
const { annotationId } = await client.mark.annotation(resourceId, {
  motivation: 'highlighting',
  target: {
    source: resourceId,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'Ouranos',
      prefix: 'In the beginning, ',
      suffix: ' ruled the universe',
    },
  },
  body: [],
});
```

**AI-assisted annotation** — long-running job that streams progress
events. `client.mark.assist()` returns an Observable; internally it
emits `job:create` (with `jobType` derived from the motivation) on the
bus gateway. A worker claims the job, runs detection, and publishes
`mark:progress` / `mark:assist-finished` / `mark:assist-failed` events
as it goes.

```typescript
// Detect highlights with AI
client.mark.assist(resourceId, 'highlighting', {
  instructions: 'Focus on key technical points',
  density: 5,
}).subscribe({
  next: (event) => console.log('progress:', event),
  complete: () => console.log('done'),
});

// Detect entity references
client.mark.assist(resourceId, 'linking', {
  entityTypes: ['Person', 'Location'],
  includeDescriptiveReferences: false,
}).subscribe({ /* ... */ });
```

## Supported Detection Types

| Motivation | W3C Spec | Purpose | Body Content | User Control |
|------------|----------|---------|--------------|--------------|
| `highlighting` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Mark important passages | Empty array `[]` | Optional instructions (max 500 chars) + density (1-15) |
| `assessing` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Evaluate and assess content | Assessment text as `TextualBody` | Optional instructions (max 500 chars) + tone + density (1-10) |
| `commenting` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Add explanatory comments | Comment text as `TextualBody` with `purpose: "commenting"` | Optional instructions (max 500 chars) + tone + density (2-12) |
| `tagging` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Identify structural roles | Dual-body structure: category (`purpose: "tagging"`) + schema ID (`purpose: "describing"`) | Selected schema (IRAC/IMRAD/Toulmin) + categories |
| `linking` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Extract entity references | Entity type tags as `TextualBody` with `purpose: "tagging"` | Selected entity types from registry + include descriptive references option |

All types create annotations with:
- **Target**: Text selection with dual selectors (TextPositionSelector + TextQuoteSelector)
- **Body**: Empty for highlights, assessment text for assessments, comment text for comments, entity type tags for references
- **Creator**: W3C Agent identifying who requested the annotation
- **Generator**: W3C SoftwareAgent identifying the worker and inference model that produced it (present when a worker did the work, absent when an agent annotated directly)
- **Created**: ISO 8601 timestamp

---

## 1. W3C Web Annotation Basis

### Annotation Structure

Every detected annotation follows the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/):

```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "http://localhost:4000/annotations/abc123",
  "motivation": "highlighting",
  "creator": {
    "id": "did:web:localhost:users:alice",
    "type": "Person",
    "name": "Alice"
  },
  "generator": {
    "@type": "SoftwareAgent",
    "name": "Highlight Worker / Anthropic claude-sonnet-4-6",
    "worker": "Highlight Worker",
    "inferenceProvider": "anthropic",
    "model": "claude-sonnet-4-6"
  },
  "created": "2025-12-04T10:30:00Z",
  "target": {
    "type": "SpecificResource",
    "source": "http://localhost:4000/resources/doc-456",
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
  "body": []
}
```

**Reference annotation example** (with entity type tags):
```json
{
  "motivation": "linking",
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

**Comment annotation example** (with explanatory text):

```json
{
  "motivation": "commenting",
  "body": [
    {
      "type": "TextualBody",
      "value": "Ouranos (also spelled Uranus) is the primordial Greek deity personifying the sky. In Hesiod's Theogony, he is the son and husband of Gaia (Earth) and father of the Titans.",
      "purpose": "commenting",
      "format": "text/plain",
      "language": "en"
    }
  ]
}
```

**Implementation**:
- Highlights: [packages/jobs/src/workers/highlight-annotation-worker.ts](../../packages/jobs/src/workers/highlight-annotation-worker.ts)
- Assessments: [packages/jobs/src/workers/assessment-annotation-worker.ts](../../packages/jobs/src/workers/assessment-annotation-worker.ts)
- Comments: [packages/jobs/src/workers/comment-annotation-worker.ts](../../packages/jobs/src/workers/comment-annotation-worker.ts)
- References: [packages/jobs/src/workers/reference-annotation-worker.ts](../../packages/jobs/src/workers/reference-annotation-worker.ts)
- Tags: [packages/jobs/src/workers/tag-annotation-worker.ts](../../packages/jobs/src/workers/tag-annotation-worker.ts)

See [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md) for complete details on worker architecture and dependency injection.

### Dual Selectors for Robustness

Every detected annotation uses **both** W3C selector types ([W3C §4.2](https://www.w3.org/TR/annotation-model/#selectors)):

**TextPositionSelector** ([W3C §4.2.1](https://www.w3.org/TR/annotation-model/#text-position-selector)):
- Character offsets from document start: `{ "start": 52, "end": 59 }`
- Fast, precise lookup when document unchanged
- Required by detection workers to create annotations

**TextQuoteSelector** ([W3C §4.2.4](https://www.w3.org/TR/annotation-model/#text-quote-selector)):
- Exact text with prefix/suffix context
- Enables fuzzy anchoring when content shifts
- AI provides 32 characters of prefix/suffix context
- Disambiguates multiple occurrences of same text

**Why Dual Selectors?**
- Position-based anchoring works when content unchanged
- Text-based anchoring recovers from content edits, line ending changes (CRLF ↔ LF)
- Prefix/suffix enables finding text even when LLM positions are approximate

See [W3C-SELECTORS.md](../../specs/docs/W3C-SELECTORS.md) for complete selector documentation.

### Fuzzy Anchoring Implementation

Frontend uses fuzzy anchoring ([CODEMIRROR-INTEGRATION.md](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md)) to handle:
- Documents edited after annotation creation
- Character position shifts from insertions/deletions
- Line ending normalization (CRLF → LF)
- Multiple occurrences of same text

**Implementation**: [packages/api-client/src/utils/fuzzy-anchor.ts](../../packages/api-client/src/utils/fuzzy-anchor.ts) with comprehensive tests.

---

## 2. AI Inference & Prompts

### LLM Prompt Architecture

Detection workers use structured prompts optimized for each annotation type:

Detection workers use the `AnnotationDetection` class from [@semiont/make-meaning](../../packages/make-meaning/docs/api-reference.md#annotationdetection) for all AI-powered detection logic. Workers handle job orchestration and progress tracking, while detection methods handle prompt construction and response parsing.

**Highlight Detection**:
- **Detection Method**: [AnnotationDetection.detectHighlights()](../../packages/make-meaning/docs/api-reference.md#detecthighlights)
- **Worker**: [HighlightAnnotationWorker](../../packages/jobs/src/workers/highlight-annotation-worker.ts)
- **Task**: Identify important/noteworthy passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`
- **Model params**: max_tokens=2000, temperature=0.3

**Assessment Detection**:
- **Detection Method**: [AnnotationDetection.detectAssessments()](../../packages/make-meaning/docs/api-reference.md#detectassessments)
- **Worker**: [AssessmentAnnotationWorker](../../packages/jobs/src/workers/assessment-annotation-worker.ts)
- **Task**: Assess and evaluate key passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `assessment`
- **Model params**: max_tokens=2000, temperature=0.3

**Comment Detection**:
- **Detection Method**: [AnnotationDetection.detectComments()](../../packages/make-meaning/docs/api-reference.md#detectcomments)
- **Worker**: [CommentAnnotationWorker](../../packages/jobs/src/workers/comment-annotation-worker.ts)
- **Task**: Identify passages needing explanatory comments
- **Input**: First 8000 characters + optional user instructions + optional tone (scholarly/explanatory/conversational/technical)
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `comment`
- **Model params**: max_tokens=3000 (higher to allow for comment generation), temperature=0.4 (higher for creative context)
- **Guidelines**: Emphasis on selectivity (3-8 comments per 2000 words), value beyond restating text, focus on context/background/clarification

**Tag Detection**:
- **Detection Method**: [AnnotationDetection.detectTags()](../../packages/make-meaning/docs/api-reference.md#detecttags)
- **Worker**: [TagAnnotationWorker](../../packages/jobs/src/workers/tag-annotation-worker.ts)
- **Task**: Detect and extract structured tags using ontology schemas
- **Input**: Full document content + schema ID + category
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `category`
- **Model params**: max_tokens=2000, temperature=0.3

**Reference/Entity Detection**:
- **Worker**: [ReferenceAnnotationWorker](../../packages/jobs/src/workers/reference-annotation-worker.ts)
- **Task**: Identify entity references by type (Person, Location, Concept, etc.)
- **Input**: Full document content + selected entity types (with optional examples)
- **Output**: JSON array with `exact`, `entityType`, `startOffset`, `endOffset`, `prefix`, `suffix`
- **Model params**: max_tokens=4000, temperature=0.3

### Detection Parameters

All detection types support various parameters to customize AI behavior and control output.

#### Instructions (Highlights, Assessments, Comments)

Optional free-text guidance (max 500 characters) to influence what the AI detects:

**Highlight Examples**:
- "Focus on key technical points"
- "Highlight definitions and important concepts"
- "Find passages related to security"

**Assessment Examples**:
- "Evaluate claims for accuracy"
- "Assess the strength of evidence"
- "Focus on methodology"

**Comment Examples**:
- "Focus on technical terminology"
- "Explain historical references"
- "Clarify complex concepts"

#### Tone (Assessments, Comments)

Controls the writing style of generated text:

- **Analytical** (Assessments): Objective, evidence-based evaluation
- **Critical** (Assessments): Rigorous examination, identifies weaknesses
- **Balanced** (Assessments): Fair consideration of strengths and limitations
- **Constructive** (Assessments): Improvement-focused, actionable feedback
- **Scholarly** (Comments): Academic style with citations and formal language
- **Explanatory** (Comments): Clear, educational explanations for general audience
- **Conversational** (Comments): Casual, friendly style for approachable learning
- **Technical** (Comments): Precise, detailed technical explanations for expert audience

#### Density (Highlights, Assessments, Comments)

Controls the target number of annotations per 2000 words:

| Type | Range | Default | Sparse (Low) | Dense (High) |
|------|-------|---------|--------------|--------------|
| **Highlights** | 1-15 | 5 | 1-3 per 2000 words | 13-15 per 2000 words |
| **Assessments** | 1-10 | 4 | 1-2 per 2000 words | 8-10 per 2000 words |
| **Comments** | 2-12 | 5 | 2-3 per 2000 words | 10-12 per 2000 words |

**Implementation**: Density is communicated to the AI via prompt guidance. The AI aims for the specified density but may vary based on content (e.g., fewer highlights if content lacks noteworthy passages).

**UI**: Density selector includes:
- Checkbox to enable/disable (enabled by default)
- Slider control with numeric display
- Labels showing "sparse" at minimum, "dense" at maximum
- Current value displayed as "X per 2000 words"

#### Entity Types (References)

**Selection**: Users select from entity type registry (Person, Location, Organization, Event, Concept, etc.)
- Multiple types can be selected in a single detection run
- Optional examples can be provided per entity type
- Detection runs once per selected entity type

#### Include Descriptive References (References)

**Purpose**: Also detect descriptive references in addition to proper names.

**Checkbox option** (default: unchecked):
- **Unchecked (default)**: Only detect explicit entity names (e.g., "Einstein", "Paris", "IBM")
- **Checked**: Also detect descriptive references like "the physicist", "the city", "the tech giant"

**Example**:
- Text: "Albert Einstein was born in Ulm. The physicist later moved to Switzerland."
- Without descriptive refs: Detects "Albert Einstein", "Ulm", "Switzerland"
- With descriptive refs: Also detects "the physicist" (referencing Einstein)

**Use Cases**:
- Academic writing with frequent pronoun/description usage
- Historical documents using titles and descriptive phrases
- Technical documents with role-based references ("the CEO", "the lead developer")

**Prompt Impact**: When enabled, the AI is instructed to find both explicit names and descriptive references that clearly refer to entities.

### Content Truncation Strategy

| Detection Type | Content Limit | Rationale |
|----------------|---------------|-----------|
| Highlights | 8000 chars (~2000 words) | LLM context, response time, cost |
| Assessments | 8000 chars (~2000 words) | LLM context, response time, cost |
| Comments | 8000 chars (~2000 words) | LLM context, response time, cost (higher max_tokens for comment generation) |
| References | Full document | Entity extraction needs complete context |

**Impact**:

- Highlights/assessments/comments: Only first ~2000 words analyzed, long documents incomplete
- References: Full document processed, but may hit max_tokens (4000) on very long documents

**Future Improvements**:

- Chunking strategy with sliding window for highlights/assessments/comments
- User-controlled excerpt selection
- Multi-pass detection for long documents

### Response Validation

All detection types use similar validation:

**Implementation**: [packages/jobs/src/workers/highlight-annotation-worker.ts](../../packages/jobs/src/workers/highlight-annotation-worker.ts)

```typescript
// Parse LLM response
const cleaned = llmResponse.trim().replace(/^```(?:json)?\n?|\n?```$/g, '');
const parsed = JSON.parse(cleaned);

// Validate structure
if (!Array.isArray(parsed)) {
  return [];
}

// Filter valid entries
return parsed.filter((h: any) =>
  h &&
  typeof h.exact === 'string' &&
  typeof h.start === 'number' &&
  typeof h.end === 'number'
);
```

**Validation Strategy**:
- Remove markdown code fences if present
- Ensure response is JSON array
- Filter malformed entries
- Does NOT validate positions against content (relies on fuzzy anchoring)

**Reference detection** additionally validates and corrects positions using prefix/suffix context ([entity-extractor.ts](../../packages/jobs/src/workers/detection/entity-extractor.ts)).

### Position Accuracy Challenges

**LLM Position Challenges**:
- Character counting can be imprecise (±5 characters typical)
- Multi-byte characters (emojis, Unicode) cause offsets
- Whitespace handling varies

**Mitigation Strategy**:
1. LLM provides BOTH positions AND exact text
2. LLM provides prefix/suffix context (32 chars each)
3. Reference detection validates and corrects positions before creating annotations
4. Fuzzy anchoring finds correct position even if LLM positions wrong
5. Frontend validates and corrects positions during rendering

---

## 3. Backend Implementation

### Event-Driven Architecture

```
User clicks ✨ button or selects entity types
    ↓
Frontend → client.mark.assist(rId, motivation, options) emits job:create
          via /bus/emit with jobType derived from motivation
          (highlight-annotation | assessment-annotation | comment-annotation |
           tag-annotation | reference-annotation)
    ↓
Backend job:create handler builds a PendingJob, persists to queue,
returns job:created { jobId }
    ↓
Worker (separate process, subscribed to job:queued) claims via job:claim
    ↓
Worker runs detection, emits mark:progress / mark:assist-finished /
mark:assist-failed via /bus/emit (scoped to resourceId)
    ↓
Worker also emits mark:create per annotation; Stower persists and
EventStore publishes enriched mark:added events
    ↓
Every connected frontend receives events on /bus/subscribe;
BrowseNamespace invalidates caches; UI updates in real-time (<50ms)
```

Commands and result channels:

| Trigger | Request | Success | Failure |
|---|---|---|---|
| `client.mark.assist(..., 'highlighting', ...)` | `job:create` (jobType: `highlight-annotation`) | `mark:assist-finished` | `mark:assist-failed` |
| `client.mark.assist(..., 'assessing', ...)` | `job:create` (jobType: `assessment-annotation`) | `mark:assist-finished` | `mark:assist-failed` |
| `client.mark.assist(..., 'commenting', ...)` | `job:create` (jobType: `comment-annotation`) | `mark:assist-finished` | `mark:assist-failed` |
| `client.mark.assist(..., 'tagging', ...)` | `job:create` (jobType: `tag-annotation`) | `mark:assist-finished` | `mark:assist-failed` |
| `client.mark.assist(..., 'linking', ...)` | `job:create` (jobType: `reference-annotation`) | `mark:assist-finished` | `mark:assist-failed` |

All progress events flow on `mark:progress` scoped to the resource.

### Backend Workers (Job Processing)

All annotation workers follow the same pattern, inheriting from `JobWorker` base class in [@semiont/jobs](../../packages/jobs/). See [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md) for complete architecture details.

**Highlights Worker**: [HighlightAnnotationWorker](../../packages/jobs/src/workers/highlight-annotation-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from Materialized Views → load content via Content Store → charset-aware decoding
2. **AI Detection (30%)**: Call `AnnotationDetection.detectHighlights()` → parse validated matches
3. **Create Annotations (60-100%)**: For each highlight → create W3C annotation → emit `mark:create` on EventBus

**Assessments Worker**: [AssessmentAnnotationWorker](../../packages/jobs/src/workers/assessment-annotation-worker.ts)

**Processing Stages**: Same as highlights, but calls `AnnotationDetection.detectAssessments()` and includes assessment text in body

**Comments Worker**: [CommentAnnotationWorker](../../packages/jobs/src/workers/comment-annotation-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from Materialized Views → load content via Content Store → charset-aware decoding
2. **AI Detection (30%)**: Call `AnnotationDetection.detectComments()` with tone parameter → parse validated matches
3. **Create Annotations (60-100%)**: For each comment → create W3C annotation with `purpose: "commenting"` → emit `mark:create` on EventBus

**Tags Worker**: [TagAnnotationWorker](../../packages/jobs/src/workers/tag-annotation-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from Materialized Views → load full content
2. **Per-Category Detection**: For each category → call `AnnotationDetection.detectTags()` → parse validated matches
3. **Create Annotations (60-100%)**: For each tag → create W3C annotation with dual-body structure (category + schema ID) → emit `mark:create` on EventBus

**References Worker**: [ReferenceAnnotationWorker](../../packages/jobs/src/workers/reference-annotation-worker.ts)

**Processing Stages**:
1. **Load Resource**: Fetch from Materialized Views → load full content (no truncation)
2. **Per-Entity-Type Detection**: For each selected entity type → perform AI inference → validate/correct positions
3. **Create Annotations**: For each entity → create W3C annotation with entity type tags → emit `mark:create` on EventBus
4. **Progress Updates**: Emit progress after each entity type completes

**Event Emission**: All workers emit `job:start`, `job:progress`, `job:complete`, or `job:failed` events to the EventBus. The Stower subscribes to these events and persists them to the Event Store. Workers receive dependencies (JobQueue, EventBus, EnvironmentConfig) via constructor parameters, not singletons.

### Real-Time Updates

Detection events flow through the bus gateway's single SSE connection,
enabling real-time UI updates for every connected participant:

**Progress Updates**: Workers emit `mark:progress` on the resource-scoped
EventBus. The frontend's `SemiontApiClient` subscribes to these events
via `/bus/subscribe`; MarkVM surfaces them through an Observable.

**Annotation Creation**: When a worker emits `mark:create` on the bus:
1. Stower persists to the Event Store.
2. The EventStore enrichment callback attaches the post-materialization
   annotation to the published event.
3. Every connected frontend receives the enriched `mark:added` via the
   bus subscription.
4. BrowseNamespace updates its cached Observable in place — no HTTP
   refetch needed.

See [bus gateway architecture](../../apps/backend/docs/STREAMS.md) and
[real-time event delivery](../../apps/backend/docs/REAL-TIME.md) for
details on enrichment, gap detection on reconnect, and the single-SSE
delivery model.

### Data Flow Through Backend Layers

**Event Store → View Storage → Graph Database** ([Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md)):

```
Worker emits mark:create on EventBus
    ↓
Stower persists to Event Store (filesystem JSONL - immutable append-only log)
    ↓
Stower emits mark:created on EventBus
    ↓
View Materializer updates Materialized Views (fast single-doc queries)
    ↓
Graph Consumer updates Graph Database (relationship traversal - backlinks, connections)
```

**Storage Locations**:
```
data/events/shards/ab/cd/documents/doc-sha256:abc123/events-000042-{timestamp}.jsonl
data/views/shards/ab/cd/doc-sha256:abc123.jsonl
Neptune/In-Memory graph: (Document)-[:HAS_ANNOTATION]->(Annotation)
```

### Error Handling

**Job Failures**:
- Worker logs detailed error to backend console
- Generic error message sent to frontend ("Detection failed. Please try again later.")
- Job status preserved in queue for debugging
- Frontend shows user-friendly error toast

**Client Disconnection**:
- Job continues running even if client disconnects
- Annotations still created and saved to Event Store
- User sees result on page refresh (from View Storage)

**Retry Strategy**:
- Max 1 retry on transient failures
- Permanent failures marked as `status: 'failed'`
- No retry on validation errors or missing resources

---

## 4. Frontend Implementation

### Detection UI Components

**DetectSection** (Highlights/Assessments/Comments): [apps/frontend/src/components/resource/panels/DetectSection.tsx](../../apps/frontend/src/components/resource/panels/DetectSection.tsx)

Shared component for HighlightPanel, AssessmentPanel, and CommentsPanel:
- Optional instructions textarea (max 500 characters with counter)
- Optional tone selector dropdown (assessments: analytical/critical/balanced/constructive; comments: scholarly/explanatory/conversational/technical)
- Optional density slider (checkbox + slider control, enabled by default)
  - Highlights: 1-15 (default 5)
  - Assessments: 1-10 (default 4)
  - Comments: 2-12 (default 5)
- Sparkle button (✨) triggers detection
- Real-time progress display during detection
- Color-coded by motivation (yellow/amber for highlights, red/pink for assessments, purple/indigo for comments)

**ReferencesPanel**: [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx)

Entity type selection UI:
- Checkbox list of available entity types
- Select all/none buttons
- "Include descriptive references" checkbox (finds descriptive phrases like "the physicist" in addition to proper names)
- Detection progress widget showing per-entity-type progress
- Completion log showing counts per entity type

### Mark Namespace (Observable API)

**File**: [packages/api-client/src/namespaces/mark.ts](../../packages/api-client/src/namespaces/mark.ts)

The `mark.assist()` Observable handles the full detection lifecycle —
command emission, progress delivery, completion, and failure — over
the bus gateway. Components subscribe with RxJS operators; cleanup is
automatic on unsubscribe.

```typescript
const subscription = client.mark.assist(resourceId, 'highlighting', {
  instructions: 'Focus on key technical points',
  density: 5,
}).subscribe({
  next: (progress) => {
    setDetectionProgress({
      status: progress.status,
      percentage: progress.percentage,
      message: progress.message,
    });
  },
  complete: () => {
    toast.success('Detection complete');
    // BrowseNamespace auto-invalidates on mark:added events — no
    // explicit refetch needed.
  },
  error: (err) => {
    toast.error(err.message);
    setIsDetecting(false);
  },
});

// Cleanup
subscription.unsubscribe();
```

### Progress Display

**Highlighting**:

1. 10%: Loading resource...
2. 30%: Analyzing text with AI...
3. 60%: Creating N annotations...
4. 100%: Complete! Created N highlights

**Assessment**:

1. 10%: Loading resource...
2. 30%: Analyzing text with AI...
3. 60%: Creating N annotations...
4. 100%: Complete! Created N assessments

**Comments**:

1. 10%: Loading resource...
2. 30%: Analyzing text and generating comments...
3. 60%: Creating N annotations...
4. 100%: Complete! Created N comments

**References**:

- Per-entity-type progress: "Detecting Person... (1/5)"
- Completion: "Found X Person, Y Location, Z Organization"

**UI Feedback**:

- Border changes to yellow/red/purple/blue during detection
- Animated icons (✨ for highlights/assessments/comments, 🔵 for references)
- Progress percentage or entity type status
- Real-time message updates
- Completion toast notification

### Annotation Rendering

After detection completes:

1. Frontend refetches annotations from backend (Materialized Views)
2. Annotations converted to TextSegments with positions
3. CRLF → LF position conversion applied ([CODEMIRROR-INTEGRATION.md](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md))
4. Visual feedback (sparkle animation for new annotations)
5. Annotations render at correct positions with appropriate styling

**Styling** (from [Annotation Registry](../../apps/frontend/src/lib/annotation-registry.ts)):

- Highlights: Yellow background with hover darkening
- Assessments: Red underline with hover opacity change
- Comments: Dashed outline with hover background change
- References: Gradient cyan-to-blue with link icon

---

## Validation

### Validation Checks

- **Position accuracy**: Annotations render at correct character positions
- **Fuzzy anchoring**: Finds correct text even when LLM positions are wrong by searching for exact text and using prefix/suffix context for disambiguation
- **CRLF handling**: Windows line endings normalized correctly ([CODEMIRROR-INTEGRATION.md](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md))
- **Content limits**: Highlights/assessments/comments process first 8000 chars, references process full document
- **User instructions**: Influence LLM detection results as expected (highlights/assessments/comments)
- **Tone selection**: Tone influences writing style as expected
  - Assessment tones: analytical/critical/balanced/constructive
  - Comment tones: scholarly/explanatory/conversational/technical
- **Density control**: Annotation count roughly matches density setting (±20% variance acceptable)
  - Highlights: 1-15 per 2000 words
  - Assessments: 1-10 per 2000 words
  - Comments: 2-12 per 2000 words
- **Descriptive references**: When enabled, detects both proper names and descriptive phrases
- **Comment quality**: Comments add value beyond restating text, provide context/background
- **Entity type selection**: References detect only selected types
- **W3C compliance**: Annotations validate against W3C schema
- **Event Store persistence**: Annotations survive backend restart

### Known Limitations

1. **Content truncation**: Highlights/assessments/comments only analyze first 8000 characters (long documents incomplete)
2. **Position approximation**: LLM positions may be ±5 characters off (fuzzy anchoring and validation compensate)
3. **Single-pass processing**: No iterative refinement or confidence scores
4. **No batch position validation**: Highlights/assessments/comments don't validate positions before creating annotations (rely on fuzzy anchoring)
5. **Comment selectivity**: AI may occasionally over-comment or under-comment (target is 3-8 per 2000 words)
6. **Reference max tokens**: Very long documents may hit 4000 token limit, truncating entity extraction response

---

## Related Implementation Files

### Detection Package (@semiont/make-meaning)

- [AnnotationDetection API](../../packages/make-meaning/docs/api-reference.md#annotationdetection) - Detection methods
- [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md) - Worker architecture and dependency injection
- [HighlightAnnotationWorker](../../packages/jobs/src/workers/highlight-annotation-worker.ts) - Highlight worker
- [AssessmentAnnotationWorker](../../packages/jobs/src/workers/assessment-annotation-worker.ts) - Assessment worker
- [CommentAnnotationWorker](../../packages/jobs/src/workers/comment-annotation-worker.ts) - Comment worker
- [TagAnnotationWorker](../../packages/jobs/src/workers/tag-annotation-worker.ts) - Tag worker
- [ReferenceAnnotationWorker](../../packages/jobs/src/workers/reference-annotation-worker.ts) - Reference/entity detection worker
- [Make-Meaning Examples](../../packages/make-meaning/docs/examples.md) - Usage examples

### Backend Routes

- [apps/backend/src/routes/resources/routes/detect-highlights-stream.ts](../../apps/backend/src/routes/resources/routes/detect-highlights-stream.ts) - Highlight detection route
- [apps/backend/src/routes/resources/routes/detect-assessments-stream.ts](../../apps/backend/src/routes/resources/routes/detect-assessments-stream.ts) - Assessment detection route
- [apps/backend/src/routes/resources/routes/detect-comments-stream.ts](../../apps/backend/src/routes/resources/routes/detect-comments-stream.ts) - Comment detection route
- [apps/backend/src/routes/resources/routes/detect-annotations-stream.ts](../../apps/backend/src/routes/resources/routes/detect-annotations-stream.ts) - Reference detection route

### Frontend

- [apps/frontend/src/components/resource/panels/DetectSection.tsx](../../apps/frontend/src/components/resource/panels/DetectSection.tsx) - Shared UI for highlights/assessments/comments (with tone selector)
- [apps/frontend/src/components/resource/panels/CommentsPanel.tsx](../../apps/frontend/src/components/resource/panels/CommentsPanel.tsx) - Comments panel with detection UI
- [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx) - Reference detection UI
- [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts) - SSE streaming client (detectComments method)
- [apps/frontend/src/lib/fuzzy-anchor.ts](../../apps/frontend/src/lib/fuzzy-anchor.ts) - Fuzzy anchoring implementation
- [apps/frontend/src/lib/annotation-registry.ts](../../apps/frontend/src/lib/annotation-registry.ts) - Annotation type metadata

### Documentation
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - Dual selector strategy
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store architecture
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and components
- [CodeMirror Integration](../../packages/react-ui/docs/CODEMIRROR-INTEGRATION.md) - CRLF position handling
