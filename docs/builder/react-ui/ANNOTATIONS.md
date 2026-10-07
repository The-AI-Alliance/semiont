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

```tsx
// react-ui defines the interface: markAnnotation(params) and deleteAnnotation(params)
declare const annotationManager: AnnotationManager; // the app's implementation

// Apps provide it…
<AnnotationProvider annotationManager={annotationManager}>{children}</AnnotationProvider>;

// …and components read it back
function MyComponent() {
  const { markAnnotation, deleteAnnotation } = useAnnotationManager();
  // ...
}
```

Cache freshness is **not** an app responsibility: the SDK's read-through cache
refreshes itself off bus events, so there is no app-provided cache manager.

See [SESSION.md](SESSION.md) for detailed Provider Pattern documentation.

---

## Core Components

### Annotation Creation

#### Generic Creation (Recommended)

All annotation types are created through a single, generic function, `markAnnotation`. It
resolves to the created annotation's id:

```tsx
import type { Selector } from '@semiont/core';
import { useResourceAnnotations } from '@semiont/react-ui';

function MyComponent() {
  const { markAnnotation } = useResourceAnnotations();

  const selector: Selector[] = [
    { type: 'TextPositionSelector', start: 0, end: 11 },
    { type: 'TextQuoteSelector', exact: 'Hello World' },
  ];

  const annotate = async (targetId: ResourceId) => {
    // Create a highlight (no body)
    await markAnnotation(rId, 'highlighting', selector);

    // Create a comment
    await markAnnotation(rId, 'commenting', selector, [
      { type: 'TextualBody', value: 'Great point!', format: 'text/plain', purpose: 'commenting' },
    ]);

    // Create a reference
    await markAnnotation(rId, 'linking', selector, [
      { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
      { type: 'SpecificResource', source: targetId, purpose: 'linking' },
    ]);
  };
  // ...
}
```

#### Annotation Deletion

Deletion goes through the SDK. It resolves once the gateway confirms and rejects on failure:

```typescript
await session.client.mark.delete(rId, annotationId);
```

## Annotation Views

### Resource Viewer

Main component for viewing annotated resources:

```tsx
import { ResourceViewer } from '@semiont/react-ui';

declare const grouped: AnnotationsCollection; // the resource's annotations, bucketed by motivation

<ResourceViewer
  resource={{ ...resource, content }}
  annotations={grouped}
  session={session}
  onOpenResource={(id) => navigate(`/know/resource/${id}`)}
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

The panels and their per-annotation entry rows (`HighlightEntry`, `ReferenceEntry`,
`CommentEntry`, `AssessmentEntry`, `TagEntry`) are **bring-your-own-session**: each takes a
`session: SemiontSession | null` prop and needs no `SemiontProvider` (`JsonLdPanel` is the
one exception). See [COMPONENTS.md](COMPONENTS.md#annotation-panels) for the headless usage
and the entries' interaction contract.

---

## Annotation Registry

Centralized metadata registry for annotation types:

```typescript
import { ANNOTATORS, annotatorKeyForMotivation } from '@semiont/react-ui';

// Access annotator metadata
const highlightAnnotator = ANNOTATORS.highlight;
console.log(highlightAnnotator.displayName); // "Highlight"
console.log(highlightAnnotator.className); // CSS classes
console.log(highlightAnnotator.iconEmoji); // "🟡"

// The annotator an annotation belongs to: each one answers for itself
const annotator = Object.values(ANNOTATORS).find((a) => a.matchesAnnotation(annotation));
if (annotator) {
  // A supported type: group it under annotator.internalType, style it with annotator.className
}

// The registry key for a W3C motivation ('highlighting' → 'highlight')
const key = annotatorKeyForMotivation(annotation.motivation);
```

`UnifiedAnnotationsPanel` takes the registry as its `annotators` prop and groups what it is
given with each annotator's `matchesAnnotation`.

### Annotator Metadata

Each annotator provides the fields of the `Annotator` type:

```typescript
const {
  // W3C standard
  motivation,          // 'highlighting', 'commenting', etc.
  internalType,        // 'highlight'

  // Display
  displayName,         // "Highlight"
  iconEmoji,           // "🟡" (optional)

  // Styling
  className,           // 'annotation-highlight'

  // Type checking
  matchesAnnotation,   // (annotation: Annotation) => boolean

  // Accessibility: what a screen reader hears when one is created
  announceOnCreate,
}: Annotator = ANNOTATORS.highlight;
```

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

```tsx
import { useObservable, useSemiont } from '@semiont/react-ui';

function ReferencesAssist({ stateUnit }: { stateUnit: ResourceViewerPageStateUnit }) {
  const session = useObservable(useSemiont().activeSession$);

  // Read live assist state from the mark state unit
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;

  const handleDetect = () => {
    // requestAssist emits the local 'mark:assist-request' event; the mark
    // state unit picks it up and runs client.mark.delegate(...) for the job.
    // The request carries the job's params, its motivation among them.
    session?.client.mark.requestAssist({
      motivation: 'linking',
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

`mark.delegate(resourceId, params)` dispatches a `job:create` request
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

---

## Image Annotations

### SVG Drawing Canvas

```tsx
import { SvgDrawingCanvas } from '@semiont/react-ui';

declare const imageUrl: string; // the image's media URL

<SvgDrawingCanvas
  imageUrl={imageUrl}
  resourceUri={rId}
  existingAnnotations={annotations}
  drawingMode="rectangle" // 'rectangle', 'circle', 'polygon'
  selectedMotivation="highlighting"
  session={session}
  hoveredAnnotationId={hoveredAnnotationId}
/>
```

The canvas takes no callbacks: drawing a shape calls `session.client.mark.request(...)`, which
emits `mark:requested` with an `SvgSelector`, and clicking an existing shape emits `browse:click`.

### Supported Shapes

- Rectangle
- Circle
- Polygon

---

## W3C Annotation Model

### Annotation Structure

```typescript
const highlight: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId,
  motivation: 'highlighting',
  created: '2025-01-03T12:00:00Z',
  target: {
    source: resourceId,
    selector: [
      { type: 'TextPositionSelector', start: 0, end: 11 },
      { type: 'TextQuoteSelector', exact: 'Hello World', prefix: '', suffix: '! This is' },
    ],
  },
  // No body: a highlight's motivation says everything
};
```

`creator`, `generator` and `wasAttributedTo` are derived by the knowledge base at write time,
never supplied by the emitter.

### Selectors

**Text Selectors:**
- `TextPositionSelector` - Character offsets (start, end)
- `TextQuoteSelector` - Exact text + context (prefix, suffix)

**Image Selectors:**
- `SvgSelector` - SVG path for image regions

### Bodies

Each body is a `BodyItem`: a `TextualBody` states text, a `SpecificResource` points at a resource.

```typescript
// Tagging
const tag: BodyItem = { type: 'TextualBody', value: 'Person', purpose: 'tagging' };

// Commenting
const comment: BodyItem = {
  type: 'TextualBody',
  value: 'Great point!',
  format: 'text/plain',
  purpose: 'commenting',
};

// Linking: the target resource's id
const link: BodyItem = { type: 'SpecificResource', source: resourceId, purpose: 'linking' };
```

---

## Markdown Integration

### Overlay Annotations

`toOverlayAnnotations` (in `annotation-overlay.ts`) converts W3C annotations to the overlay
format BrowseView paints:

```typescript
for (const { id, exact, offset, length, type, source } of toOverlayAnnotations(annotations)) {
  // offset, length: the TextPositionSelector span in the markdown source
  // type: the matching annotator's internalType ('highlight', 'comment', …)
  // source: the resource a SpecificResource body links to, else null
}
```

---

## CodeMirror Integration

### Annotation Rendering

```tsx
import { CodeMirrorRenderer } from '@semiont/react-ui';

function AnnotatedSource({ segments }: { segments: TextSegment[] }) {
  const { sparkleAnnotationIds } = useResourceAnnotations();

  return (
    <CodeMirrorRenderer
      content={content}
      segments={segments}
      session={session}
      sparkleAnnotationIds={sparkleAnnotationIds}
      hoveredAnnotationId={hoveredAnnotationId}
      showLineNumbers={true}
      enableWidgets={true}
      hoverDelayMs={HOVER_DELAY_MS}
    />
  );
}
```

Clicks and hovers on annotated text go through `session`: a click emits `browse:click`, and a
hover emits `beckon:hover` once the pointer has dwelt for `hoverDelayMs`.

### Text Segmentation

`TextAnnotateRenderer` derives the segments with `segmentTextWithAnnotations(content, annotations)`.
Each `TextSegment` is one run of the content:

```typescript
declare const segments: TextSegment[];

for (const { exact, start, end, annotation, strategy, confidence } of segments) {
  // exact === content.slice(start, end)
  // annotation, strategy, confidence: present only on annotated segments
}
```

---

## Testing

### Test Examples

See test files for comprehensive examples:
- [AnnotationContext.test.tsx](../../../packages/react-ui/src/contexts/__tests__/AnnotationContext.test.tsx)

---

## Performance Considerations

### Event-Based Cache Invalidation

Annotation data flows through the SDK's read-through cache, so there are **no
manual refetch or invalidation calls** in component code. Subscribing to a
resource's `browse.*` live queries acquires its SSE scope; gateway events on the
session bus then drive the cache to refresh automatically. Components that just
need the data read it via `useObservable`:

```tsx
import { useObservable, useSemiont } from '@semiont/react-ui';
import { readyValue } from '@semiont/sdk';

function AnnotationsList({ rId }: { rId: ResourceId }) {
  const browser = useSemiont();
  const client = useObservable(browser.activeSession$)?.client;
  // Subscribing to this live query acquires the resource scope; the SDK cache
  // keeps it fresh off `mark:added` / `mark:removed` / `mark:body-updated`
  // bus events — no invalidation calls here. Emissions are
  // CacheState<Annotation[]>; readyValue projects out the ready value.
  const state = useObservable(client?.browse.annotations(rId));
  const annotations = (state && readyValue(state)) ?? [];

  return <ul>{annotations.map((a) => <li key={a.id}>{a.id}</li>)}</ul>;
}
```

**Benefits:**

- ✅ Zero manual `refetch()` calls
- ✅ Automatic cache updates from gateway changes
- ✅ Real-time collaboration support
- ✅ Consistent cache state across components

### Real-Time Collaboration

Some UI events cross between participants. `browse.click` opens an annotation on this viewer's
screen only; `beckon.click` sends the same `browse:click` over the wire to every other participant,
where it arrives on their session bus and the same subscribers handle it:

```tsx
import { useEventSubscription } from '@semiont/react-ui';

// Open an annotation for this viewer: a local emit
session.client.browse.click(annotationId);

// Open it on every other participant's screen: over the wire. Resolves with
// how many subscribers it reached, or undefined when the transport doesn't count
const reached = await session.client.beckon.click(annotationId);

// Subscribers handle a local and a remote click alike
function ClickLog() {
  useEventSubscription('browse:click', ({ annotationId }) => {
    console.log('opened', annotationId);
  });
  return null;
}
```

See [EVENTS.md](EVENTS.md) for complete real-time collaboration architecture.

---

## API Reference

### Hooks

- `useResourceAnnotations()` - Annotation mutations and UI state
- `useObservable(client?.browse.annotations(rId))` - Read annotations from the SDK live query

### Utilities

- `ANNOTATORS` - The registry: one `Annotator` per annotation type
- `annotatorKeyForMotivation(motivation)` - The registry key for a W3C motivation
- `client.mark.requestAssist(params)` - Trigger AI assist with a `mark` job's params (mark state unit runs the job)
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
