# Event-Driven Architecture

Guide to using the unified event bus in `@semiont/react-ui`.

> **📖 Architecture Guide**: For a complete guide to the three-layer service/hook/component pattern, see [SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md).

## Overview

The event bus provides a unified communication channel for both backend events (from the API via SSE) and UI events (local user interactions). This architecture eliminates callback prop drilling and enables real-time collaboration.

**Key Benefits**:

- ✅ Zero callback prop drilling (0 layers vs 4+ layers)
- ✅ No ref stabilization needed
- ✅ Type-safe with discriminated unions
- ✅ Automatic cache invalidation via events
- ✅ Foundation for real-time P2P collaboration
- ✅ Components can be anywhere in tree (no parent-child requirement)

---

## Setup

### 1. Wrap Your App with EventBusProvider

The `EventBusProvider` creates a singleton event bus for your application. It should wrap your app at the root level.

```tsx
import { EventBusProvider } from '@semiont/react-ui';

export default function App({ children }) {
  return (
    <EventBusProvider>
      {children}
    </EventBusProvider>
  );
}
```

**Important**: The event bus is application-wide, not resource-scoped.

### 2. Access Event Bus in Components

Use the `useEventBus()` hook to access the event bus:

```tsx
import { useEventBus } from '@semiont/react-ui';

function MyComponent() {
  const eventBus = useEventBus();

  // Now you can emit events
  // For subscribing, use useEventSubscriptions (see below)
}
```

---

## Event Types

The event bus handles two categories of events:

### Backend Events (from API via SSE)

These events are emitted by the backend when domain changes occur:

**Detection Events**:

- `detection:start` - Entity detection job started
- `detection:progress` - Detection progress update
- `detection:complete` - Detection job completed
- `detection:failed` - Detection job failed

**Generation Events**:

- `reference:generation-start` - Document generation job started
- `reference:generation-progress` - Generation progress update
- `reference:generation-complete` - Generation job completed
- `reference:generation-failed` - Generation job failed

**Annotation Events**:

- `mark:created` - New annotation created
- `mark:deleted` - Annotation deleted
- `bind:body-updated` - Annotation body updated (resolution flow)
- `beckon:sparkle` - Annotation highlighted (UI animation)

**Resource Events**:

- `resource:archive` - Resource should be archived
- `resource:unarchive` - Resource should be unarchived

**Generation Events**:

- `yield:clone` - Resource should be cloned

### UI Events (Local User Interactions)

These events are emitted by components when users interact with the UI:

**Selection Events**:

- `annotation:creation-requested` - User selected text to annotate
- `settings:theme-changed` - Theme changed
- `settings:line-numbers-toggled` - Line numbers toggled

---

## Usage Patterns

### Pattern 1: Subscribe to Events (✅ CORRECT WAY)

**Use `useEventSubscriptions` for automatic cleanup:**

```tsx
import { useEventSubscriptions } from '@semiont/react-ui';

function MyComponent({ rUri }) {
  const [pendingAnnotation, setPendingAnnotation] = useState(null);

  // ✅ CORRECT: Use useEventSubscriptions
  useEventSubscriptions({
    'annotation:creation-requested': (selection) => {
      setPendingAnnotation({
        selector: selection.selector,
        motivation: selection.motivation
      });
    },
    'mark:created': () => {
      setPendingAnnotation(null);
    },
  });

  return <div>{/* Render UI */}</div>;
}
```

**Benefits**:
- Automatic cleanup on unmount
- Type-safe event handlers
- Consistent pattern across codebase

### ❌ Pattern to Avoid: Manual `eventBus.on()`

**Don't manually subscribe with `eventBus.on()`:**

```tsx
// ❌ WRONG: Manual event subscription
function MyComponent() {
  const eventBus = useEventBus();
  const [state, setState] = useState(null);

  useEffect(() => {
    const handler = (data) => setState(data);
    eventBus.on('some:event', handler);
    return () => eventBus.off('some:event', handler);  // Manual cleanup
  }, [eventBus]);

  return <div>{state}</div>;
}
```

**Why avoid this?**
- Violates layer separation (components should use hooks)
- Manual cleanup is error-prone
- Harder to test
- Compliance checker will flag as violation

**Use hooks instead:**
```tsx
// ✅ CORRECT: Use a custom hook
export function useSomeFeature() {
  const [state, setState] = useState(null);

  useEventSubscriptions({
    'some:event': (data) => setState(data),
  });

  return { state };
}

function MyComponent() {
  const { state } = useSomeFeature();
  return <div>{state}</div>;
}
```

### Pattern 2: Emit Events (User Actions)

Components emit events instead of calling callback props:

```tsx
import { useEventBus } from '@semiont/react-ui';

function TextSelector() {
  const eventBus = useEventBus();

  const handleTextSelection = (selection: TextSelection) => {
    // Emit event instead of calling a callback prop
    eventBus.emit('annotation:creation-requested', {
      selector: {
        type: 'TextQuoteSelector',
        exact: selection.exact,
        prefix: selection.prefix,
        suffix: selection.suffix
      },
      motivation: 'commenting'
    });
  };

  return <div onMouseUp={handleTextSelection}>...</div>;
}
```

**Benefits**:

- No callback props needed
- No ref stabilization required
- Component doesn't need to know who handles the event

### Pattern 3: Cache Invalidation via Events

Backend events automatically invalidate React Query cache:

```tsx
import { useEventSubscriptions } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';

function MyComponent({ rUri }) {
  const queryClient = useQueryClient();

  useEventSubscriptions({
    'mark:created': () => {
      // Backend created annotation → invalidate cache
      queryClient.invalidateQueries(['annotations', rUri]);
    },
    'mark:deleted': () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    },
  });

  return <div>{/* UI */}</div>;
}
```

**Why this works**: Backend events flow via `SSE → EventBus → Component → Cache Invalidation`. No manual `refetch()` calls needed.

---

## Three-Layer Architecture

The event bus is part of a three-layer architecture:

1. **Service Layer**: SSE connection management (`useResourceEvents`)
2. **Hook Layer**: Event subscriptions + React state (`useEventSubscriptions` + `useState`)
3. **Component Layer**: Pure React (hooks + JSX)

### Example: Detection Flow

**Layer 1 (Service)**: Establish SSE connection
```tsx
function ResourceViewerPage({ rUri }) {
  useResourceEvents(rUri);  // Opens SSE, emits events to bus
  // ...
}
```

**Layer 2 (Hook)**: Manage state from events
```tsx
export function useDetectionFlow(rUri: ResourceUri) {
  const [detecting, setDetecting] = useState(null);
  const [progress, setProgress] = useState(null);

  useEventSubscriptions({
    'detection:start': ({ motivation }) => setDetecting(motivation),
    'detection:progress': (chunk) => setProgress(chunk),
    'detection:complete': () => setDetecting(null),
  });

  return { detecting, progress };
}
```

**Layer 3 (Component)**: Use hook and render UI
```tsx
function ResourceViewerPage({ rUri }) {
  const { detecting, progress } = useDetectionFlow(rUri);

  return (
    <div>
      {detecting && <p>Detecting {detecting}...</p>}
      {progress && <ProgressBar message={progress.message} />}
    </div>
  );
}
```

**📖 See [SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md) for the complete architecture guide.**

---

## Best Practices

### 1. Always Use `useEventSubscriptions`

**✅ DO**: Use the hook for automatic cleanup

```tsx
useEventSubscriptions({
  'mark:created': (annotation) => {
    // Handle event
  },
});
```

**❌ DON'T**: Manually manage subscriptions

```tsx
// WRONG - compliance violation
useEffect(() => {
  const handler = (event) => { /* ... */ };
  eventBus.on('mark:created', handler);
  return () => eventBus.off('mark:created', handler);
}, [eventBus]);
```

### 2. Use Type-Safe Event Handlers

Events are fully type-safe using discriminated unions:

```tsx
import { useEventSubscriptions } from '@semiont/react-ui';
import type { DetectionProgressChunk } from '@semiont/api-client';

useEventSubscriptions({
  'detection:progress': (chunk: DetectionProgressChunk) => {
    // chunk is correctly typed
    console.log(chunk.message, chunk.foundCount);
  },
});
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
  const eventBus = useEventBus();
  eventBus.emit('annotation:creation-requested', { ... }); // No props needed
}
```

### 4. Create Custom Hooks for Complex Event Logic

**Extract event subscriptions into hooks:**

```tsx
// ✅ GOOD: Custom hook encapsulates event logic
export function useMarkFlow(rUri: ResourceUri) {
  const [pending, setPending] = useState(null);

  useEventSubscriptions({
    'annotation:creation-requested': (selection) => {
      setPending({
        selector: selection.selector,
        motivation: selection.motivation
      });
    },
    'mark:created': () => setPending(null),
    'annotation:failed': () => setPending(null),
  });

  return { pendingAnnotation: pending };
}

// Component uses hook
function MyComponent({ rUri }) {
  const { pendingAnnotation } = useMarkFlow(rUri);
  return <div>{/* Use pendingAnnotation */}</div>;
}
```

---

## Event Naming Convention

Events use colon-separated namespaces:

```
namespace:event-name
```

**Examples**:

- ✅ `detection:start` (correct)
- ✅ `mark:created` (correct)
- ✅ `resource:archive` (correct)
- ❌ `detection-start` (legacy - don't use hyphens for namespaces)

**Compliance**: The automated compliance checker flags legacy hyphen-separated event names as warnings.

---

## Compliance and Testing

### Automated Compliance Checks

The codebase enforces event bus best practices:

```bash
npm run audit:compliance
```

**Layer Separation Violations** (will fail build):

- ❌ Components using `eventBus.on()` (should use `useEventSubscriptions`)
- ❌ Components using `eventBus.off()` (cleanup is automatic)
- ❌ Hooks returning JSX (hooks should return data)
- ❌ Global `eventBus` imports (should use `useEventBus()` hook)

### Testing Events

**Emit events in tests:**

```tsx
import { render } from '@testing-library/react';
import { EventBusProvider, createEventBus } from '@semiont/react-ui';

it('should handle mark:created event', async () => {
  const eventBus = createEventBus();

  render(
    <EventBusProvider value={eventBus}>
      <MyComponent />
    </EventBusProvider>
  );

  // Emit event
  act(() => {
    eventBus.emit('mark:created', { annotation: mockAnnotation });
  });

  // Assert state updated
  await waitFor(() => {
    expect(screen.queryByText('Pending...')).not.toBeInTheDocument();
  });
});
```

---

## Troubleshooting

### Error: "useEventBus must be used within EventBusProvider"

**Cause**: Component is using `useEventBus()` but is not wrapped in `EventBusProvider`.

**Solution**: Wrap the component tree with the provider:

```tsx
<EventBusProvider>
  <YourComponent />
</EventBusProvider>
```

### Events Not Firing

**Causes**:

1. Event listener not registered before event is emitted
2. Wrong event name (check spelling/casing)
3. Missing `EventBusProvider`

**Solutions**:

1. Use `useEventSubscriptions` in component mount
2. Check event names against `EventMap` type
3. Verify provider wraps component tree

### Memory Leaks

**Cause**: Using manual `eventBus.on()` without cleanup.

**Solution**: Use `useEventSubscriptions` for automatic cleanup:

```tsx
// ✅ CORRECT: Automatic cleanup
useEventSubscriptions({
  'mark:created': (annotation) => { /* ... */ },
});
```

---

## Related Documentation

- **[SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md)** - Three-layer architecture guide
- [ARCHITECTURE.md](ARCHITECTURE.md) - Event-driven architecture principles
- [API-INTEGRATION.md](API-INTEGRATION.md) - Event-based cache invalidation
- [TESTING.md](TESTING.md) - Testing event-driven code
- [RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md](../../../RXJS-SERVICE-HOOK-COMPONENT-INVARIANTS.md) - Architectural invariants

---

## References

- Event bus context: `packages/react-ui/src/contexts/EventBusContext.tsx`
- Event subscriptions hook: `packages/react-ui/src/hooks/useEventSubscriptions.ts`
- SSE integration: `packages/react-ui/src/hooks/useResourceEvents.ts`
- mitt library: https://github.com/developit/mitt
