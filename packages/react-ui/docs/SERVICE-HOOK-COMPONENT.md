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

**Implementation**: subscribe to the resource's live queries.

The page state unit (`resource-viewer-page-state-unit`) builds its
annotations, events, and referencedBy list states with `trackList` over
`client.browse.annotations`, `client.browse.events` and
`client.gather.referencedBy`. **Freshness follows observation**:
subscribing to any of them acquires the resource's SSE scope (ref-counted
across all of them), and the last unsubscribe releases it. There is no
explicit `subscribeToResource` call.

```typescript
// The live queries packages/react-ui/src/features/resource-viewer/state/resource-viewer-page-state-unit.ts
// tracks, each through trackList, which exposes it as a ListState (value$, loading$, error$):
const annotations = client.browse.annotations(resourceId);     // CacheObservable<Annotation[]>
const events = client.browse.events(resourceId);               // CacheObservable<AttributedEvent[]>
const referencedBy = client.gather.referencedBy(resourceId);   // CacheObservable<ReferencedByEntry[]>
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
- ❌ NO direct `eventBus.on(...).subscribe()` calls (use `useObservable` / `useEventSubscriptions`)
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
// values can be packaged into a hook.) Called as useMarkAssist(stateUnit?.mark).
export function useMarkAssist(mark: MarkStateUnit | undefined) {
  const assistingMotivation = useObservable(mark?.assistingMotivation$) ?? null;
  const progress = useObservable(mark?.progress$) ?? null;

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
- ❌ NO direct `eventBus.on(...).subscribe()` (use hooks)
- ❌ NO SSE stream creation (use the SDK)
- ❌ NO SSE parsing

**Example**: the page reads the mark state unit; the panel it renders triggers assist

```tsx
// packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx, condensed
export function ResourceViewerPage({ rUri, locale, Link, routes }: ResourceViewerPageProps) {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);

  // Layer 1: the page state unit owns the mark/browse observables, one per
  // live session. `browse` is the app-scoped ShellStateUnit (panel state);
  // the page state unit re-exposes it as stateUnit.browse.
  const browseStateUnit = useShellStateUnit();
  const stateUnit = useSessionStateUnit(session ?? undefined, (s) =>
    createResourceViewerPageStateUnit(s, rUri, locale, browseStateUnit));

  // Layer 2: read state-unit observables with useObservable
  const annotations = useObservable(stateUnit?.annotations.value$) ?? [];
  const pendingAnnotation = useObservable(stateUnit?.mark.pendingAnnotation$) ?? null;
  const assistingMotivation = useObservable(stateUnit?.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit?.mark.progress$) ?? null;
  const activePanel = useObservable(stateUnit?.browse.activePanel$) ?? null;

  // Layer 3: render JSX. The panels trigger assist through the session they
  // are handed — session.client.mark.requestAssist(...) — which the mark
  // state unit picks up and runs as client.mark.delegate(...).
  return (
    <div className="semiont-document-viewer">
      {activePanel === 'annotations' && (
        <UnifiedAnnotationsPanel
          session={session ?? null}
          resourceId={rUri}
          annotations={annotations}
          annotators={ANNOTATORS}
          assistingMotivation={assistingMotivation}
          progress={progress}
          pendingAnnotation={pendingAnnotation}
          Link={Link}
          routes={routes}
        />
      )}
    </div>
  );
}
```

---

## Layer Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Components (ResourceViewerPage + panels)           │
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
│  - mark.delegate() runs the job on the unified job channels │
│  - Subscribing to browse.*(rId) acquires the resource scope │
│  - Scoped bus events auto-bridge to the EventBus            │
└─────────────────────────────────────────────────────────────┘
```

---

## Common Patterns

### Pattern 1: Triggering Operations (User Actions)

Components trigger operations via the SDK on `session.client`, not callback props:

```tsx
// Condensed from ReferencesPanel.tsx: the panel is handed the session as a prop.
function ReferencesPanel({ session }: { session: SemiontSession | null }) {
  const handleDetect = () => {
    // Trigger assist via the SDK. mark.requestAssist emits the local
    // 'mark:assist-request' event; the mark state unit runs the job.
    session?.client.mark.requestAssist({
      motivation: 'linking',
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
export function useMarkAssist(mark: MarkStateUnit | undefined) {
  const assistingMotivation = useObservable(mark?.assistingMotivation$) ?? null;
  const progress = useObservable(mark?.progress$) ?? null;
  return { assistingMotivation, progress };
}

// ❌ WRONG: re-deriving state from raw bus events with useState
export function useMarkAssistFromBus() {
  const session = useObservable(useSemiont().activeSession$);
  const [assisting, setAssisting] = useState(null);

  useEffect(() => {
    // Don't do this — the mark state unit already tracks this off the
    // unified job channels; just read assistingMotivation$.
    const sub = session?.client.bus.on('job:report-progress').subscribe(/* ... */);
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

Test the mark state unit's observables directly, over the SDK's test client
(a real `SemiontClient` on a scriptable in-memory transport):

```typescript
import { createTestClient } from '@semiont/sdk/testing';

it('sets assistingMotivation$ on an assist request', () => {
  const { client } = createTestClient();
  const mark = createMarkStateUnit(client, resourceId);
  const motivations: (Motivation | null)[] = [];
  mark.assistingMotivation$.subscribe((m) => motivations.push(m));

  // The local request the mark state unit answers by running client.mark.delegate
  client.mark.requestAssist({ motivation: 'linking', entityTypes: ['Person'] });

  expect(motivations.at(-1)).toBe('linking');
  mark.dispose();
});
```

### Layer 2: Hook Tests

Test that a hook reads state-unit observables:

```typescript
import { createTestClient } from '@semiont/sdk/testing';

it('reflects the mark state unit in React state', () => {
  const { client } = createTestClient();
  const mark = createMarkStateUnit(client, resourceId);
  const { result } = renderHook(() => useObservable(mark.assistingMotivation$));

  // Drive the state unit's observable
  act(() => {
    client.mark.requestAssist({ motivation: 'linking', entityTypes: ['Person'] });
  });

  // Verify the hook reflects it
  expect(result.current).toBe('linking');
  mark.dispose();
});
```

### Layer 3: Component Tests

Test UI rendering and operation triggering. The panels take the session as a
prop, so a test hands them a real one:

```tsx
import { createTestSession } from '@semiont/sdk/testing';
import { screen } from '@testing-library/react';
import { renderInEnglish } from '@semiont/react-ui/test-utils';

it('calls mark.requestAssist when Annotate is clicked', () => {
  const { session } = createTestSession();
  const requestAssist = vi.spyOn(session.client.mark, 'requestAssist');

  renderInEnglish(
    <ReferencesPanel
      session={session}
      resourceId={resourceId}
      annotations={[]}
      isAssisting={false}
      progress={null}
      pendingAnnotation={null}
      allEntityTypes={['Person', 'Organization']}
      Link={Link}
      routes={routes}
    />,
  );

  // Pick the entity types, then start the assist
  fireEvent.click(screen.getByRole('button', { name: 'Select Person' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select Organization' }));
  fireEvent.click(screen.getByTitle('Annotate'));

  // Verify the SDK was invoked
  expect(requestAssist).toHaveBeenCalledWith(expect.objectContaining({
    motivation: 'linking',
    entityTypes: ['Person', 'Organization'],
  }));
});
```

---

## RxJS Foundation

The three-layer architecture runs on RxJS. The buses are RxJS `EventBus`
instances:

- Layer 1: SSE → `Observable` streams (`client.browse.*(rId)` live queries)
- Layer 2: Hooks subscribe via `useEventSubscriptions` / `useObservable`
- Layer 3: Pure React

The layer separation principles are independent of the underlying
event library.

---

## Related Documentation

- [EVENTS.md](../../../docs/builder/react-ui/EVENTS.md) - Event bus usage and event types
- [ARCHITECTURE.md](ARCHITECTURE.md) - Overall architecture principles
- [TESTING.md](TESTING.md) - Testing strategies

---

## Quick Reference

### ✅ DO

- **Components**: Call hooks, emit events, render JSX
- **Hooks**: Read state-unit observables with `useObservable`, use `useEventSubscriptions` for side effects, return data objects
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
- `client.mark.requestAssist(params)` / `client.mark.delegate(resourceId, params)` - Trigger AI assist with a `mark` job's params; the job streams on `job:report-progress` / `job:complete` / `job:fail`
- `createGatherStateUnit()` - Context correlation for generation (in `@semiont/sdk`)
- `useShellStateUnit()` - App-scoped panel state (`activePanel$`, `openPanel`/`closePanel`/`togglePanel`)
