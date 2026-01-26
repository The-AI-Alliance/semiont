# AI-Powered Annotation Detection

**Purpose**: Automatic detection and creation of W3C Web Annotations using AI inference to identify important passages (highlights), evaluate content (assessments), extract entity references (references/links), and generate explanatory comments (comments).

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C specification implementation
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - TextPositionSelector and TextQuoteSelector details
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store, View Storage, Graph Database flow
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md) - Position accuracy and CRLF handling
- [@semiont/make-meaning](../../packages/make-meaning/README.md) - Detection API and job workers
- [Make-Meaning Job Workers](../../packages/make-meaning/docs/job-workers.md) - Worker implementation details
- [Make-Meaning API Reference](../../packages/make-meaning/docs/api-reference.md) - AnnotationDetection methods

## Overview

Semiont uses AI to automatically detect and create W3C-compliant annotations in documents. This system combines:

1. **W3C Web Annotation Data Model** - Standards-compliant annotation structure with dual selectors
2. **AI Inference** - LLM-powered text analysis with configurable prompts and user instructions
3. **Backend Event Architecture** - Event Store → View Storage → Graph Database flow with <50ms latency
4. **Frontend UI** - Real-time progress display with SSE streaming and visual feedback

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
- **Creator**: W3C Agent with DID:WEB identifier
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
- Highlights: [packages/make-meaning/src/jobs/workers/highlight-detection-worker.ts](../../packages/make-meaning/src/jobs/workers/highlight-detection-worker.ts)
- Assessments: [packages/make-meaning/src/jobs/workers/assessment-detection-worker.ts](../../packages/make-meaning/src/jobs/workers/assessment-detection-worker.ts)
- Comments: [packages/make-meaning/src/jobs/workers/comment-detection-worker.ts](../../packages/make-meaning/src/jobs/workers/comment-detection-worker.ts)
- References: [packages/make-meaning/src/jobs/workers/reference-detection-worker.ts](../../packages/make-meaning/src/jobs/workers/reference-detection-worker.ts)
- Tags: [packages/make-meaning/src/jobs/workers/tag-detection-worker.ts](../../packages/make-meaning/src/jobs/workers/tag-detection-worker.ts)

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

Frontend uses fuzzy anchoring ([CODEMIRROR-INTEGRATION.md](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md)) to handle:
- Documents edited after annotation creation
- Character position shifts from insertions/deletions
- Line ending normalization (CRLF → LF)
- Multiple occurrences of same text

**Implementation**: [apps/frontend/src/lib/fuzzy-anchor.ts](../../apps/frontend/src/lib/fuzzy-anchor.ts) with 23 comprehensive tests.

---

## 2. AI Inference & Prompts

### LLM Prompt Architecture

Detection workers use structured prompts optimized for each annotation type:

Detection workers use the `AnnotationDetection` class from [@semiont/make-meaning](../../packages/make-meaning/docs/api-reference.md#annotationdetection) for all AI-powered detection logic. Workers handle job orchestration and progress tracking, while detection methods handle prompt construction and response parsing.

**Highlight Detection**:
- **Detection Method**: [AnnotationDetection.detectHighlights()](../../packages/make-meaning/docs/api-reference.md#detecthighlights)
- **Worker**: [HighlightDetectionWorker](../../packages/make-meaning/src/jobs/workers/highlight-detection-worker.ts)
- **Task**: Identify important/noteworthy passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`
- **Model params**: max_tokens=2000, temperature=0.3

**Assessment Detection**:
- **Detection Method**: [AnnotationDetection.detectAssessments()](../../packages/make-meaning/docs/api-reference.md#detectassessments)
- **Worker**: [AssessmentDetectionWorker](../../packages/make-meaning/src/jobs/workers/assessment-detection-worker.ts)
- **Task**: Assess and evaluate key passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `assessment`
- **Model params**: max_tokens=2000, temperature=0.3

**Comment Detection**:
- **Detection Method**: [AnnotationDetection.detectComments()](../../packages/make-meaning/docs/api-reference.md#detectcomments)
- **Worker**: [CommentDetectionWorker](../../packages/make-meaning/src/jobs/workers/comment-detection-worker.ts)
- **Task**: Identify passages needing explanatory comments
- **Input**: First 8000 characters + optional user instructions + optional tone (scholarly/explanatory/conversational/technical)
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `comment`
- **Model params**: max_tokens=3000 (higher to allow for comment generation), temperature=0.4 (higher for creative context)
- **Guidelines**: Emphasis on selectivity (3-8 comments per 2000 words), value beyond restating text, focus on context/background/clarification

**Tag Detection**:
- **Detection Method**: [AnnotationDetection.detectTags()](../../packages/make-meaning/docs/api-reference.md#detecttags)
- **Worker**: [TagDetectionWorker](../../packages/make-meaning/src/jobs/workers/tag-detection-worker.ts)
- **Task**: Detect and extract structured tags using ontology schemas
- **Input**: Full document content + schema ID + category
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `category`
- **Model params**: max_tokens=2000, temperature=0.3

**Reference/Entity Detection**:
- **Worker**: [ReferenceDetectionWorker](../../packages/make-meaning/src/jobs/workers/reference-detection-worker.ts)
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

**Implementation**: [apps/backend/src/jobs/workers/highlight-detection-worker.ts:263-278](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts)

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

**Reference detection** additionally validates and corrects positions using prefix/suffix context ([entity-extractor.ts:106-180](../../apps/backend/src/inference/entity-extractor.ts)).

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
Frontend → POST /resources/{id}/detect-{highlights|assessments|comments|annotations}-stream
    ↓
Route validates request, creates job → submits to queue
    ↓
Route subscribes to Event Store (resourceUri)
    ↓
Worker picks up job from queue
    ↓
Worker emits events → Event Store
    ↓
Route forwards events → SSE stream to frontend
    ↓
Frontend updates UI in real-time (<50ms latency)
```

### Backend Routes (SSE Streaming)

**Highlights**: [apps/backend/src/routes/resources/routes/detect-highlights-stream.ts](../../apps/backend/src/routes/resources/routes/detect-highlights-stream.ts)

**Assessments**: [apps/backend/src/routes/resources/routes/detect-assessments-stream.ts](../../apps/backend/src/routes/resources/routes/detect-assessments-stream.ts)

**Comments**: [apps/backend/src/routes/resources/routes/detect-comments-stream.ts](../../apps/backend/src/routes/resources/routes/detect-comments-stream.ts)

**References**: [apps/backend/src/routes/resources/routes/detect-annotations-stream.ts](../../apps/backend/src/routes/resources/routes/detect-annotations-stream.ts)

**Responsibilities**:

1. Validate request body:
   - Highlights: instructions (optional), density (optional, 1-15)
   - Assessments: instructions (optional), tone (optional: analytical/critical/balanced/constructive), density (optional, 1-10)
   - Comments: instructions (optional), tone (optional: scholarly/explanatory/conversational/technical), density (optional, 2-12)
   - References: entityTypes (required array), includeDescriptiveReferences (optional boolean)
2. Check authentication and resource existence (View Storage query)
3. Create job and submit to queue
4. Subscribe to Event Store for job events (resourceUri stream)
5. Forward events to client via SSE (<50ms latency)
6. Handle client disconnection gracefully (job continues)

**SSE Event Types**:

Highlights:

- `highlight-detection-started`, `highlight-detection-progress`, `highlight-detection-complete`, `highlight-detection-error`

Assessments:

- `assessment-detection-started`, `assessment-detection-progress`, `assessment-detection-complete`, `assessment-detection-error`

Comments:

- `comment-detection-started`, `comment-detection-progress`, `comment-detection-complete`, `comment-detection-error`

References:

- `detection-started`, `detection-progress`, `detection-complete`, `detection-error`

### Backend Workers (Job Processing)

All detection workers follow the same pattern, inheriting from `JobWorker` base class in [@semiont/jobs](../../packages/jobs/). See [Job Workers Documentation](../../packages/make-meaning/docs/job-workers.md) for complete architecture details.

**Highlights Worker**: [HighlightDetectionWorker](../../packages/make-meaning/src/jobs/workers/highlight-detection-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from View Storage → load content via Representation Store → charset-aware decoding
2. **AI Detection (30%)**: Call `AnnotationDetection.detectHighlights()` → parse validated matches
3. **Create Annotations (60-100%)**: For each highlight → create W3C annotation → append to Event Store

**Assessments Worker**: [AssessmentDetectionWorker](../../packages/make-meaning/src/jobs/workers/assessment-detection-worker.ts)

**Processing Stages**: Same as highlights, but calls `AnnotationDetection.detectAssessments()` and includes assessment text in body

**Comments Worker**: [CommentDetectionWorker](../../packages/make-meaning/src/jobs/workers/comment-detection-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from View Storage → load content via Representation Store → charset-aware decoding
2. **AI Detection (30%)**: Call `AnnotationDetection.detectComments()` with tone parameter → parse validated matches
3. **Create Annotations (60-100%)**: For each comment → create W3C annotation with `purpose: "commenting"` → append to Event Store

**Tags Worker**: [TagDetectionWorker](../../packages/make-meaning/src/jobs/workers/tag-detection-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from View Storage → load full content
2. **Per-Category Detection**: For each category → call `AnnotationDetection.detectTags()` → parse validated matches
3. **Create Annotations (60-100%)**: For each tag → create W3C annotation with dual-body structure (category + schema ID) → append to Event Store

**References Worker**: [ReferenceDetectionWorker](../../packages/make-meaning/src/jobs/workers/reference-detection-worker.ts)

**Processing Stages**:
1. **Load Resource**: Fetch from View Storage → load full content (no truncation)
2. **Per-Entity-Type Detection**: For each selected entity type → perform AI inference → validate/correct positions
3. **Create Annotations**: For each entity → create W3C annotation with entity type tags → append to Event Store
4. **Progress Updates**: Emit progress after each entity type completes

**Event Emission**: All workers emit `job.started`, `job.progress`, `job.completed`, or `job.failed` events to Event Store. Workers receive dependencies (JobQueue, EventStore, EnvironmentConfig) via constructor parameters, not singletons.

### Real-Time Updates

Detection events flow through the Event Store to subscribed clients via Server-Sent Events (SSE), enabling real-time UI updates:

**Progress Updates**: Route subscribes to resource events, forwards job progress to client (<50ms latency)

**Annotation Creation**: When worker emits `annotation.added`:
1. Event Store broadcasts to SSE subscribers (document viewers)
2. View Materializer updates View Storage
3. Graph Consumer updates Graph Database
4. Frontend invalidates React Query cache → refetches annotations
5. UI updates automatically

See [Real-Time Event Architecture](../../apps/backend/docs/REAL-TIME.md) for complete SSE implementation details including Event Handler Refs Pattern, reconnection strategy, and Envoy proxy configuration.

### Data Flow Through Backend Layers

**Event Store → View Storage → Graph Database** ([Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md)):

```
Worker emits annotation.added event
    ↓
Event Store (filesystem JSONL - immutable append-only log)
    ↓
Graph Consumer processes event
    ↓
View Storage (materialized view - fast single-doc queries)
    ↓
Graph Database (relationship traversal - backlinks, connections)
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

### SSE Streaming Client

**File**: [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts)

```typescript
// Initiate detection
const stream = client.sse.detectHighlights(resourceUri, { instructions });
// or
const stream = client.sse.detectAnnotations(resourceUri, { entityTypes });

// Handle progress events
stream.onProgress((progress) => {
  setDetectionProgress({
    status: progress.status,
    percentage: progress.percentage,
    message: progress.message
  });
});

// Handle completion
stream.onComplete((result) => {
  toast.success(`Created ${result.createdCount} annotations`);
  refetchAnnotations();  // Reload from View Storage
});

// Handle errors
stream.onError((error) => {
  toast.error(error.message);
  setIsDetecting(false);
});
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

1. Frontend refetches annotations from backend (View Storage)
2. Annotations converted to TextSegments with positions
3. CRLF → LF position conversion applied ([CODEMIRROR-INTEGRATION.md](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md))
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
- **CRLF handling**: Windows line endings normalized correctly ([CODEMIRROR-INTEGRATION.md:139-197](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md))
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
- [HighlightDetectionWorker](../../packages/make-meaning/src/jobs/workers/highlight-detection-worker.ts) - Highlight worker
- [AssessmentDetectionWorker](../../packages/make-meaning/src/jobs/workers/assessment-detection-worker.ts) - Assessment worker
- [CommentDetectionWorker](../../packages/make-meaning/src/jobs/workers/comment-detection-worker.ts) - Comment worker
- [TagDetectionWorker](../../packages/make-meaning/src/jobs/workers/tag-detection-worker.ts) - Tag worker
- [ReferenceDetectionWorker](../../packages/make-meaning/src/jobs/workers/reference-detection-worker.ts) - Reference/entity detection worker
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
- [CodeMirror Integration](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md) - CRLF position handling
