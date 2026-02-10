# Event-Driven Architecture

Guide to using the unified event bus in `@semiont/react-ui`.

## Overview

The event bus provides a unified communication channel for both backend events (from make-meaning via SSE) and UI events (local user interactions). This architecture eliminates callback prop drilling and enables real-time collaboration.

**Key Benefits**:

- ✅ Zero callback prop drilling (0 layers vs 4+ layers)
- ✅ No ref stabilization needed
- ✅ Type-safe with discriminated unions
- ✅ Automatic cache invalidation via events
- ✅ Foundation for real-time P2P collaboration
- ✅ Components can be anywhere in tree (no parent-child requirement)

---

## Setup

### 1. Wrap Resource Pages with Provider

The `MakeMeaningEventBusProvider` creates a unified event bus for a specific resource. It must wrap any components that need to emit or subscribe to events.

```tsx
import { MakeMeaningEventBusProvider } from '@semiont/react-ui';
import { resourceUri } from '@semiont/api-client';

export default function ResourcePage({ params }: { params: { id: string } }) {
  const rUri = resourceUri(params.id);

  return (
    <MakeMeaningEventBusProvider rUri={rUri}>
      <ResourceViewerPage rUri={rUri} {...otherProps} />
    </MakeMeaningEventBusProvider>
  );
}
```

**Important**: The provider is resource-scoped, not global. Each resource page gets its own event bus instance.

### 2. Access Event Bus in Components

Use the `useMakeMeaningEvents()` hook to access the event bus:

```tsx
import { useMakeMeaningEvents } from '@semiont/react-ui';

function MyComponent() {
  const eventBus = useMakeMeaningEvents();

  // Now you can emit and subscribe to events
}
```

---

## Event Types

The event bus handles two categories of events:

### Backend Events (from Make-Meaning via SSE)

These events are emitted by the backend when domain changes occur:

**Detection Events**:

- `detection:started` - Entity detection job started
- `detection:progress` - Detection progress update
- `detection:entity-found` - New entity annotation detected
- `detection:completed` - Detection job completed
- `detection:failed` - Detection job failed

**Generation Events**:

- `generation:started` - Document generation job started
- `generation:progress` - Generation progress update
- `generation:resource-created` - New resource generated
- `generation:completed` - Generation job completed

**Annotation Events**:

- `annotation:added` - New annotation created
- `annotation:removed` - Annotation deleted
- `annotation:updated` - Annotation body updated

**Entity Tag Events**:

- `entity-tag:added` - New entity tag added
- `entity-tag:removed` - Entity tag removed

**Resource Events**:

- `resource:archived` - Resource archived
- `resource:unarchived` - Resource unarchived

### UI Events (Local User Interactions)

These events are emitted by components when users interact with the UI:

**Selection Events**:

- `ui:selection:comment-requested` - User selected text to comment
- `ui:selection:tag-requested` - User selected text to tag
- `ui:selection:assessment-requested` - User selected text to assess
- `ui:selection:reference-requested` - User selected text/image to reference

---

## Usage Patterns

### Pattern 1: Subscribe to Backend Events (Cache Invalidation)

Backend events automatically invalidate React Query cache:

```tsx
import { useMakeMeaningEvents } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';

function MyComponent({ rUri }: { rUri: ResourceUri }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handler = (event) => {
      // Backend added annotation → invalidate cache
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    eventBus.on('annotation:added', handler);
    return () => eventBus.off('annotation:added', handler);
  }, [eventBus, queryClient, rUri]);
}
```

**Why this works**: Backend events flow via `SSE → EventBus → Component → Cache Invalidation`. No manual `refetch()` calls needed.

### Pattern 2: Emit UI Events (Cross-Component Communication)

Components emit UI events instead of calling callback props:

```tsx
import { useMakeMeaningEvents } from '@semiont/react-ui';

function TextSelector() {
  const eventBus = useMakeMeaningEvents();

  const handleTextSelection = (selection: { exact: string; start: number; end: number }) => {
    // Emit event instead of calling a callback prop
    eventBus.emit('ui:selection:comment-requested', {
      exact: selection.exact,
      start: selection.start,
      end: selection.end,
      prefix: extractPrefix(selection.start),
      suffix: extractSuffix(selection.end)
    });
  };

  return <div onMouseUp={handleTextSelection}>...</div>;
}
```

**Benefits**:

- No callback props needed
- No ref stabilization required
- Component doesn't need to know who handles the event

### Pattern 3: Subscribe to UI Events

Other components subscribe to UI events to react to user interactions:

```tsx
import { useMakeMeaningEvents } from '@semiont/react-ui';

function AnnotationPanel() {
  const eventBus = useMakeMeaningEvents();
  const [pendingAnnotation, setPendingAnnotation] = useState(null);

  useEffect(() => {
    const handler = (selection) => {
      // User requested a comment → open annotation panel
      setActivePanel('annotations');
      setPendingAnnotation({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          prefix: selection.prefix,
          suffix: selection.suffix
        },
        motivation: 'commenting'
      });
    };

    eventBus.on('ui:selection:comment-requested', handler);
    return () => eventBus.off('ui:selection:comment-requested', handler);
  }, [eventBus]);

  return <div>{/* Render annotation form */}</div>;
}
```

### Pattern 4: Type-Safe Event Handling

Events are fully type-safe using discriminated unions:

```tsx
import { useMakeMeaningEvents } from '@semiont/react-ui';
import type { ResourceEvent } from '@semiont/core';

function DetectionMonitor() {
  const eventBus = useMakeMeaningEvents();

  useEffect(() => {
    // Type is automatically narrowed to Extract<ResourceEvent, { type: 'job.started' }>
    const onStarted = (event) => {
      console.log('Detection started:', event.data.jobId);
      // event.data is typed correctly based on event type
    };

    // Type is narrowed to Extract<ResourceEvent, { type: 'job.progress' }>
    const onProgress = (event) => {
      console.log('Progress:', event.data.percentage);
    };

    eventBus.on('detection:started', onStarted);
    eventBus.on('detection:progress', onProgress);

    return () => {
      eventBus.off('detection:started', onStarted);
      eventBus.off('detection:progress', onProgress);
    };
  }, [eventBus]);
}
```

---

## Complete Example

Here's a complete example showing event emission and subscription:

```tsx
// Component that emits events (ResourceViewer)
function ResourceViewer({ content }: { content: string }) {
  const eventBus = useMakeMeaningEvents();

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) return;

    // Emit UI event
    eventBus.emit('ui:selection:comment-requested', {
      exact: selection.toString(),
      start: getSelectionStart(),
      end: getSelectionEnd(),
      prefix: extractPrefix(),
      suffix: extractSuffix()
    });
  };

  return <div onMouseUp={handleTextSelection}>{content}</div>;
}

// Component that subscribes to events (ResourceViewerPage)
function ResourceViewerPage({ rUri }: { rUri: ResourceUri }) {
  const eventBus = useMakeMeaningEvents();
  const [pendingAnnotation, setPendingAnnotation] = useState(null);

  // Subscribe to UI events
  useEffect(() => {
    const handleCommentRequested = (selection) => {
      setPendingAnnotation({
        selector: {
          type: 'TextQuoteSelector',
          exact: selection.exact,
          start: selection.start,
          end: selection.end,
          prefix: selection.prefix,
          suffix: selection.suffix
        },
        motivation: 'commenting'
      });
    };

    eventBus.on('ui:selection:comment-requested', handleCommentRequested);
    return () => eventBus.off('ui:selection:comment-requested', handleCommentRequested);
  }, [eventBus]);

  // Subscribe to backend events for cache invalidation
  const queryClient = useQueryClient();
  useEffect(() => {
    const handleAnnotationAdded = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    eventBus.on('annotation:added', handleAnnotationAdded);
    return () => eventBus.off('annotation:added', handleAnnotationAdded);
  }, [eventBus, queryClient, rUri]);

  return (
    <div>
      <ResourceViewer content="..." />
      {pendingAnnotation && <AnnotationForm pending={pendingAnnotation} />}
    </div>
  );
}

// Root page wraps with provider
export default function Page({ params }: { params: { id: string } }) {
  const rUri = resourceUri(params.id);

  return (
    <MakeMeaningEventBusProvider rUri={rUri}>
      <ResourceViewerPage rUri={rUri} />
    </MakeMeaningEventBusProvider>
  );
}
```

---

## Best Practices

### 1. Always Clean Up Event Listeners

Use the cleanup function returned by `useEffect`:

```tsx
useEffect(() => {
  const handler = (event) => {
    // Handle event
  };

  eventBus.on('annotation:added', handler);
  return () => eventBus.off('annotation:added', handler); // ✅ Cleanup
}, [eventBus]);
```

### 2. Use Discriminated Unions for Type Safety

Extract specific event types for type narrowing:

```tsx
import type { ResourceEvent } from '@semiont/core';

type AnnotationAddedEvent = Extract<ResourceEvent, { type: 'annotation.added' }>;

const handler = (event: AnnotationAddedEvent) => {
  // event.data is correctly typed as AnnotationAddedData
  console.log(event.data.annotation);
};
```

### 3. Emit Events, Don't Call Callbacks

**Before (callback props)**:

```tsx
// ❌ BAD: Callback prop drilling
interface Props {
  onCommentRequested: (selection: Selection) => void;
}

function Component({ onCommentRequested }: Props) {
  onCommentRequested(selection); // Requires prop drilling
}
```

**After (events)**:

```tsx
// ✅ GOOD: Event emission
function Component() {
  const eventBus = useMakeMeaningEvents();
  eventBus.emit('ui:selection:comment-requested', selection); // No props needed
}
```

### 4. Subscribe to Events for Cache Invalidation

**Before (manual refetch)**:

```tsx
// ❌ BAD: Manual refetch after mutation
const createAnnotation = async () => {
  await api.createAnnotation(...);
  await queryClient.refetchQueries(['annotations']); // Manual refetch
};
```

**After (event-based)**:

```tsx
// ✅ GOOD: Automatic via events
useEffect(() => {
  const handler = () => {
    queryClient.invalidateQueries(['annotations', rUri]);
  };

  eventBus.on('annotation:added', handler);
  return () => eventBus.off('annotation:added', handler);
}, [eventBus, queryClient, rUri]);
```

---

## Future: Real-Time Collaboration

The unified event bus architecture enables P2P real-time collaboration:

```tsx
// Future: Broadcast UI events to peers
function CollaborativeTextSelector() {
  const eventBus = useMakeMeaningEvents();
  const peerConnection = usePeerConnection();

  const handleSelection = (selection) => {
    // Emit locally
    eventBus.emit('ui:selection:comment-requested', selection);

    // Broadcast to peers
    peerConnection.broadcast('ui:selection:comment-requested', selection);
  };

  // Show peer cursors
  useEffect(() => {
    const handler = (selection, peerId) => {
      showPeerCursor(peerId, selection);
    };

    peerConnection.on('ui:selection:comment-requested', handler);
    return () => peerConnection.off('ui:selection:comment-requested', handler);
  }, [peerConnection]);
}
```

---

## Troubleshooting

### Error: "useMakeMeaningEvents must be used within MakeMeaningEventBusProvider"

**Cause**: Component is using `useMakeMeaningEvents()` but is not wrapped in `MakeMeaningEventBusProvider`.

**Solution**: Wrap the component tree with the provider:

```tsx
<MakeMeaningEventBusProvider rUri={rUri}>
  <YourComponent />
</MakeMeaningEventBusProvider>
```

### Events Not Firing

**Causes**:

1. Event listener not registered before event is emitted
2. Event listener cleanup removes handler too early
3. Wrong event name (check spelling/casing)

**Solutions**:

1. Register listeners in `useEffect` on component mount
2. Verify cleanup function only runs on unmount
3. Check event names against `MakeMeaningEventMap` type

### Memory Leaks

**Cause**: Event listeners not cleaned up.

**Solution**: Always return cleanup function:

```tsx
useEffect(() => {
  const handler = (event) => { /* ... */ };
  eventBus.on('event:name', handler);
  return () => eventBus.off('event:name', handler); // ✅ Required
}, [eventBus]);
```

---

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - Event-driven architecture principles
- [PROVIDERS.md](PROVIDERS.md) - MakeMeaningEventBusProvider setup
- [API-INTEGRATION.md](API-INTEGRATION.md) - Event-based cache invalidation
- [ANNOTATIONS.md](ANNOTATIONS.md) - Annotation lifecycle events

---

## References

- Event bus implementation: `packages/react-ui/src/contexts/MakeMeaningEventBusContext.tsx`
- Backend event types: `packages/core/src/events.ts`
- SSE integration: `packages/react-ui/src/hooks/useResourceEvents.ts`
- mitt library: https://github.com/developit/mitt
