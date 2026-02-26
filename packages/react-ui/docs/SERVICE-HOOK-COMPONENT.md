# Service-Hook-Component Architecture

**The three-layer pattern for React + Event Bus integration.**

## Overview

Semiont uses a strict three-layer architecture to separate concerns and maintain clean, testable code:

1. **Service Layer** - SSE stream management (EventBus-native)
2. **Hook Layer** - Event orchestration + React state (`useEventSubscriptions` + `useState`)
3. **Component Layer** - Pure React (hooks + JSX)

This architecture leverages RxJS EventBus for event routing, eliminates callback prop drilling, ensures proper separation of concerns, and makes components highly testable.

---

## The Three Layers

### Layer 1: Service Layer

**Responsibility**: Manage Server-Sent Events (SSE) connections with EventBus-native streams.

**Rules**:
- ✅ Opens and manages SSE connections
- ✅ SSE streams automatically emit to EventBus (no callbacks)
- ✅ Handles connection errors and cleanup
- ❌ NO React state (`useState`, `useEffect` for state)
- ❌ NO JSX rendering
- ❌ NO manual event forwarding (streams are EventBus-native)

**Implementation**: `useResourceEvents` hook

```typescript
// packages/react-ui/src/hooks/useResourceEvents.ts
export function useResourceEvents(rUri: ResourceUri) {
  const eventBus = useEventBus();
  const client = useApiClient();

  useEffect(() => {
    // Open SSE connection - events auto-emit to EventBus
    const stream = client!.sse.resourceEvents(rUri, {
      auth: accessToken(token),
      eventBus  // ← Stream auto-emits to EventBus
    });

    // No callbacks needed - EventBus handles everything
    // Cleanup on unmount
    return () => stream.close();
  }, [rUri, eventBus, client]);
}
```

**Usage**: Called once per resource page, typically in the main page component.

**Key Architecture Points**:
- SSE streams are **EventBus-native** - they emit directly to EventBus
- No manual `eventBus.get(...).next(...)` calls needed
- No callbacks (`onProgress`, `onComplete`, `onError`) - deprecated
- Cleaner separation: SSE layer just manages connections, EventBus handles routing

---

### Layer 2: Hook Layer

**Responsibility**: Orchestrate operations and manage React state.

**Rules**:
- ✅ Subscribes to events using `useEventSubscriptions`
- ✅ Manages state with `useState`
- ✅ Triggers SSE streams via API client (passing `eventBus`)
- ✅ Returns data/state objects
- ❌ NO direct `eventBus.get().subscribe()` calls (use `useEventSubscriptions`)
- ❌ NO JSX rendering
- ❌ NO manual event forwarding

**Example**: `useDetectionFlow` hook

```typescript
// packages/react-ui/src/hooks/useDetectionFlow.ts
export interface DetectionFlowState {
  detectingMotivation: Motivation | null;
  detectionProgress: DetectionProgress | null;
}

export function useDetectionFlow(rUri: ResourceUri): DetectionFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();
  const token = useAuthToken();

  // State management
  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [detectionProgress, setDetectionProgress] = useState<DetectionProgress | null>(null);

  // API operations: Start SSE stream when 'detection:start' event is emitted
  useEffect(() => {
    const handleDetectionStart = async (event: { motivation: Motivation; options: any }) => {
      setDetectingMotivation(event.motivation);
      setDetectionProgress(null);

      // Start SSE stream - events auto-emit to EventBus
      client.sse.detectReferences(rUri, event.options, {
        auth: accessToken(token),
        eventBus  // ← Stream auto-emits detection:progress, detection:complete, detection:failed
      });
    };

    const sub = eventBus.get('detection:start').subscribe(handleDetectionStart);
    return () => sub.unsubscribe();
  }, [eventBus, rUri, client, token]);

  // State subscriptions (update state when SSE events arrive)
  useEventSubscriptions({
    'detection:progress': (chunk) => {
      setDetectionProgress(chunk);
    },
    'detection:complete': ({ motivation }) => {
      setDetectingMotivation(current => motivation === current ? null : current);
    },
    'detection:failed': () => {
      setDetectingMotivation(null);
      setDetectionProgress(null);
    },
  });

  // Return data only (no JSX)
  return { detectingMotivation, detectionProgress };
}
```

**Key Points**:
- Uses `useEventSubscriptions` for automatic cleanup
- Starts SSE streams with `eventBus` parameter (EventBus-native)
- Returns plain data objects
- No JSX rendering

---

### Layer 3: Component Layer

**Responsibility**: Render UI and handle user interactions.

**Rules**:
- ✅ Calls hooks to get data
- ✅ Emits events for user actions (via `eventBus.get(...).next(...)`)
- ✅ Renders JSX
- ❌ NO direct `eventBus.get(...).subscribe()` (use hooks)
- ❌ NO SSE stream creation (use hooks)
- ❌ NO SSE parsing

**Example**: Component using hooks

```typescript
// packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx
export function ResourceViewerPage({ rUri, resource, ... }: ResourceViewerPageProps) {
  // Layer 2: Get data from hooks
  const { detectingMotivation, detectionProgress } = useDetectionFlow(rUri);
  const { activePanel, scrollToAnnotationId } = usePanelNavigation();

  // Layer 1: SSE connection
  useResourceEvents(rUri);

  // Event emission (user interaction)
  const eventBus = useEventBus();
  const handleDetectClick = useCallback(() => {
    eventBus.get('detection:start').next({
      motivation: 'linking',
      options: { entityTypes: ['Person', 'Organization'] }
    });
  }, [eventBus]);

  // Layer 3: Render JSX
  return (
    <div className="resource-viewer">
      <Toolbar onDetect={handleDetectClick} />
      <ResourceViewer
        content={content}
        detectingMotivation={detectingMotivation}
        detectionProgress={detectionProgress}
      />
      <AnnotationPanel
        annotations={annotations}
        pendingAnnotation={pendingAnnotation}
        activePanel={activePanel}
      />
    </div>
  );
}
```

---

## Layer Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Component (ResourceViewerPage)                     │
│                                                              │
│  - Calls hooks to get data                                  │
│  - Emits events for user actions                            │
│  - Renders JSX                                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ uses hooks
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: Hooks (useDetectionFlow, usePanelNavigation)       │
│                                                              │
│  - useEventSubscriptions() → updates state                  │
│  - useState() → manages state                               │
│  - Returns data objects                                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ subscribes to
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Event Bus (RxJS)                                             │
│                                                              │
│  - Routes events between layers                             │
│  - Type-safe event contracts                                │
│  - Direct SSE integration (no manual forwarding)            │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ auto-emits from SSE streams
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Service (useResourceEvents)                        │
│                                                              │
│  - Opens SSE connection                                     │
│  - Passes eventBus to stream                                │
│  - Stream auto-emits to EventBus                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Complete Example

### Layer 1: Service (SSE Connection)

```typescript
// In ResourceViewerPage.tsx
export function ResourceViewerPage({ rUri, ... }: ResourceViewerPageProps) {
  // Layer 1: Establish SSE connection for this resource
  useResourceEvents(rUri);

  // ... rest of component
}
```

The service layer runs automatically once per resource page.

### Layer 2: Hooks (State Management)

```typescript
// packages/react-ui/src/hooks/useDetectionFlow.ts
export function useDetectionFlow(rUri: ResourceUri): DetectionFlowState {
  const eventBus = useEventBus();
  const [detecting, setDetecting] = useState<Motivation | null>(null);
  const [progress, setProgress] = useState<DetectionProgress | null>(null);

  // Subscribe to events and update state
  useEventSubscriptions({
    'detection:start': ({ motivation }) => setDetecting(motivation),
    'detection:progress': (chunk) => setProgress(chunk),
    'detection:complete': () => setDetecting(null),
    'detection:failed': () => {
      setDetecting(null);
      setProgress(null);
    },
  });

  return { detecting, progress };
}
```

### Layer 3: Component (UI)

```typescript
// packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx
export function ResourceViewerPage({ rUri, ... }: ResourceViewerPageProps) {
  const eventBus = useEventBus();

  // Use hooks to get state (Layer 2)
  const { detecting, progress } = useDetectionFlow(rUri);

  // Emit events for user actions
  const handleDetect = useCallback(() => {
    eventBus.emit('detection:start', {
      motivation: 'linking',
      options: { entityTypes: ['Person'] }
    });
  }, [eventBus]);

  // Render UI
  return (
    <div>
      <button onClick={handleDetect} disabled={!!detecting}>
        {detecting ? 'Detecting...' : 'Detect Entities'}
      </button>
      {progress && <ProgressBar message={progress.message} />}
    </div>
  );
}
```

---

## Before and After: MAKE-IT-STOP Refactoring

### Before: Render Props Pattern (❌ BAD)

```typescript
// 4 levels of nested render props = 636 lines of indirection
function ResourceViewerPage({ rUri, ... }) {
  return (
    <DetectionFlowContainer rUri={rUri}>
      {(detectionState) => (
        <PanelNavigationContainer>
          {(navState) => (
            <AnnotationFlowContainer>
              {(annotationState) => (
                <GenerationFlowContainer>
                  {(generationState) => (
                    <ResourceViewerPageContent
                      {...detectionState}
                      {...navState}
                      {...annotationState}
                      {...generationState}
                    />
                  )}
                </GenerationFlowContainer>
              )}
            </AnnotationFlowContainer>
          )}
        </PanelNavigationContainer>
      )}
    </DetectionFlowContainer>
  );
}
```

**Problems**:
- 4 container components (636 lines)
- Nested render props (hard to read)
- Wrapper component just for prop spreading
- Total: ~1,370 lines of indirection

### After: Hook-Based Pattern (✅ GOOD)

```typescript
// Direct hook calls = 0 indirection
function ResourceViewerPage({ rUri, resource, ... }: ResourceViewerPageProps) {
  // Layer 2: Get data from hooks
  const { detectingMotivation, detectionProgress } = useDetectionFlow(rUri);
  const { activePanel, scrollToAnnotationId } = usePanelNavigation();
  const { generationModalOpen } = useGenerationFlow(locale, rUri, ...);

  // Layer 1: SSE connection
  useResourceEvents(rUri);

  // Layer 3: Render UI directly
  return (
    <div className="resource-viewer">
      <Toolbar {...} />
      <ResourceViewer
        detectingMotivation={detectingMotivation}
        detectionProgress={detectionProgress}
        {...}
      />
      <AnnotationPanel
        pendingAnnotation={pendingAnnotation}
        activePanel={activePanel}
        {...}
      />
    </div>
  );
}
```

**Results**:
- 4 hooks (200 lines) replace 4 containers (636 lines)
- No nested render props
- No wrapper components
- Total: ~450 lines (67% reduction)

---

## Common Patterns

### Pattern 1: Event Emission (User Actions)

Components emit events instead of calling callbacks:

```typescript
function Toolbar() {
  const eventBus = useEventBus();

  const handleDetect = () => {
    // Emit event instead of calling callback prop
    eventBus.emit('detection:start', {
      motivation: 'linking',
      options: { entityTypes: ['Person', 'Organization'] }
    });
  };

  return <button onClick={handleDetect}>Detect</button>;
}
```

### Pattern 2: Event Subscription (State Updates)

Hooks subscribe to events using `useEventSubscriptions`:

```typescript
export function useDetectionFlow(rUri: ResourceUri) {
  const [detecting, setDetecting] = useState(null);

  // ✅ CORRECT: Use useEventSubscriptions
  useEventSubscriptions({
    'detection:start': ({ motivation }) => setDetecting(motivation),
    'detection:complete': () => setDetecting(null),
  });

  return { detecting };
}

// ❌ WRONG: Manual eventBus.on() in hooks
export function useDetectionFlow(rUri: ResourceUri) {
  const eventBus = useEventBus();
  const [detecting, setDetecting] = useState(null);

  useEffect(() => {
    // Don't do this - use useEventSubscriptions instead
    eventBus.on('detection:start', ({ motivation }) => setDetecting(motivation));
    return () => eventBus.off('detection:start', ...);
  }, [eventBus]);

  return { detecting };
}
```

### Pattern 3: Event Operations (API Triggers)

Use `useEventOperations` to trigger API calls when events are emitted:

```typescript
export function useDetectionFlow(rUri: ResourceUri) {
  const eventBus = useEventBus();
  const client = useApiClient();

  // Triggers API calls when 'detection:start' event is emitted
  useEventOperations(eventBus, { client, resourceUri: rUri });

  // ... state management
}
```

---

## Compliance and Invariants

The codebase enforces layer separation through automated compliance checks:

### Automated Checks

Run compliance audit:

```bash
npm run audit:compliance
```

### Layer Separation Violations (❌ Critical)

These violations will cause the compliance audit to fail:

1. **Components using `eventBus.on()`**
   - Should use: `useEventSubscriptions` hook
   - Detection: AST analysis finds `eventBus.on()` calls in component files

2. **Components using `eventBus.off()`**
   - Should use: `useEventSubscriptions` (handles cleanup automatically)
   - Detection: AST analysis finds `eventBus.off()` calls in component files

3. **Components creating `new EventSource()`**
   - Should use: `useResourceEvents` hook
   - Detection: AST analysis finds `new EventSource()` in component files

4. **Hooks returning JSX**
   - Should return: Data objects only
   - Detection: AST analysis finds JSX return statements in hook files

5. **Global eventBus imports**
   - Should use: `useEventBus()` hook
   - Detection: AST analysis finds `import { eventBus }` statements

### Compliance Report

The automated compliance checker generates detailed reports:

```
Layer Separation Violations (❌)
- Components using eventBus.on(): 0 (should use useEventSubscriptions)
- Components using eventBus.off(): 0 (useEventSubscriptions handles cleanup)
- Components creating EventSource: 0 (should use useResourceEvents)
- Hooks returning JSX: 0 (hooks should return data, not JSX)
- Global eventBus imports: 0 (should use useEventBus() hook)
```

See [RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md](../../../RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md) for the complete list of architectural invariants.

---

## Testing the Three Layers

### Layer 1: Service Tests

Test SSE connection and event emission:

```typescript
it('should emit detection:progress events from SSE', async () => {
  const mockStream = createMockSSEStream();
  const eventBus = createEventBus();

  // Setup SSE connection
  useResourceEvents(testUri);

  // Simulate SSE data
  mockStream.onProgressCallback({
    type: 'detection:progress',
    payload: { message: 'Scanning...' }
  });

  // Verify event was emitted
  expect(eventBus).toHaveEmitted('detection:progress', {
    message: 'Scanning...'
  });
});
```

### Layer 2: Hook Tests

Test state management and event subscriptions:

```typescript
it('should update state when detection starts', () => {
  const { result } = renderHook(() => useDetectionFlow(testUri), {
    wrapper: EventBusProvider
  });

  // Emit event
  act(() => {
    eventBus.emit('detection:start', {
      motivation: 'linking',
      options: { entityTypes: ['Person'] }
    });
  });

  // Verify state updated
  expect(result.current.detectingMotivation).toBe('linking');
});
```

### Layer 3: Component Tests

Test UI rendering and event emission:

```typescript
it('should emit detection:start when button clicked', async () => {
  const eventBus = createEventBus();

  render(
    <EventBusProvider value={eventBus}>
      <ResourceViewerPage rUri={testUri} {...props} />
    </EventBusProvider>
  );

  // Click detect button
  fireEvent.click(screen.getByText('Detect Entities'));

  // Verify event was emitted
  expect(eventBus).toHaveEmitted('detection:start', {
    motivation: 'linking'
  });
});
```

---

## Migration Guide

### From Render Props Containers to Hooks

1. **Identify container logic**:
   - Find `useState` calls
   - Find `useEventSubscriptions` calls
   - Find what data is returned to children

2. **Extract to hook**:
   ```typescript
   // Before: Container
   function DetectionFlowContainer({ children }) {
     const [detecting, setDetecting] = useState(null);
     useEventSubscriptions({
       'detection:start': ({ motivation }) => setDetecting(motivation),
     });
     return <>{children({ detecting })}</>;
   }

   // After: Hook
   export function useDetectionFlow(rUri: ResourceUri) {
     const [detecting, setDetecting] = useState(null);
     useEventSubscriptions({
       'detection:start': ({ motivation }) => setDetecting(motivation),
     });
     return { detecting };
   }
   ```

3. **Update component to use hook**:
   ```typescript
   // Before
   <DetectionFlowContainer>
     {({ detecting }) => <div>{detecting}</div>}
   </DetectionFlowContainer>

   // After
   const { detecting } = useDetectionFlow(rUri);
   return <div>{detecting}</div>;
   ```

4. **Delete container file**
5. **Update exports**
6. **Update tests**

---

## Future: RxJS Migration

The three-layer architecture is designed to support a future migration from mitt to RxJS:

### Current (Mitt-Based)

- Layer 1: SSE → mitt events
- Layer 2: `useEventSubscriptions` + `useState`
- Layer 3: Pure React

### Future (RxJS-Based)

- Layer 1: SSE → `Observable` streams
- Layer 2: Hooks subscribe to `Observable`s
- Layer 3: Pure React (unchanged)

The layer separation principles remain the same. See [RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md](../../../RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md) for details on the future RxJS architecture.

---

## Related Documentation

- [EVENTS.md](EVENTS.md) - Event bus usage and event types
- [ARCHITECTURE.md](ARCHITECTURE.md) - Overall architecture principles
- [TESTING.md](TESTING.md) - Testing strategies
- [RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md](../../../RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md) - Architectural invariants

---

## Quick Reference

### ✅ DO

- **Components**: Call hooks, emit events, render JSX
- **Hooks**: Use `useEventSubscriptions`, manage state with `useState`, return data objects
- **Service**: Manage SSE connections with `useResourceEvents`

### ❌ DON'T

- **Components**: Direct `eventBus.on()`, `new EventSource()`, SSE parsing
- **Hooks**: Return JSX, create SSE connections
- **Service**: Manage React state, render UI

### Key Hooks

- `useEventBus()` - Access event bus (for emitting events)
- `useEventSubscriptions()` - Subscribe to events (for receiving events)
- `useResourceEvents()` - Establish SSE connection
- `useDetectionFlow()` - Detection state management (SSE, progress, annotation operations)
- `useResolutionFlow()` - Annotation body update and reference linking
- `useGenerationFlow()` - Generation state management (SSE, modal, progress)
- `useContextCorrelationFlow()` - Context correlation for generation
- `usePanelNavigation()` - Panel state management
