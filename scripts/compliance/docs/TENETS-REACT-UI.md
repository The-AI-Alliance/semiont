# React UI Architecture Tenets

**Scope**: This document defines the architecture patterns enforced in:
- `packages/react-ui` - Shared React UI components and hooks
- `apps/frontend` - Next.js frontend application

These rules are enforced via automated compliance auditing (see [../README.md](../README.md)).

---

## Core Principles

### 1. Event Bus is a Global Singleton

**Implementation**:
- `globalEventBus` is created once at module level in `EventBusContext.tsx`
- `EventBusProvider` wraps the app and provides access via React Context
- Components call `useEventBus()` to get the same global instance
- **The event bus reference NEVER changes** - it's a stable singleton
- Multiple `EventBusProvider` instances all reference the same global bus

**Rule**: `eventBus` must NEVER appear in React dependency arrays

**Why**: Including a stable singleton in dependency arrays causes unnecessary effect re-runs and violates React's optimization patterns.

**Enforcement**: Automated via `audit-dependency-arrays.ts` - detects `eventBus` in deps

### 2. Callback Props Must Use the Ref Pattern

**Problem**: Parent components re-render → callback props get new references → child effects re-run unnecessarily

**Solution**: Store callback props in `useRef`, sync with `useEffect`, use ref in handlers

**Pattern**:
```typescript
// Store callback in ref to avoid including in dependency arrays
const onCallbackRef = useRef(onCallback);
useEffect(() => {
  onCallbackRef.current = onCallback;
});

// Use ref in handlers/effects
const handler = useCallback(() => {
  onCallbackRef.current?.();
}, []); // ✅ onCallback NOT in deps - it's in a ref
```

**Rule**: Callback props must use the ref pattern, never appear directly in dependency arrays

**Enforcement**: Automated via `audit-dependency-arrays.ts` - detects callback props in deps

### 3. No Inline Handlers in useEventSubscriptions

**Problem**: Inline arrow functions in `useEventSubscriptions` create new references on every render, causing subscription churn

**Solution**: Extract handlers to `useCallback` with proper dependencies

**Pattern**:
```typescript
// ❌ WRONG - inline arrow function
useEventSubscriptions({
  'foo:event': (data) => { handleFoo(data); }
});

// ✅ CORRECT - extracted to useCallback
const handleFooEvent = useCallback((data) => {
  handleFoo(data);
}, [handleFoo]);

useEventSubscriptions({
  'foo:event': handleFooEvent
});
```

**Rule**: All handlers in `useEventSubscriptions` must be stable references (useCallback or top-level functions)

**Enforcement**: Automated via `audit-dependency-arrays.ts` - detects inline arrow functions

---

## Detailed Patterns

### Pattern 1: EventBus Never in Deps

**✅ Correct**:
```typescript
const eventBus = useEventBus();

const handler = useCallback(() => {
  eventBus.emit('foo', data);
}, []); // eventBus is global singleton - never in deps
```

**❌ Wrong**:
```typescript
const eventBus = useEventBus();

const handler = useCallback(() => {
  eventBus.emit('foo', data);
}, [eventBus]); // NEVER include eventBus
```

### Pattern 2: Callback Ref Pattern

**✅ Correct**:
```typescript
interface Props {
  onSave: (data: Data) => void;
}

function MyComponent({ onSave }: Props) {
  // Store callback in ref to avoid including in dependency arrays
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  });

  const handleSave = useCallback(() => {
    const data = collectData();
    onSaveRef.current(data);
  }, []); // ✅ onSave NOT in deps

  return <button onClick={handleSave}>Save</button>;
}
```

**❌ Wrong**:
```typescript
interface Props {
  onSave: (data: Data) => void;
}

function MyComponent({ onSave }: Props) {
  const handleSave = useCallback(() => {
    const data = collectData();
    onSave(data);
  }, [onSave]); // ❌ Causes re-render on every parent update

  return <button onClick={handleSave}>Save</button>;
}
```

### Pattern 3: Extracted Event Handlers

**✅ Correct**:
```typescript
function MyComponent({ toggleCollapsed }: Props) {
  // Handle sidebar toggle events
  const handleSidebarToggle = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  // Subscribe to sidebar toggle events
  useEventSubscriptions({
    'navigation:sidebar-toggle': handleSidebarToggle,
  });
}
```

**❌ Wrong**:
```typescript
function MyComponent({ toggleCollapsed }: Props) {
  // Subscribe to sidebar toggle events
  useEventSubscriptions({
    'navigation:sidebar-toggle': () => { // ❌ Inline handler
      toggleCollapsed();
    }
  });
}
```

### Pattern 4: Multiple Event Handlers

**✅ Correct**:
```typescript
function MyComponent({ theme, setTheme, toggleLineNumbers }: Props) {
  // Handle theme change events
  const handleThemeChanged = useCallback(({ theme }: { theme: Theme }) => {
    setTheme(theme);
  }, [setTheme]);

  // Handle line numbers toggle events
  const handleLineNumbersToggled = useCallback(() => {
    toggleLineNumbers();
  }, [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });
}
```

**❌ Wrong**:
```typescript
function MyComponent({ theme, setTheme, toggleLineNumbers }: Props) {
  useEventSubscriptions({
    'settings:theme-changed': ({ theme }) => setTheme(theme), // ❌ Inline
    'settings:line-numbers-toggled': () => toggleLineNumbers(), // ❌ Inline
  });
}
```

---

## API Client Pattern

**Current Implementation**:
- `ApiClientProvider` provides the client instance
- Components call `useApiClient()` to get it
- **The client reference is stable** - created once and doesn't change
- Only changes on auth state changes (rare and intentional)

**Rule**: `client` should generally not be in dependency arrays, but may appear when intentional re-wiring on auth state change is desired

---

## Compliance Checking

These patterns are enforced via automated AST analysis:

1. **Symbol Discovery** (`discover-symbols.ts`):
   - Crawls all `.ts`/`.tsx` files
   - Extracts components, hooks, interfaces, functions
   - Generates `symbols.json` inventory

2. **Dependency Array Analysis** (`audit-dependency-arrays.ts`):
   - Checks `useEffect`, `useCallback`, `useMemo` dependency arrays
   - Detects `eventBus` in deps (violation)
   - Detects callback props in deps without ref pattern (violation)
   - Detects inline arrow functions in `useEventSubscriptions` (violation)

3. **Reporting** (`batch-audit.ts`):
   - Aggregates violations across all symbols
   - Generates markdown compliance reports
   - Calculates compliance percentage

**Run compliance audit**:
```bash
# React-UI
cd packages/react-ui && ./scripts/generate-compliance-report.sh

# Frontend
cd apps/frontend && ./scripts/generate-compliance-report.sh
```

**Current Status** (as of 2025-02-13):
- React-UI: 100% compliant (311 symbols, 0 violations)
- Frontend: 100% compliant (90 symbols, 0 violations)

---

## Historical Context

### Evolution of Patterns

**Original Problem** (Pre-compliance):
- Components passed inline callbacks to hooks
- Callback props appeared directly in dependency arrays
- Event subscriptions used inline arrow functions
- Effect churn caused performance issues and complexity

**Solution Applied**:
- Introduced ref pattern for callback props
- Extracted inline handlers to `useCallback`
- Documented `eventBus` singleton rule
- Built automated compliance tooling

**Result**:
- Zero architecture violations across 401 total symbols
- Clean, predictable React hooks patterns
- Automated enforcement prevents regressions

---

## Related Documentation

- [Compliance System README](../README.md) - How to run audits, extend system
- [React Hooks Rules](https://react.dev/reference/react/hooks#rules-of-hooks) - Official React docs
- [discover-symbols.ts](../discover-symbols.ts) - TypeScript AST symbol discovery
- [audit-dependency-arrays.ts](../audit-dependency-arrays.ts) - Dependency array validator
- [batch-audit.ts](../batch-audit.ts) - Multi-file compliance checker
