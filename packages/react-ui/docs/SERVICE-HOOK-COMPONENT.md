# Service-Hook-Component Architecture

**The three-layer pattern for React + Event Bus integration.**

## Overview

Semiont uses a strict three-layer architecture to separate concerns and maintain clean, testable code:

1. **Service Layer** - SSE stream management (EventBus-native)
2. **Hook Layer** - Reads state-unit observables (`useObservable`) and subscribes to bus side effects (`useEventSubscriptions`)
3. **Component Layer** - Pure React (hooks + JSX)

This architecture leverages RxJS EventBus for event routing, eliminates callback prop drilling, ensures proper separation of concerns, and makes components highly testable.

---

## The Three Layers

### Layer 1: Service Layer

**Responsibility**: Manage Server-Sent Events (SSE) connections with EventBus-native streams.

**Rules**:
- ✅ Opens and manages SSE connections
- ✅ Bus events automatically bridge into the local EventBus (no callbacks)
- ✅ Handles reconnection and gap detection
- ❌ NO React state (`useState`, `useEffect` for state)
- ❌ NO JSX rendering
- ❌ NO manual event forwarding (the ActorStateUnit bridge is EventBus-native)

**Implementation**: subscribe to the resource's `browse.*(resourceId)` live queries.

The page state unit (`resource-viewer-page-state-unit`) builds its
`annotations$`, `events$`, and `referencedBy$` observables from
`client.browse.*(resourceId)`. **Freshness follows observation** (#847):
subscribing to any of them acquires the resource's SSE scope (ref-counted
across all of them), and the last unsubscribe releases it. There is no
explicit `subscribeToResource` call.

```typescript
// packages/react-ui/src/features/resource-viewer/state/resource-viewer-page-state-unit.ts
const annotations$ = client.browse.annotations(resourceId).pipe(map((a) => a ?? []));
const events$ = client.browse.events(resourceId).pipe(map((e) => e ?? []));
const referencedBy$ = client.browse.referencedBy(resourceId).pipe(map((r) => r ?? []));
// Subscribing to any of these (from Layer 2 / Layer 3) keeps the resource
// scope live; dropping the last subscriber releases it on teardown.
```

Under the hood: a `browse.*(resourceId)` subscription drives the transport's
internal, SDK-only `subscribeToResource(rId)` — it adds the resource-scoped
bus channels to the ActorStateUnit and bridges each event onto the same
channel in the local EventBus. Application code never calls
`subscribeToResource` itself; it just observes the live queries.

**Key Architecture Points**:
- One ActorStateUnit per client — one SSE connection to `/bus/subscribe`
- Resource-scoped channels added/removed automatically as the resource's `browse.*` live queries gain/lose subscribers
- Events auto-bridge to the local EventBus for layer 2 consumption
- No callbacks; pure pub/sub

---

### Layer 2: Hook Layer

**Responsibility**: Orchestrate operations and manage React state.

**Rules**:
- ✅ Reads state-unit observables with `useObservable` (and subscribes to bus events with `useEventSubscriptions`)
- ✅ Returns data/state objects
- ❌ NO direct `eventBus.get().subscribe()` calls (use `useObservable` / `useEventSubscriptions`)
- ❌ NO JSX rendering
- ❌ NO manual event forwarding

**Example**: reading the `mark` state unit's assist observables

The page state unit (`resource-viewer-page-state-unit`) owns a session-scoped
`MarkStateUnit` (`createMarkStateUnit`, in `@semiont/sdk`). When the user triggers
AI assist, the SDK runs the job and the mark state unit drives three observables:

- `mark.assistingMotivation$` — the in-progress motivation (or `null` when idle)
- `mark.progress$` — the latest `JobProgress`
- `mark.pendingAnnotation$` — a pending manual annotation awaiting a body

The hook layer just reads those observables with `useObservable` — no `useState`,
no SSE wiring, no manual subscription. The mark state unit already subscribes to
the unified job channels (`job:report-progress` / `job:complete` / `job:fail`)
internally; the hook is pure read-through.

```typescript
// A thin hook that exposes the mark state unit's assist observables.
// (In ResourceViewerPage these are read inline via useObservable; the same
// values can be packaged into a hook.)
export interface MarkAssistState {
  assistingMotivation: Motivation | null;
  progress: JobProgress | null;
}

export function useMarkAssist(stateUnit: ResourceViewerPageStateUnit): MarkAssistState {
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;

  // Return data only (no JSX)
  return { assistingMotivation, progress };
}
```

If a hook needs to react to job lifecycle for side effects (toasts, scroll),
it subscribes to the bridged job channels with `useEventSubscriptions` instead
of touching SSE directly:

```typescript
export function useAssistToasts(resourceId: ResourceId) {
  const { showSuccess, showError } = useToast();

  useEventSubscriptions({
    'job:complete': (event) => {
      if (event.resourceId === resourceId) showSuccess('Annotation complete');
    },
    'job:fail': (event) => {
      if (event.resourceId === resourceId) showError(event.error ?? 'Annotation failed');
    },
  });
}
```

**Key Points**:
- Reads state-unit observables with `useObservable` (state lives in the state unit, not `useState`)
- Uses `useEventSubscriptions` for bus side effects, with automatic cleanup
- Returns plain data objects
- No JSX rendering

---

### Layer 3: Component Layer

**Responsibility**: Render UI and handle user interactions.

**Rules**:
- ✅ Reads state from hooks / state-unit observables
- ✅ Triggers operations via `session.client.*` (e.g. `mark.requestAssist(...)`)
- ✅ Renders JSX
- ❌ NO direct `eventBus.get(...).subscribe()` (use hooks)
- ❌ NO SSE stream creation (use the SDK)
- ❌ NO SSE parsing

**Example**: Component reading the mark state unit and triggering assist

```typescript
// packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx
export function ResourceViewerPage({ rUri, resource, ... }: ResourceViewerPageProps) {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const semiont = session?.client;

  // Layer 1: the page state unit owns the mark/browse observables.
  // `browse` is the app-scoped ShellStateUnit (panel state); the page
  // state unit re-exposes it as stateUnit.browse.
  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() =>
    createResourceViewerPageStateUnit(semiont!, rUri, locale, browseStateUnit));

  // Layer 2: read state-unit observables with useObservable
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;
  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;

  // Trigger detection (user interaction): emit the local assist-request via the
  // SDK. The mark state unit picks it up and runs `client.mark.assist(...)`.
  const handleDetectClick = useCallback(() => {
    semiont?.mark.requestAssist('linking', {
      entityTypes: ['Person', 'Organization'],
    });
  }, [semiont]);

  // Layer 3: Render JSX
  return (
    <div className="resource-viewer">
      <Toolbar onDetect={handleDetectClick} />
      <ResourceViewer
        content={content}
        assistingMotivation={assistingMotivation}
        progress={progress}
      />
      <UnifiedAnnotationsPanel
        annotations={annotations}
        assistingMotivation={assistingMotivation}
        progress={progress}
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
│  - Reads state-unit observables via useObservable           │
│  - Triggers operations (session.client.mark.requestAssist)  │
│  - Renders JSX                                              │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ reads observables
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: State units + hooks (mark, browse/ShellStateUnit)  │
│                                                              │
│  - useObservable(mark.assistingMotivation$ / progress$)     │
│  - useEventSubscriptions() → bus side effects               │
│  - Returns data objects                                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ subscribes to
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Event Bus (RxJS)                                             │
│                                                              │
│  - Unified job channels (job:report-progress/complete/fail) │
│  - browse.*(rId) live queries (annotations, events, etc.)   │
│  - Type-safe event contracts (no manual forwarding)         │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ SDK drives jobs + auto-bridges scoped events
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: SDK state units (MarkStateUnit) + browse queries   │
│                                                              │
│  - mark.assist() runs the job on the unified job channels   │
│  - Subscribing to browse.*(rId) acquires the resource scope │
│  - Scoped bus events auto-bridge to the EventBus            │
└─────────────────────────────────────────────────────────────┘
```

---

## Complete Example

### Layer 1: Service (SSE Connection)

```typescript
// In ResourceViewerPage.tsx
export function ResourceViewerPage({ rId, ... }: ResourceViewerPageProps) {
  // Layer 1: the page state unit's browse.*(rId) live queries acquire the
  // resource scope when observed — no explicit subscribe call, no per-component hook.

  // ... rest of component
}
```

The service layer runs automatically once per resource page.

### Layer 2: State unit + hooks (State Management)

```typescript
// State lives in the SDK MarkStateUnit; the hook reads it via useObservable.
export function useMarkAssist(stateUnit: ResourceViewerPageStateUnit) {
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;
  return { assistingMotivation, progress };
}
```

### Layer 3: Component (UI)

```typescript
// packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx
export function ResourceViewerPage({ rUri, ... }: ResourceViewerPageProps) {
  const session = useObservable(useSemiont().activeSession$);
  const semiont = session?.client;

  // Read state from the mark state unit (Layer 2)
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;

  // Trigger assist via the SDK (the mark state unit runs the job)
  const handleDetect = useCallback(() => {
    semiont?.mark.requestAssist('linking', { entityTypes: ['Person'] });
  }, [semiont]);

  // Render UI
  return (
    <div>
      <button onClick={handleDetect} disabled={!!assistingMotivation}>
        {assistingMotivation ? 'Detecting...' : 'Detect Entities'}
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
function ResourceViewerPage({ rId, ... }) {
  return (
    <DetectionFlowContainer rId={rId}>
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
// One composite state unit + direct useObservable reads = 0 indirection
function ResourceViewerPage({ rUri, resource, ... }: ResourceViewerPageProps) {
  // Layer 1: one state unit owns every flow (mark, browse, gather, yield) and
  // the browse.*(rUri) live queries — created once with useStateUnit.
  const browseStateUnit = useShellStateUnit();
  const stateUnit = useStateUnit(() =>
    createResourceViewerPageStateUnit(semiont!, rUri, locale, browseStateUnit));

  // Layer 2: read state-unit observables with useObservable
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;
  const pendingAnnotation = useObservable(stateUnit.mark.pendingAnnotation$) ?? null;
  const activePanel = useObservable(stateUnit.browse.activePanel$) ?? null;

  // Layer 3: Render UI directly
  return (
    <div className="resource-viewer">
      <Toolbar {...} />
      <ResourceViewer
        assistingMotivation={assistingMotivation}
        progress={progress}
        {...}
      />
      <UnifiedAnnotationsPanel
        pendingAnnotation={pendingAnnotation}
        activePanel={activePanel}
        {...}
      />
    </div>
  );
}
```

**Results**:
- One composite state unit replaces 4 containers (636 lines)
- No nested render props
- No wrapper components
- Total: ~450 lines (67% reduction)

---

## Common Patterns

### Pattern 1: Triggering Operations (User Actions)

Components trigger operations via the SDK on `session.client`, not callback props:

```typescript
function ReferencesPanel() {
  const session = useObservable(useSemiont().activeSession$);

  const handleDetect = () => {
    // Trigger assist via the SDK. mark.requestAssist emits the local
    // 'mark:assist-request' event; the mark state unit runs the job.
    session?.client.mark.requestAssist('linking', {
      entityTypes: ['Person', 'Organization'],
    });
  };

  return <button onClick={handleDetect}>Detect</button>;
}
```

### Pattern 2: Reading State (State Updates)

State lives in the state unit; hooks/components read it with `useObservable`:

```typescript
// ✅ CORRECT: read the mark state unit's observables
export function useMarkAssist(stateUnit: ResourceViewerPageStateUnit) {
  const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit.mark.progress$) ?? null;
  return { assistingMotivation, progress };
}

// ❌ WRONG: re-deriving state from raw bus events with useState
export function useMarkAssist(stateUnit: ResourceViewerPageStateUnit) {
  const session = useObservable(useSemiont().activeSession$);
  const [assisting, setAssisting] = useState(null);

  useEffect(() => {
    // Don't do this — the mark state unit already tracks this off the
    // unified job channels; just read assistingMotivation$.
    const sub = session?.client.bus.get('job:report-progress').subscribe(/* ... */);
    return () => sub?.unsubscribe();
  }, [session]);

  return { assisting };
}
```

### Pattern 3: Bus Side Effects (Reacting to Jobs)

Use `useEventSubscriptions` to react to job lifecycle for UI side effects
(toasts, scroll), without re-implementing state the mark state unit already owns:

```typescript
export function useAssistToasts(resourceId: ResourceId) {
  const { showSuccess, showError } = useToast();

  useEventSubscriptions({
    'job:complete': (e) => { if (e.resourceId === resourceId) showSuccess('Annotation complete'); },
    'job:fail': (e) => { if (e.resourceId === resourceId) showError(e.error ?? 'Annotation failed'); },
  });
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
   - Should use: the SDK's managed bus connection — resource freshness comes from subscribing to `client.browse.*(resourceId)` live queries
   - Detection: AST analysis finds `new EventSource()` in component files

4. **Hooks returning JSX**
   - Should return: Data objects only
   - Detection: AST analysis finds JSX return statements in hook files

5. **Global eventBus imports**
   - Should use: `useSemiont()` (emit via `session.client`)
   - Detection: AST analysis finds `import { eventBus }` statements

### Compliance Report

The automated compliance checker generates detailed reports:

```
Layer Separation Violations (❌)
- Components using eventBus.on(): 0 (should use useEventSubscriptions)
- Components using eventBus.off(): 0 (useEventSubscriptions handles cleanup)
- Components creating EventSource: 0 (bus connection managed by SemiontClient)
- Hooks returning JSX: 0 (hooks should return data, not JSX)
- Global eventBus imports: 0 (should use useSemiont())
```

---

## Testing the Three Layers

### Layer 1: State Unit Tests

Test that the mark state unit drives its observables off the unified job channels:

```typescript
it('should set assistingMotivation$ on assist-request and clear on job:complete', async () => {
  const mark = createMarkStateUnit(client, testUri);

  // Trigger assist (local request → mark state unit runs client.mark.assist)
  client.bus.get('mark:assist-request').next({
    motivation: 'linking',
    options: { entityTypes: ['Person'] },
  });

  expect(await firstValueFrom(mark.assistingMotivation$)).toBe('linking');

  // Simulate the job finishing on the unified channel
  client.bus.get('job:complete').next({ jobId, resourceId: testUri, jobType: 'reference-annotation' } as any);

  // assistingMotivation$ returns to null
});
```

### Layer 2: Hook Tests

Test that the hook reads state-unit observables:

```typescript
it('should expose assistingMotivation from the mark state unit', () => {
  const { result } = renderHook(() => useMarkAssist(stateUnit), {
    wrapper: SemiontProvider
  });

  // Drive the state unit's observable
  act(() => {
    client.bus.get('mark:assist-request').next({
      motivation: 'linking',
      options: { entityTypes: ['Person'] },
    });
  });

  // Verify the hook reflects it
  expect(result.current.assistingMotivation).toBe('linking');
});
```

### Layer 3: Component Tests

Test UI rendering and operation triggering:

```typescript
it('should call mark.requestAssist when button clicked', async () => {
  const requestAssist = vi.spyOn(session.client.mark, 'requestAssist');

  render(
    <SemiontProvider value={semiont}>
      <ResourceViewerPage rUri={testId} {...props} />
    </SemiontProvider>
  );

  // Click detect button
  fireEvent.click(screen.getByText('Detect Entities'));

  // Verify the SDK was invoked
  expect(requestAssist).toHaveBeenCalledWith('linking', expect.objectContaining({
    entityTypes: ['Person', 'Organization'],
  }));
});
```

---

## Migration Guide

### From Render Props Containers to Hooks

1. **Identify container logic**:
   - Find `useState` calls that mirror state already owned by a state unit
   - Find `useEventSubscriptions` calls
   - Find what data is returned to children

2. **Move state into the state unit, read it via `useObservable`**:
   ```typescript
   // Before: Container re-deriving assist state from raw bus events
   function DetectionFlowContainer({ children }) {
     const [detecting, setDetecting] = useState(null);
     useEventSubscriptions({
       'mark:assist-request': ({ motivation }) => setDetecting(motivation),
     });
     return <>{children({ detecting })}</>;
   }

   // After: read the mark state unit's observable directly
   const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
   ```

3. **Update component to read the observable**:
   ```typescript
   // Before
   <DetectionFlowContainer>
     {({ detecting }) => <div>{detecting}</div>}
   </DetectionFlowContainer>

   // After
   const assistingMotivation = useObservable(stateUnit.mark.assistingMotivation$) ?? null;
   return <div>{assistingMotivation}</div>;
   ```

4. **Delete container file**
5. **Update exports**
6. **Update tests**

---

## RxJS Foundation

The three-layer architecture runs on RxJS. The buses are RxJS `EventBus`
instances (mitt is no longer used):

- Layer 1: SSE → `Observable` streams (`client.browse.*(rId)` live queries)
- Layer 2: Hooks subscribe via `useEventSubscriptions` / `useObservable`
- Layer 3: Pure React

The layer separation principles are independent of the underlying
event library.

---

## Related Documentation

- [EVENTS.md](EVENTS.md) - Event bus usage and event types
- [ARCHITECTURE.md](ARCHITECTURE.md) - Overall architecture principles
- [TESTING.md](TESTING.md) - Testing strategies

---

## Quick Reference

### ✅ DO

- **Components**: Call hooks, emit events, render JSX
- **Hooks**: Use `useEventSubscriptions`, manage state with `useState`, return data objects
- **Service**: Bus connection managed by `SemiontClient` (one ActorStateUnit per client; resource-scoped channels acquired by subscribing to `client.browse.*(resourceId)` live queries — freshness follows observation)

### ❌ DON'T

- **Components**: Direct `eventBus.on()`, `new EventSource()`, SSE parsing
- **Hooks**: Return JSX, create SSE connections
- **Service**: Manage React state, render UI

### Key Hooks

- `useSemiont()` - Access the Semiont browser; `useObservable(browser.activeSession$)` → `session.client`
- `useObservable()` - Read a state-unit observable into React state
- `useEventSubscriptions()` - Subscribe to bus events (for side effects)
- `client.browse.*(resourceId)` - Resource-scoped live queries; subscribing acquires the resource's bus scope (freshness follows observation), the last unsubscribe releases it
- `createMarkStateUnit()` - Mark/assist state (`assistingMotivation$`, `progress$`, `pendingAnnotation$`); driven off the unified job channels (in `@semiont/sdk`)
- `client.mark.requestAssist(motivation, options)` / `client.mark.assist(...)` - Trigger AI assist; the job streams on `job:report-progress` / `job:complete` / `job:fail`
- `createGatherStateUnit()` - Context correlation for generation (in `@semiont/sdk`)
- `useShellStateUnit()` - App-scoped panel state (`activePanel$`, `openPanel`/`closePanel`/`togglePanel`)
