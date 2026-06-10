# Annotations

## Overview

`@semiont/react-ui` provides a comprehensive annotation system based on the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/). The system is designed to be framework-agnostic, allowing applications to use any data fetching library while maintaining type safety and clean architecture.

### Supported Annotation Types

- **Highlights** (`highlighting`) - Mark text for attention
- **Comments** (`commenting`) - Add commentary to selections
- **Tags** (`tagging`) - Categorize and label content
- **References** (`linking`) - Link to entities and documents
- **Assessments** (`assessing`) - Rate or evaluate content

### Key Features

- ✅ W3C Web Annotation Data Model compliance
- ✅ Framework-agnostic Provider Pattern architecture
- ✅ Text and image annotation support
- ✅ AI-powered entity detection
- ✅ Real-time collaboration
- ✅ JSON-LD representation
- ✅ Annotation history tracking
- ✅ TypeScript type safety

---

## Architecture

### Provider Pattern

The annotation system follows the **Provider Pattern** to maintain framework independence. Apps provide implementations while `@semiont/react-ui` defines the interfaces.

```typescript
// Interfaces defined in react-ui
interface AnnotationManager {
  createAnnotation: (params: CreateAnnotationParams) => Promise<Annotation | undefined>;
  deleteAnnotation: (params: DeleteAnnotationParams) => Promise<void>;
}

// Apps provide implementations
const annotationManager = useAnnotationManager(); // App-specific
```

Cache freshness is **not** an app responsibility: the SDK's read-through cache
refreshes itself off bus events, so there is no app-provided cache manager.

See [SESSION.md](SESSION.md) for detailed Provider Pattern documentation.

---

## Core Components

### Annotation Creation

#### Generic Creation (Recommended)

All annotation types are created through a single, generic function:

```typescript
import { useResourceAnnotations } from '@semiont/react-ui';

function MyComponent() {
  const { createAnnotation } = useResourceAnnotations();

  // Create a highlight
  await createAnnotation(rId, 'highlighting', [
    {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
    {
      type: 'TextQuoteSelector',
      exact: 'Hello World',
    }
  ]);

  // Create a comment
  await createAnnotation(rId, 'commenting', selector, {
    type: 'TextualBody',
    value: 'Great point!',
    format: 'text/plain',
    purpose: 'commenting',
  });

  // Create a reference
  await createAnnotation(rId, 'linking', selector, [
    { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
    { type: 'SpecificResource', source: targetDocId, purpose: 'linking' }
  ]);
}
```

#### Annotation Deletion

```typescript
const { deleteAnnotation } = useResourceAnnotations();

await deleteAnnotation(rId, annotationId);
```

### UI State Management

Sparkle animations for newly created annotations:

```typescript
import { useAnnotationUI } from '@semiont/react-ui';

function MyComponent() {
  const { newAnnotationIds, triggerSparkleAnimation, clearNewAnnotationId } = useAnnotationUI();

  // Check if annotation is new
  if (newAnnotationIds.has(annotationId)) {
    // Apply sparkle animation CSS class
  }

  // Manually trigger sparkle
  triggerSparkleAnimation('ann-123');

  // Manually clear (auto-clears after 6 seconds)
  clearNewAnnotationId('ann-123');
}
```

---

## Annotation Views

### Resource Viewer

Main component for viewing annotated resources:

```typescript
import { ResourceViewer } from '@semiont/react-ui';

<ResourceViewer
  content={content}
  mimeType="text/plain"
  resourceId={rId}
  annotations={annotationsCollection}
  handlers={annotationHandlers}
  uiState={uiState}
  onUIStateChange={handleUIStateChange}
/>
```

### Annotation Views

- **BrowseView** - Read-only markdown rendering with annotations
- **AnnotateView** - Interactive annotation creation and editing
- **ResourceViewer** - Unified view switching between browse/annotate modes

### Annotation Panels

- **UnifiedAnnotationsPanel** - All annotation types in one panel
- **HighlightPanel** - Highlight-specific panel
- **CommentsPanel** - Comment threads and discussions
- **ReferencesPanel** - Entity references and links
- **AssessmentPanel** - Ratings and assessments
- **TaggingPanel** - Tag management
- **JsonLdPanel** - JSON-LD representation

---

## Annotation Registry

Centralized metadata registry for annotation types:

```typescript
import { ANNOTATORS, getAnnotator, groupAnnotationsByType } from '@semiont/react-ui';

// Access annotator metadata
const highlightAnnotator = ANNOTATORS.highlight;
console.log(highlightAnnotator.displayName); // "Highlight"
console.log(highlightAnnotator.className); // CSS classes
console.log(highlightAnnotator.iconEmoji); // "🟡"

// Get annotator for an annotation
const annotator = getAnnotator(annotation);
if (annotator?.isClickable) {
  // Handle click
}

// Group annotations by type
const groups = groupAnnotationsByType(annotations);
const highlights = groups.highlight || [];
const comments = groups.comment || [];
```

### Annotator Metadata

Each annotator provides:

```typescript
interface Annotator {
  // W3C standard
  motivation: Motivation; // 'highlighting', 'commenting', etc.

  // Display
  displayName: string; // "Highlight"
  description: string; // "Mark text for attention"
  iconEmoji?: string; // "🟡"

  // Styling
  className: string; // Tailwind CSS classes

  // Behavior
  isClickable: boolean;
  hasHoverInteraction: boolean;
  hasSidePanel: boolean;

  // Type checking
  matchesAnnotation: (ann: Annotation) => boolean;

  // AI Detection (optional)
  detection?: DetectionConfig;
}
```

### Runtime Handler Injection

Handlers are injected at runtime using `withHandlers()`:

```typescript
import { withHandlers, ANNOTATORS } from '@semiont/react-ui';

const annotators = withHandlers({
  highlight: {
    onClick: (annotation) => { /* ... */ },
    onHover: (annotationId) => { /* ... */ }
    // AI assist is NOT a handler here — it runs through the mark state unit.
    // Trigger it with `client.mark.requestAssist('highlighting', options)`
    // (see "AI-Powered Detection" below).
  },
  comment: {
    onClick: (annotation) => { /* ... */ },
    onCreate: async (text) => { /* ... */ }
  }
});

<UnifiedAnnotationsPanel annotators={annotators} />
```

---

## AI-Powered Detection

### The Mark State Unit

AI-assisted detection is driven by the session-scoped **mark state unit**
(`createMarkStateUnit`, in `@semiont/sdk`). The resource-viewer page state unit
owns one per resource and exposes it as `stateUnit.mark`. It tracks three
observables that the UI reads via `useObservable`:

- `mark.assistingMotivation$` — the in-progress motivation (or `null` when idle)
- `mark.progress$` — the latest `JobProgress`
- `mark.pendingAnnotation$` — a pending manual annotation awaiting a body

To trigger detection, a panel calls the SDK directly — there is no handler to
wire up and no detection context object:

```typescript
import { useObservable, useSemiont } from '@semiont/react-ui';

function ReferencesAssist({ stateUnit }: { stateUnit: ResourceViewerPageStateUnit }) {
  const session = useObservable(useSemiont().activeSession$);

  // Read live assist state from the mark state unit
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;

  const handleDetect = () => {
    // requestAssist emits the local 'mark:assist-request' event; the mark
    // state unit picks it up and runs client.mark.assist(...) for the job.
    session?.client.mark.requestAssist('linking', {
      entityTypes: ['Person', 'Organization'],
    });
  };

  return (
    <button onClick={handleDetect} disabled={!!assistingMotivation}>
      {assistingMotivation ? `Detecting… ${progress?.message ?? ''}` : 'Detect references'}
    </button>
  );
}
```

### Job Lifecycle (the unified job channels)

`mark.assist(resourceId, motivation, options)` dispatches a `job:create` request
and streams progress on the **unified job channels**:

- `job:report-progress` - progress updates while the job runs
- `job:complete` - the job finished successfully
- `job:fail` - the job failed

The mark state unit subscribes to these (filtered by its own `jobId`) and drives
`assistingMotivation$` / `progress$` from them; the panel just reads those
observables. The SDK's read-through cache refreshes itself off the resource's
`browse.*` live queries when `job:complete` lands, so **no manual cache
invalidation is needed** — newly created annotations appear automatically.

For UI side effects (toasts, scroll), subscribe to the same job channels with
`useEventSubscriptions`, scoping by `resourceId`:

```typescript
import { useEventSubscriptions } from '@semiont/react-ui';

function AssistMonitor({ resourceId }: { resourceId: ResourceId }) {
  useEventSubscriptions({
    'job:complete': (e) => {
      if (e.resourceId === resourceId) {
        // The SDK cache refreshes off the same event — react here for
        // UI side effects only (toasts, scroll, etc.).
      }
    },
    'job:fail': (e) => {
      if (e.resourceId === resourceId) { /* show error */ }
    },
  });
}
```

See [EVENTS.md](EVENTS.md) for complete event documentation.

### Detection Configuration

Each annotator can declare its assist capability via the `detection`
(`DetectionConfig`) field in its registry metadata (`lib/annotation-registry.ts`).
It carries display metadata used by the progress UI:

```typescript
detection: {
  sseMethod: 'detectHighlights',
  countField: 'createdCount',
  displayNamePlural: 'highlights',
  displayNameSingular: 'highlight',
  formatRequestParams: (args) => [
    { label: 'Instructions', value: args[0] },
    { label: 'Density', value: args[2] }
  ]
}
```

---

## Image Annotations

### SVG Drawing Canvas

```typescript
import { SvgDrawingCanvas } from '@semiont/react-ui';

<SvgDrawingCanvas
  resourceId={rId}
  existingAnnotations={imageAnnotations}
  drawingMode={selectedShape} // 'rectangle', 'circle', 'polygon'
  selectedMotivation={motivation}
  onAnnotationCreate={async (svg, position) => {
    await createAnnotation(rId, motivation, {
      type: 'SvgSelector',
      value: svg
    });
  }}
  onAnnotationClick={handleClick}
  onAnnotationHover={handleHover}
/>
```

### Supported Shapes

- Rectangle
- Circle
- Polygon
- Freehand drawing

---

## W3C Annotation Model

### Annotation Structure

```typescript
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "type": "Annotation",
  "id": "http://example.org/annotations/ann-123",
  "motivation": "highlighting",
  "created": "2025-01-03T12:00:00Z",
  "creator": { "id": "http://example.org/users/user-456" },
  "target": {
    "source": "http://example.org/resources/doc-789",
    "selector": [
      {
        "type": "TextPositionSelector",
        "start": 0,
        "end": 10
      },
      {
        "type": "TextQuoteSelector",
        "exact": "Hello World",
        "prefix": "",
        "suffix": "! This is"
      }
    ]
  },
  "body": []
}
```

### Selectors

**Text Selectors:**
- `TextPositionSelector` - Character offsets (start, end)
- `TextQuoteSelector` - Exact text + context (prefix, suffix)

**Image Selectors:**
- `SvgSelector` - SVG path for image regions

### Bodies

**Tagging:**
```typescript
{
  type: 'TextualBody',
  value: 'Person',
  purpose: 'tagging'
}
```

**Commenting:**
```typescript
{
  type: 'TextualBody',
  value: 'Great point!',
  format: 'text/plain',
  purpose: 'commenting'
}
```

**Linking:**
```typescript
{
  type: 'SpecificResource',
  source: 'http://example.org/resources/target-doc',
  purpose: 'linking'
}
```

---

## Markdown Integration

### Remark/Rehype Plugins

```typescript
import { remarkAnnotations, rehypeRenderAnnotations } from '@semiont/react-ui';
import ReactMarkdown from 'react-markdown';

<ReactMarkdown
  remarkPlugins={[
    [remarkAnnotations, { annotations: preparedAnnotations }]
  ]}
  rehypePlugins={[
    rehypeRenderAnnotations
  ]}
>
  {markdownContent}
</ReactMarkdown>
```

### Overlay Annotations

Convert W3C annotations to overlay format:

```typescript
// annotation-overlay.ts
function toOverlayAnnotations(annotations: Annotation[]): OverlayAnnotation[] {
  return annotations.map(ann => {
    const posSelector = getTextPositionSelector(getTargetSelector(ann.target));
    return {
      id: ann.id,
      exact: getExactText(getTargetSelector(ann.target)),
      offset: posSelector?.start ?? 0,
      length: (posSelector?.end ?? 0) - (posSelector?.start ?? 0),
      type: getAnnotationInternalType(ann),
      source: getBodySource(ann.body)
    };
  });
}
```

---

## CodeMirror Integration

### Annotation Rendering

```typescript
import { CodeMirrorRenderer } from '@semiont/react-ui';

<CodeMirrorRenderer
  content={content}
  segments={textSegments}
  onAnnotationClick={handleClick}
  onAnnotationHover={handleHover}
  newAnnotationIds={newAnnotationIds}
  hoveredAnnotationId={hoveredId}
  showLineNumbers={true}
  enableWidgets={true}
/>
```

### Text Segmentation

```typescript
interface TextSegment {
  exact: string;
  start: number;
  end: number;
  annotation?: Annotation;
}
```

---

## Testing

### Test Examples

```typescript
import { render, screen, act } from '@testing-library/react';
import { AnnotationProvider, AnnotationUIProvider } from '@semiont/react-ui';

describe('Annotation System', () => {
  it('should create annotation', async () => {
    const mockManager = {
      createAnnotation: vi.fn().mockResolvedValue({ id: 'ann-123' }),
      deleteAnnotation: vi.fn()
    };

    render(
      <AnnotationProvider annotationManager={mockManager}>
        <AnnotationUIProvider>
          <MyComponent />
        </AnnotationUIProvider>
      </AnnotationProvider>
    );

    // Test annotation creation
    await user.click(screen.getByRole('button', { name: /highlight/i }));
    expect(mockManager.createAnnotation).toHaveBeenCalled();
  });
});
```

See test files for comprehensive examples:
- [AnnotationContext.test.tsx](../src/contexts/__tests__/AnnotationContext.test.tsx)

---

## Performance Considerations

### Event-Based Cache Invalidation

Annotation data flows through the SDK's read-through cache, so there are **no
manual refetch or invalidation calls** in component code. Subscribing to a
resource's `browse.*` live queries acquires its SSE scope; backend events on the
session bus then drive the cache to refresh automatically. Components that just
need the data read it via `useObservable`:

```typescript
import { useObservable, useSemiont } from '@semiont/react-ui';

function AnnotationsList({ rId }: { rId: ResourceId }) {
  const browser = useSemiont();
  const client = useObservable(browser.activeSession$);
  // Subscribing to this live query acquires the resource scope; the SDK cache
  // keeps it fresh off `mark:added` / `mark:removed` / `mark:body-updated`
  // bus events — no invalidation calls here.
  const annotations = useObservable(client?.browse.annotations(rId)) ?? [];

  return <AnnotationsPanel annotations={annotations} />;
}
```

**Benefits:**

- ✅ Zero manual `refetch()` calls
- ✅ Automatic cache updates from backend changes
- ✅ Real-time collaboration support
- ✅ Consistent cache state across components

### Real-Time Collaboration

The event bus architecture enables real-time collaboration by broadcasting UI events to peers:

```typescript
import { useSemiont, useEventSubscription } from '@semiont/react-ui';

// Local component emits selection event
function TextSelector() {
  const semiont = useSemiont();

  const handleSelection = (selection) => {
    // Emit on the bus
    semiont.emit('ui:mark:select-comment', selection);

    // Future: Broadcast to peers for real-time collaboration
    // peerConnection.broadcast('ui:mark:select-comment', selection);
  };

  return <div onMouseUp={handleSelection}>...</div>;
}

// Other components (local or remote) subscribe to the same event
function CollaborativeAnnotationPanel() {
  useEventSubscription('ui:mark:select-comment', (selection) => {
    // Show peer's selection/annotation in real-time
    showPeerActivity(selection);
  });
}
```

See [EVENTS.md](EVENTS.md) for complete real-time collaboration architecture.

---

## API Reference

### Hooks

- `useResourceAnnotations()` - Annotation mutations and UI state
- `useAnnotationUI()` - UI-only state (sparkle animations)
- `useObservable(client?.browse.annotations(rId))` - Read annotations from the SDK live query

### Utilities

- `getAnnotator(annotation)` - Get annotator for annotation
- `getAnnotationClassName(annotation)` - Get CSS classes
- `getAnnotationInternalType(annotation)` - Get type string
- `groupAnnotationsByType(annotations)` - Group by type
- `withHandlers(handlers)` - Inject runtime handlers
- `client.mark.requestAssist(motivation, options)` - Trigger AI assist (mark state unit runs the job)
- `useObservable(stateUnit.mark.assistingMotivation$)` - Read live assist state

### Types

- `Annotation` - W3C Annotation type
- `AnnotationManager` - Mutation interface
- `Annotator` - Annotator metadata type
- `CreateAnnotationParams` - Creation parameters
- `DeleteAnnotationParams` - Deletion parameters

---

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and event bus
- [SESSION.md](SESSION.md) - Provider Pattern architecture
- [API-INTEGRATION.md](API-INTEGRATION.md) - API client integration
- [TESTING.md](TESTING.md) - Testing strategies
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [W3C Selectors](https://www.w3.org/TR/annotation-model/#selectors)

---

## Contributing

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for contribution guidelines.
