# AI-Powered Annotation Detection

**Purpose**: Automatic detection and creation of W3C Web Annotations using AI inference to identify important passages (highlights), evaluate content (assessments), and extract entity references (references/links).

**Related Documentation**:
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C specification implementation
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - TextPositionSelector and TextQuoteSelector details
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store, View Storage, Graph Database flow
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and component architecture
- [CodeMirror Integration](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md) - Position accuracy and CRLF handling

## Overview

Semiont uses AI to automatically detect and create W3C-compliant annotations in documents. This system combines:

1. **W3C Web Annotation Data Model** - Standards-compliant annotation structure with dual selectors
2. **AI Inference** - LLM-powered text analysis with configurable prompts and user instructions
3. **Backend Event Architecture** - Event Store → View Storage → Graph Database flow with <50ms latency
4. **Frontend UI** - Real-time progress display with SSE streaming and visual feedback

## Supported Detection Types

| Motivation | W3C Spec | Purpose | Body Content | User Control |
|------------|----------|---------|--------------|--------------|
| `highlighting` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Mark important passages | Empty array `[]` | Optional instructions (max 500 chars) |
| `assessing` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Evaluate and assess content | Assessment text as `TextualBody` | Optional instructions (max 500 chars) |
| `linking` | [W3C §3.1](https://www.w3.org/TR/annotation-model/#motivations) | Extract entity references | Entity type tags as `TextualBody` with `purpose: "tagging"` | Selected entity types from registry |

All types create annotations with:
- **Target**: Text selection with dual selectors (TextPositionSelector + TextQuoteSelector)
- **Body**: Empty for highlights, assessment text for assessments, entity type tags for references
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

**Implementation**:
- Highlights: [apps/backend/src/jobs/workers/highlight-detection-worker.ts:265-308](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts)
- Assessments: [apps/backend/src/jobs/workers/assessment-detection-worker.ts:265-308](../../apps/backend/src/jobs/workers/assessment-detection-worker.ts)
- References: [apps/backend/src/jobs/workers/detection-worker.ts:100-180](../../apps/backend/src/jobs/workers/detection-worker.ts)

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

**Highlight Detection**:
- **File**: [apps/backend/src/jobs/workers/highlight-detection-worker.ts:230-260](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts)
- **Task**: Identify important/noteworthy passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`
- **Model params**: max_tokens=2000, temperature=0.3

**Assessment Detection**:
- **File**: [apps/backend/src/jobs/workers/assessment-detection-worker.ts:231-261](../../apps/backend/src/jobs/workers/assessment-detection-worker.ts)
- **Task**: Assess and evaluate key passages
- **Input**: First 8000 characters + optional user instructions
- **Output**: JSON array with `exact`, `start`, `end`, `prefix`, `suffix`, `assessment`
- **Model params**: max_tokens=2000, temperature=0.3

**Reference/Entity Detection**:
- **File**: [apps/backend/src/inference/entity-extractor.ts:24-78](../../apps/backend/src/inference/entity-extractor.ts)
- **Task**: Identify entity references by type (Person, Location, Concept, etc.)
- **Input**: Full document content + selected entity types (with optional examples)
- **Output**: JSON array with `exact`, `entityType`, `startOffset`, `endOffset`, `prefix`, `suffix`
- **Model params**: max_tokens=4000, temperature=0.3

### User Instructions

**Highlights and Assessments** support optional instructions (max 500 chars):

Examples for Highlights:
- "Focus on key technical points"
- "Highlight definitions and important concepts"
- "Find passages related to security"

Examples for Assessments:
- "Evaluate claims for accuracy"
- "Assess the strength of evidence"
- "Focus on methodology"

**References** use entity type selection instead of free-text instructions:
- Users select from entity type registry (Person, Location, Organization, etc.)
- Optional examples can be provided per entity type
- Multiple entity types can be selected in a single detection run

### Content Truncation Strategy

| Detection Type | Content Limit | Rationale |
|----------------|---------------|-----------|
| Highlights | 8000 chars (~2000 words) | LLM context, response time, cost |
| Assessments | 8000 chars (~2000 words) | LLM context, response time, cost |
| References | Full document | Entity extraction needs complete context |

**Impact**:
- Highlights/assessments: Only first ~2000 words analyzed, long documents incomplete
- References: Full document processed, but may hit max_tokens (4000) on very long documents

**Future Improvements**:
- Chunking strategy with sliding window for highlights/assessments
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
Frontend → POST /resources/{id}/detect-{highlights|assessments|annotations}-stream
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

**References**: [apps/backend/src/routes/resources/routes/detect-annotations-stream.ts](../../apps/backend/src/routes/resources/routes/detect-annotations-stream.ts)

**Responsibilities**:
1. Validate request body (instructions for highlights/assessments, entity types for references)
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

References:
- `detection-started`, `detection-progress`, `detection-complete`, `detection-error`

### Backend Workers (Job Processing)

**Highlights Worker**: [apps/backend/src/jobs/workers/highlight-detection-worker.ts](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts)

**Processing Stages**:
1. **Load Resource (10%)**: Fetch from View Storage → load content via Representation Store → charset-aware decoding
2. **AI Detection (30%)**: Truncate to 8000 chars → LLM inference → parse JSON response
3. **Create Annotations (60-100%)**: For each highlight → create W3C annotation → append to Event Store

**Assessments Worker**: [apps/backend/src/jobs/workers/assessment-detection-worker.ts](../../apps/backend/src/jobs/workers/assessment-detection-worker.ts)

**Processing Stages**: Same as highlights, but with assessment text in body

**References Worker**: [apps/backend/src/jobs/workers/detection-worker.ts](../../apps/backend/src/jobs/workers/detection-worker.ts)

**Processing Stages**:
1. **Load Resource**: Fetch from View Storage → load full content (no truncation)
2. **Per-Entity-Type Detection**: For each selected entity type → call entity extractor → validate/correct positions
3. **Create Annotations**: For each entity → create W3C annotation with entity type tags → append to Event Store
4. **Progress Updates**: Emit progress after each entity type completes

**Event Emission**: All workers emit `job.started`, `job.progress`, `job.completed`, or `job.failed` events to Event Store.

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

**DetectSection** (Highlights/Assessments): [apps/frontend/src/components/resource/panels/DetectSection.tsx](../../apps/frontend/src/components/resource/panels/DetectSection.tsx)

Shared component for HighlightPanel and AssessmentPanel:
- Optional instructions textarea (max 500 characters with counter)
- Sparkle button (✨) triggers detection
- Real-time progress display during detection
- Color-coded by motivation (yellow/amber for highlights, red/pink for assessments)

**ReferencesPanel**: [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx)

Entity type selection UI:
- Checkbox list of available entity types
- Select all/none buttons
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

**References**:
- Per-entity-type progress: "Detecting Person... (1/5)"
- Completion: "Found X Person, Y Location, Z Organization"

**UI Feedback**:
- Border changes to yellow/red/blue during detection
- Animated icons (✨ for highlights/assessments, 🔵 for references)
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
- References: Gradient cyan-to-blue with link icon

---

## Testing & Validation

### Manual Testing Workflow

**Highlights/Assessments**:
1. Upload or paste a text document (markdown or plain text)
2. Open Highlight or Assessment panel
3. Optionally provide instructions (e.g., "Focus on definitions")
4. Click sparkle button (✨)
5. Observe real-time progress (10% → 30% → 60% → 100%)
6. Verify annotations appear correctly positioned
7. Check annotation count matches reported count

**References**:
1. Upload or paste a text document
2. Open References panel
3. Select entity types (Person, Location, etc.)
4. Click detect button
5. Observe per-entity-type progress
6. Verify references appear correctly positioned with entity type tags
7. Check completion log shows counts per entity type

### Validation Checks

- **Position accuracy**: Annotations render at correct character positions
- **Fuzzy anchoring**: Works when LLM positions are approximate (±5 chars)
- **CRLF handling**: Windows line endings normalized correctly ([CODEMIRROR-INTEGRATION.md:139-197](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md))
- **Content limits**: Highlights/assessments process first 8000 chars, references process full document
- **User instructions**: Influence LLM detection results as expected (highlights/assessments)
- **Entity type selection**: References detect only selected types
- **W3C compliance**: Annotations validate against W3C schema
- **Event Store persistence**: Annotations survive backend restart

### Known Limitations

1. **Content truncation**: Highlights/assessments only analyze first 8000 characters (long documents incomplete)
2. **Position approximation**: LLM positions may be ±5 characters off (fuzzy anchoring and validation compensate)
3. **Single-pass processing**: No iterative refinement or confidence scores
4. **No batch position validation**: Highlights/assessments don't validate positions before creating annotations (rely on fuzzy anchoring)
5. **Reference max tokens**: Very long documents may hit 4000 token limit, truncating entity extraction response

---

## Future Enhancements

### Short Term
1. Increase content limit for highlights/assessments (10K-20K range)
2. Add position validation before creating annotations (verify exact text match)
3. Better error messages with specific failure reasons
4. Confidence scores for each detection
5. Increase max_tokens for reference detection to handle longer documents

### Medium Term
1. Chunking strategy for long documents (sliding window with overlap)
2. User-selectable excerpts for analysis (manual section selection)
3. Iterative refinement (detect → verify → adjust loop)
4. Multiple LLM providers (fallback and comparison)
5. Custom entity type definitions with examples

### Long Term
1. Multi-pass detection with different strategies (technical, contextual, structural)
2. Cross-document pattern detection (entity recognition across corpus)
3. Learning from user corrections (fine-tuning feedback loop)
4. Custom detection models per domain (legal, scientific, technical)
5. Real-time collaborative detection (multi-user annotation sessions)

---

## Related Implementation Files

### Backend
- [apps/backend/src/routes/resources/routes/detect-highlights-stream.ts](../../apps/backend/src/routes/resources/routes/detect-highlights-stream.ts) - Highlight detection route
- [apps/backend/src/routes/resources/routes/detect-assessments-stream.ts](../../apps/backend/src/routes/resources/routes/detect-assessments-stream.ts) - Assessment detection route
- [apps/backend/src/routes/resources/routes/detect-annotations-stream.ts](../../apps/backend/src/routes/resources/routes/detect-annotations-stream.ts) - Reference detection route
- [apps/backend/src/jobs/workers/highlight-detection-worker.ts](../../apps/backend/src/jobs/workers/highlight-detection-worker.ts) - Highlight worker + prompt
- [apps/backend/src/jobs/workers/assessment-detection-worker.ts](../../apps/backend/src/jobs/workers/assessment-detection-worker.ts) - Assessment worker + prompt
- [apps/backend/src/jobs/workers/detection-worker.ts](../../apps/backend/src/jobs/workers/detection-worker.ts) - Reference/entity detection worker
- [apps/backend/src/inference/entity-extractor.ts](../../apps/backend/src/inference/entity-extractor.ts) - Entity extraction prompt + position validation

### Frontend
- [apps/frontend/src/components/resource/panels/DetectSection.tsx](../../apps/frontend/src/components/resource/panels/DetectSection.tsx) - Shared UI for highlights/assessments
- [apps/frontend/src/components/resource/panels/ReferencesPanel.tsx](../../apps/frontend/src/components/resource/panels/ReferencesPanel.tsx) - Reference detection UI
- [packages/api-client/src/sse/index.ts](../../packages/api-client/src/sse/index.ts) - SSE streaming client
- [apps/frontend/src/lib/fuzzy-anchor.ts](../../apps/frontend/src/lib/fuzzy-anchor.ts) - Fuzzy anchoring implementation
- [apps/frontend/src/lib/annotation-registry.ts](../../apps/frontend/src/lib/annotation-registry.ts) - Annotation type metadata

### Documentation
- [W3C Web Annotation Data Model](../../specs/docs/W3C-WEB-ANNOTATION.md) - Complete W3C implementation
- [W3C Selectors](../../specs/docs/W3C-SELECTORS.md) - Dual selector strategy
- [Backend W3C Implementation](../../apps/backend/docs/W3C-WEB-ANNOTATION.md) - Event Store architecture
- [Frontend Annotations](../../apps/frontend/docs/ANNOTATIONS.md) - UI patterns and components
- [CodeMirror Integration](../../apps/frontend/docs/CODEMIRROR-INTEGRATION.md) - CRLF position handling
