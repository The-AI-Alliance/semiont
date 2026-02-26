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

interface CacheManager {
  invalidateAnnotations: (rUri: ResourceUri) => void | Promise<void>;
  invalidateEvents: (rUri: ResourceUri) => void | Promise<void>;
}

// Apps provide implementations
const annotationManager = useAnnotationManager(); // App-specific
const cacheManager = useCacheManager(); // App-specific
```

See [PROVIDERS.md](PROVIDERS.md) for detailed Provider Pattern documentation.

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
  await createAnnotation(rUri, 'highlighting', [
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
  await createAnnotation(rUri, 'commenting', selector, {
    type: 'TextualBody',
    value: 'Great point!',
    format: 'text/plain',
    purpose: 'commenting',
  });

  // Create a reference
  await createAnnotation(rUri, 'linking', selector, [
    { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
    { type: 'SpecificResource', source: targetDocId, purpose: 'linking' }
  ]);
}
```

#### Annotation Deletion

```typescript
const { deleteAnnotation } = useResourceAnnotations();

await deleteAnnotation(annotationId, rUri);
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
  resourceUri={rUri}
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
    onHover: (annotationId) => { /* ... */ },
    onDetect: async () => { /* AI detection */ }
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

### Detection Context

The annotation registry supports AI-powered entity detection via SSE (Server-Sent Events). Detection events flow through the unified event bus:

```typescript
import { createDetectionHandler, ANNOTATORS } from '@semiont/react-ui';

const detectionContext = {
  client: apiClient,
  rUri,
  setDetectingMotivation,
  setMotivationDetectionProgress,
  detectionStreamRef,
  cacheManager, // ✅ Framework-agnostic
  showSuccess,
  showError
};

const annotators = withHandlers({
  highlight: {
    onDetect: createDetectionHandler(ANNOTATORS.highlight!, detectionContext)
  }
});
```

### Detection Lifecycle Events

Detection jobs emit events through the `MakeMeaningEventBusProvider`:

- `detection:started` - Detection job initiated
- `detection:progress` - Progress updates during detection
- `detection:entity-found` - New entity annotation detected
- `detection:completed` - Detection job finished successfully
- `detection:failed` - Detection job failed

Components subscribe to these events for automatic cache invalidation:

```typescript
import { useMakeMeaningEvents } from '@semiont/react-ui';

function DetectionMonitor() {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handler = () => {
      // Automatically invalidate cache when detection completes
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    eventBus.on('detection:completed', handler);
    return () => eventBus.off('detection:completed', handler);
  }, [eventBus, queryClient, rUri]);
}
```

See [EVENTS.md](EVENTS.md) for complete event documentation.

### Detection Configuration

Each annotator can define detection capabilities:

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
  resourceUri={rUri}
  existingAnnotations={imageAnnotations}
  drawingMode={selectedShape} // 'rectangle', 'circle', 'polygon'
  selectedMotivation={motivation}
  onAnnotationCreate={async (svg, position) => {
    await createAnnotation(rUri, motivation, {
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
- [AnnotationUIContext.test.tsx](../src/contexts/__tests__/AnnotationUIContext.test.tsx)
- [CacheContext.test.tsx](../src/contexts/__tests__/CacheContext.test.tsx)

---

## Performance Considerations

### Event-Based Cache Invalidation

The annotation system uses **event-driven cache invalidation** instead of manual refetch calls. Backend events flow through the `MakeMeaningEventBusProvider` and trigger automatic cache updates:

```typescript
import { useMakeMeaningEvents } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';

function AnnotationCacheManager({ rUri }: { rUri: ResourceUri }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Automatically invalidate cache when annotations change
    const handleAnnotationAdded = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    const handleAnnotationRemoved = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    const handleAnnotationUpdated = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    eventBus.on('annotate:added', handleAnnotationAdded);
    eventBus.on('annotate:removed', handleAnnotationRemoved);
    eventBus.on('annotate:body-updated', handleAnnotationUpdated);

    return () => {
      eventBus.off('annotate:added', handleAnnotationAdded);
      eventBus.off('annotate:removed', handleAnnotationRemoved);
      eventBus.off('annotate:body-updated', handleAnnotationUpdated);
    };
  }, [eventBus, queryClient, rUri]);

  return null;
}
```

**Benefits:**

- ✅ Zero manual `refetch()` calls
- ✅ Automatic cache updates from backend changes
- ✅ Real-time collaboration support
- ✅ Consistent cache state across components

### Legacy CacheManager (Deprecated)

The `CacheManager` interface is deprecated in favor of event-based cache invalidation:

```typescript
// ❌ OLD: Manual cache invalidation via CacheManager
const cacheManager: CacheManager = {
  invalidateAnnotations: (rUri) => {
    queryClient.invalidateQueries({ queryKey: ['annotations', rUri] });
  },
  invalidateEvents: (rUri) => {
    queryClient.invalidateQueries({ queryKey: ['documents', 'events', rUri] });
  }
};

// ✅ NEW: Event-based cache invalidation
// Subscribe to events, no manual invalidation needed
```

### Real-Time Collaboration

The event bus architecture enables real-time collaboration by broadcasting UI events to peers:

```typescript
import { useMakeMeaningEvents } from '@semiont/react-ui';

// Local component emits selection event
function TextSelector() {
  const eventBus = useMakeMeaningEvents();

  const handleSelection = (selection) => {
    // Emit locally
    eventBus.emit('ui:annotate:select-comment', selection);

    // Future: Broadcast to peers for real-time collaboration
    // peerConnection.broadcast('ui:annotate:select-comment', selection);
  };

  return <div onMouseUp={handleSelection}>...</div>;
}

// Other components (local or remote) subscribe to the same event
function CollaborativeAnnotationPanel() {
  const eventBus = useMakeMeaningEvents();

  useEffect(() => {
    const handler = (selection) => {
      // Show peer's selection/annotation in real-time
      showPeerActivity(selection);
    };

    eventBus.on('ui:annotate:select-comment', handler);
    return () => eventBus.off('ui:annotate:select-comment', handler);
  }, [eventBus]);
}
```

See [EVENTS.md](EVENTS.md) for complete real-time collaboration architecture.

---

## API Reference

### Hooks

- `useResourceAnnotations()` - Annotation mutations and UI state
- `useAnnotationUI()` - UI-only state (sparkle animations)
- `useAnnotations()` - Low-level API client hooks

### Utilities

- `getAnnotator(annotation)` - Get annotator for annotation
- `getAnnotationClassName(annotation)` - Get CSS classes
- `getAnnotationInternalType(annotation)` - Get type string
- `groupAnnotationsByType(annotations)` - Group by type
- `withHandlers(handlers)` - Inject runtime handlers
- `createDetectionHandler(annotator, context)` - Create AI detection handler

### Types

- `Annotation` - W3C Annotation type
- `AnnotationManager` - Mutation interface
- `CacheManager` - Cache invalidation interface
- `Annotator` - Annotator metadata type
- `CreateAnnotationParams` - Creation parameters
- `DeleteAnnotationParams` - Deletion parameters

---

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and event bus
- [PROVIDERS.md](PROVIDERS.md) - Provider Pattern architecture
- [API-INTEGRATION.md](API-INTEGRATION.md) - API client integration
- [TESTING.md](TESTING.md) - Testing strategies
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
- [W3C Selectors](https://www.w3.org/TR/annotation-model/#selectors)

---

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines.
