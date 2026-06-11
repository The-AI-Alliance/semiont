# Architecture

Design principles and architectural decisions for `@semiont/react-ui`.

## Core Philosophy

### Framework Independence

**Principle:** The library must work with any React framework.

**Why:** Organizations use different frameworks (Next.js, Vite, CRA, Remix, React Native). Coupling to one framework limits adoption and creates technical debt.

**How:**
- Zero imports from framework-specific packages (next-auth, next-intl, next/router)
- Provider Pattern for all cross-cutting concerns
- Apps provide framework-specific implementations

**Example:**

```tsx
// ❌ WRONG - Couples to Next.js
import { useTranslations } from 'next-intl';

function Toolbar() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}

// ✅ CORRECT - Framework-agnostic
import { useTranslations } from '@semiont/react-ui';

function Toolbar() {
  const t = useTranslations('Toolbar');
  return <button>{t('save')}</button>;
}
```

---

### No Aliasing or Wrappers

**Principle:** If something is wrong, fix it directly. No compatibility layers.

**Why:**
- Aliases create confusion ("which function do I use?")
- Wrappers hide the real API
- "Compatibility layers" become permanent technical debt
- We control the entire codebase

**How:**
- If an API changes, update all call sites immediately
- If a pattern is deprecated, remove it completely
- If code is redundant, delete it

**Example:**

```tsx
// ❌ WRONG - Creating alias for "backward compatibility"
export const list = all; // Don't do this!
export function all() { ... }

// ✅ CORRECT - Just change all call sites
export function list() { ... }
// Update every usage of `all()` to `list()`
```

**From CLAUDE.md:**
> "If something is wrong, fix it directly. If something is redundant, delete it immediately. Do not add aliases for 'backward compatibility'."

---

### Direct API Access

**Principle:** No intermediate layers between components and data sources.

**Why:**
- Wrappers add complexity without value
- Direct access is easier to understand and debug
- Every layer adds overhead

**How:**
- Components read SDK live queries (`client.browse.*`) directly via `useObservable`
- No "service layer" or "repository pattern"
- No unnecessary abstractions

**Example:**

```tsx
// ❌ WRONG - Unnecessary wrapper
class ResourceService {
  async getAll() {
    return this.client.listResources();
  }
}

// ✅ CORRECT - Subscribe to the SDK live query directly
import { useObservable, useSemiont } from '@semiont/react-ui';

function ResourceList() {
  const browser = useSemiont();
  const client = useObservable(browser.activeSession$); // SemiontClient | undefined
  // `client.browse.resources(...)` returns an RxJS Observable backed by the
  // SDK's read-through cache. `useObservable` turns it into React state.
  const resources = useObservable(client?.browse.resources({})) ?? [];
  return <ul>{resources.map((r) => <li key={r.id}>{r.name}</li>)}</ul>;
}
```

---

### Event-Driven Architecture

**Principle:** Components communicate via events using a three-layer pattern.

**Why:**

- Eliminates callback prop drilling (0 layers vs 4+ layers)
- No ref stabilization needed
- Type-safe with discriminated unions
- Automatic cache invalidation via events
- Foundation for real-time collaboration
- Components can be anywhere in the tree (no parent-child requirement)
- Clean separation between service, hook, and component layers

**Three-Layer Pattern:**

1. **Service Layer**: Bus subscription (the page state unit's `browse.*(resourceId)` live-query subscriptions acquire the resource scope by observation; #847)
2. **Hook Layer**: Event subscriptions + React state (`useEventSubscriptions` + `useState`)
3. **Component Layer**: Pure React (hooks + JSX)

**Example - Three Layers in Action:**

```tsx
// Layer 1 (Service): the page state unit subscribes to client.browse.*(rId)
// live queries, which acquire the resource scope by observation (#847) —
// no explicit subscribeToResource call, no component-level hook needed.
function ResourceViewerPage({ rId }) {
  // ...
}

// Layer 2 (Hook): State management from events (the unified job channels)
export function useAssistProgress() {
  const [progress, setProgress] = useState(null);

  useEventSubscriptions({
    'job:report-progress': ({ progress }) => setProgress(progress),
    'job:complete': () => setProgress(null),
    'job:fail': () => setProgress(null),
  });

  return { progress };
}

// Layer 3 (Component): UI rendering
function ResourceViewerPage({ rId }) {
  const { progress } = useAssistProgress();
  return <div>{progress && <p>Detecting… {progress.message}</p>}</div>;
}
```

**Real Results from MAKE-IT-STOP Refactoring:**

- **Eliminated render props:** 4 container components (636 lines) → 4 hooks (200 lines)
- **Reduced indirection:** ~1,370 lines → ~450 lines (67% reduction)
- **Simplified ResourceViewerPage:** 734 lines → 601 lines
- **Zero callback props:** 17 callback props eliminated (100%)
- **Zero ref stabilization:** 9 useRef eliminated (100%)

**Setup:**

```tsx
import { SemiontProvider } from '@semiont/react-ui';

export default function App({ children }) {
  return (
    <SemiontProvider>
      {children}
    </SemiontProvider>
  );
}
```

`SemiontProvider` puts the `SemiontBrowser` singleton into context. Both event
buses (the app-scoped bus on `SemiontBrowser` and the per-session bus on the
active `SemiontClient`) are reached through it, so `useEventSubscription` works
without any separate event-bus provider.

**📖 Complete Documentation:**
- **[SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md)** - Three-layer architecture guide
- **[EVENTS.md](EVENTS.md)** - Event bus usage and patterns

---

### TypeScript First

**Principle:** Full type safety throughout. No `any` without explicit permission.

**Why:**
- Types catch bugs at compile time
- Types document APIs
- Types enable great IDE support
- Using `any` defeats the purpose of TypeScript

**How:**
- All code is TypeScript (`.ts` or `.tsx`)
- Strict mode enabled
- No `any` casts without documented justification
- Exported types for all public APIs

**Example:**

```tsx
// ❌ WRONG - Silencing type errors
const data = response as any;
data.whatever.you.want; // No type checking!

// ✅ CORRECT - Proper typing
interface Resource {
  id: string;
  name: string;
  created: Date;
}

const data: Resource = response;
data.name; // Type-safe access
```

---

### Component Composition for Framework Independence

**Principle:** Components receive framework-specific implementations as props.

**Why:**
- Allows same component to work with any router (Next.js Link, React Router Link, etc.)
- No framework coupling in component code
- Apps provide their specific implementations

**How:**
- Components accept `Link` component as a prop
- Apps pass their router's Link component
- Type as `React.ComponentType<any>` for flexibility

**Example:**

```tsx
// ❌ WRONG - Couples to Next.js
import Link from 'next/link';

export function SignInForm() {
  return <Link href="/signup">Sign Up</Link>;
}

// ✅ CORRECT - Framework-agnostic
export interface SignInFormProps {
  Link: React.ComponentType<any>;
  // ... other props
}

export function SignInForm({ Link, ...props }: SignInFormProps) {
  return <Link href="/signup">Sign Up</Link>;
}

// Apps provide their Link
import { SignInForm } from '@semiont/react-ui';
import Link from 'next/link'; // or from 'react-router-dom', etc.

<SignInForm Link={Link} ... />
```

**Applies to:**
- Routing components (Link)
- Any framework-specific functionality needed by components

---

### Provider Pattern over Dependency Injection

**Principle:** Use React's Context API, not DI frameworks.

**Why:**
- React Context is the standard React pattern
- DI frameworks (InversifyJS, etc.) add complexity
- Context is simple and well-understood
- From CLAUDE.md: "Do not ever suggest 'Dependency Injection', which is horrid and evil"

**How:**
- Define manager interfaces
- Apps implement managers
- Providers distribute via Context
- Components use hooks to access

**Example:**

```tsx
// ❌ WRONG - Dependency Injection framework
@injectable()
class TranslationService implements ITranslationService {
  @inject('LocaleProvider') private locale: ILocaleProvider;
  translate(key: string) { ... }
}

// ✅ CORRECT - Provider Pattern
interface TranslationManager {
  t: (namespace: string, key: string) => string;
}

<TranslationProvider translationManager={manager}>
  {children}
</TranslationProvider>
```

See [SESSION.md](SESSION.md) for details.

---

## Project Structure

```
packages/react-ui/
├── src/
│   ├── types/              # TypeScript interfaces
│   │   ├── TranslationManager.ts
│   │   ├── knowledge-base.ts
│   │   └── ...
│   ├── session/            # Session provider + storage
│   │   ├── SemiontProvider.tsx      # SemiontProvider + useSemiont()
│   │   └── web-browser-storage.ts
│   ├── contexts/           # React Context providers
│   │   ├── TranslationContext.tsx
│   │   ├── useEventSubscription.ts  # Bus subscription hooks
│   │   └── __tests__/     # Context tests
│   ├── features/          # Feature-based components
│   │   ├── auth/          # Authentication components
│   │   │   ├── components/
│   │   │   │   ├── SignInForm.tsx
│   │   │   │   ├── SignUpForm.tsx
│   │   │   │   └── AuthErrorDisplay.tsx
│   │   │   └── __tests__/
│   │   ├── resource-viewer/
│   │   ├── resource-discovery/
│   │   ├── admin-users/
│   │   └── ...
│   ├── components/         # Shared components
│   │   ├── navigation/    # Navigation
│   │   ├── modals/        # Dialogs
│   │   └── __tests__/     # Component tests
│   ├── hooks/             # React hooks
│   │   ├── useObservable.ts  # Subscribe to SDK live-query observables
│   │   ├── useTheme.ts
│   │   └── __tests__/     # Hook tests
│   ├── lib/               # Utility libraries
│   │   ├── validation.ts  # Form validation
│   │   └── __tests__/     # Library tests
│   ├── index.ts           # Main exports
│   └── test-utils.tsx     # Testing utilities
├── docs/                  # Documentation
│   ├── SESSION.md
│   ├── API-INTEGRATION.md
│   ├── TESTING.md
│   ├── COMPONENTS.md
│   └── ARCHITECTURE.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## Dependency Management

### Peer Dependencies

Components that apps must provide:

```json
{
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

Data fetching is provided by the SDK, which ships as a regular dependency
(`@semiont/sdk`) rather than a peer — apps don't supply it.

**Why peer dependencies:**
- Ensures single React instance
- Apps control versions
- Prevents duplicate packages

### No Framework Dependencies

The library **must not** depend on:

- ❌ `next` - Next.js framework
- ❌ `next-auth` - Next.js authentication
- ❌ `next-intl` - Next.js internationalization
- ❌ `react-router` - React Router
- ❌ Any other framework-specific package

**These belong in apps, not the library.**

---

## State Management

### Local State

Use React `useState` for component-local state:

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```

### Server State

Subscribe to the SDK's live queries with `useObservable`. The SDK provides a
read-through stale-while-revalidate cache, so server data flows as RxJS
observables rather than imperative fetches:

```tsx
const browser = useSemiont();
const client = useObservable(browser.activeSession$);
const resources = useObservable(client?.browse.resources({})) ?? [];
```

### Context State

Use React Context for cross-cutting concerns:

```tsx
const browser = useSemiont(); // SemiontBrowser from <SemiontProvider>
const t = useTranslations('Common');
```

### No Global State Libraries

**Do not use:**
- Redux
- MobX
- Zustand
- Jotai

**Why:** React's built-in state management is sufficient. Additional libraries add complexity without value for this library's use case.

---

## Error Handling

### API Errors

```tsx
import { APIError } from '@semiont/http-transport';

try {
  await client.mark.create(rId, motivation, selectors);
} catch (error) {
  if (error instanceof APIError) {
    if (error.status === 401) {
      // Handle unauthorized
    } else if (error.status === 404) {
      // Handle not found
    }
  }
}
```

### Global Error Handlers

The SDK surfaces transport failures on the bus. `notifySessionExpired` and
`notifyPermissionDenied` are module-scoped functions the active session
registers itself with on mount, so a 401/403 anywhere in the SDK reaches the
mounted UI:

```tsx
import { notifySessionExpired, notifyPermissionDenied } from '@semiont/react-ui';
import { APIError } from '@semiont/http-transport';

function handleError(error: unknown) {
  if (error instanceof APIError) {
    if (error.status === 401) notifySessionExpired('Session expired');
    if (error.status === 403) notifyPermissionDenied('Access denied');
  }
}
```

When no session is mounted (e.g. on the landing page), the calls are no-ops.

### Error Boundaries

```tsx
<ErrorBoundary fallback={<ErrorPage />}>
  {children}
</ErrorBoundary>
```

---

## Testing Strategy

### Unit Tests

Test individual functions and hooks:

```tsx
describe('formatDate', () => {
  it('should format ISO date', () => {
    expect(formatDate('2024-01-01')).toBe('Jan 1, 2024');
  });
});
```

### Integration Tests

Test components with providers:

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';

it('should fetch and display resources', async () => {
  renderWithProviders(<ResourceList />);
  await screen.findByText('Resource 1');
});
```

### Coverage Goals

- **100% coverage** for utility functions
- **>90% coverage** for components
- **100% coverage** for contexts and providers
- All exported APIs must be tested

See [TESTING.md](TESTING.md) for details.

---

## Performance

### SDK Read-Through Cache

- The SDK's `browse.*` live queries are backed by a read-through
  stale-while-revalidate (SWR) cache (`@semiont/sdk`)
- Stale entries are served to observers while a refetch is in flight; observers
  see the new value when it returns
- Invalidation is implicit — bus events drive cache refreshes, so there are no
  manual invalidation calls in component code

See [CACHE-SEMANTICS.md](../../sdk/docs/CACHE-SEMANTICS.md) for the full cache contract.

### Code Splitting

Components are exported individually for tree-shaking:

```tsx
// Apps can import only what they need
import { ResourceViewer } from '@semiont/react-ui';
// Not: import ReactUI from '@semiont/react-ui';
```

### Memoization

Use `useMemo` and `useCallback` judiciously:

```tsx
// ✅ DO: Memoize expensive calculations
const sorted = useMemo(() =>
  items.sort((a, b) => a.name.localeCompare(b.name)),
  [items]
);

// ❌ DON'T: Over-optimize simple operations
const doubled = useMemo(() => count * 2, [count]); // Unnecessary
```

---

## Code Quality Standards

### From CLAUDE.md

1. **No cruft** - Delete dead code immediately
2. **No aliases** - If API changes, update all call sites
3. **No `any` casts** - Without explicit permission
4. **Direct fixes** - Don't create compatibility layers
5. **TypeScript strict mode** - All type errors must be fixed

### Code Review Checklist

- [ ] Zero framework-specific imports
- [ ] All types properly defined (no `any`)
- [ ] Tests cover new functionality
- [ ] Documentation updated
- [ ] No dead code or commented-out code
- [ ] No "TODO" comments (create issues instead)
- [ ] Follows existing patterns

---

## Migration Strategy

When making breaking changes:

1. **Assess impact** - How many files affected?
2. **Update all call sites** - No aliases or backward compatibility
3. **Update tests** - All tests must pass
4. **Update documentation** - Reflect new APIs
5. **Increment version** - Follow semver

**Example migration:**

```typescript
// v1.0: Old API
client.browse.all();

// v2.0: New API (breaking change)
client.browse.resources({});

// Migration:
// 1. Update ALL files using .all()
// 2. Delete .all() entirely
// 3. Update major version
// 4. Document in CHANGELOG
```

---

## Security

### Authentication

- Never store tokens in localStorage (XSS risk)
- Use httpOnly cookies when possible
- Validate tokens on every API call
- Handle 401/403 responses globally

### Input Validation

```tsx
import { validateResourceInput } from '@semiont/react-ui';

const errors = validateResourceInput(formData);
if (errors.length > 0) {
  // Display errors
}
```

### XSS Prevention

- React escapes by default
- Use `dangerouslySetInnerHTML` only with sanitized HTML
- Validate all user input

### CSRF Protection

- API client includes CSRF tokens
- Apps must configure CSRF middleware

---

## Accessibility

### WCAG 2.1 AA Compliance

All components must meet:

- ✅ Keyboard navigation
- ✅ Screen reader support
- ✅ Color contrast 4.5:1 minimum
- ✅ Focus indicators
- ✅ ARIA labels and roles

### Testing

```tsx
import { axe } from 'jest-axe';

it('should have no a11y violations', async () => {
  const { container } = render(<MyComponent />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

---

## Documentation Standards

### Code Comments

```tsx
/**
 * Fetches resources from the API
 * @param limit - Maximum number of resources to return
 * @returns Promise resolving to array of resources
 */
export async function fetchResources(limit: number): Promise<Resource[]> {
  // Implementation
}
```

### Component Props

```tsx
interface ButtonProps {
  /** Button text */
  children: ReactNode;
  /** Click handler */
  onClick: () => void;
  /** Disable the button */
  disabled?: boolean;
}
```

### README Files

Each major feature should have:
- Overview
- Quick start example
- API reference
- Common patterns
- Link to detailed docs

---

## Versioning

Follow **Semantic Versioning** (semver):

- **Major (x.0.0)** - Breaking changes
- **Minor (0.x.0)** - New features, backward compatible
- **Patch (0.0.x)** - Bug fixes, backward compatible

### Breaking Changes

Considered breaking:
- Removing exported functions/components
- Changing function signatures
- Renaming exports
- Changing behavior that apps depend on

### Non-Breaking Changes

Not breaking:
- Adding new exports
- Adding optional parameters
- Internal refactoring
- Documentation updates

---

## Styling Architecture

### Component-Level CSS Pattern

**Principle:** Styles should live next to components when practical.

**Why:**
- Better developer experience (co-location of concerns)
- Easier to find and maintain styles
- Industry-standard pattern
- No build complexity in react-ui package

**How It Works:**

1. **Component CSS lives next to component:**
   ```
   src/components/pdf-annotation/
   ├── PdfAnnotationCanvas.tsx
   └── PdfAnnotationCanvas.css
   ```

2. **Component imports its CSS** (type hint only, doesn't bundle):
   ```typescript
   // PdfAnnotationCanvas.tsx
   import './PdfAnnotationCanvas.css';
   ```

3. **Main stylesheet imports component CSS:**
   ```css
   /* src/styles/index.css */
   @import '../components/pdf-annotation/PdfAnnotationCanvas.css';
   ```

4. **Package exports source CSS** (not built):
   ```json
   { "exports": { "./styles": "./src/styles/index.css" } }
   ```

5. **Frontend processes everything:**
   - Imports `@semiont/react-ui/styles`
   - PostCSS with `postcss-import` resolves all `@import` statements
   - Bundles into single CSS file

### CSS Build System

- **react-ui:** tsup builds TypeScript only (no CSS bundling)
- **Frontend:** Next.js PostCSS processes CSS with `postcss-import`
- **Key insight:** `import './Component.css'` in TypeScript is a type hint - doesn't bundle anything

### CSS Quality Standards

The codebase enforces strict CSS quality standards via custom Stylelint plugins:

**Custom Linter Rules:**
- `semiont/invariants` - Enforces CSS variables instead of hardcoded colors, requires dark mode variants
- `semiont/accessibility` - Ensures WCAG 2.1 AA compliance, reduced motion support, proper focus indicators
- `semiont/theme-selectors` - Validates dark mode implementation patterns

**Reduced Motion Support:**
- Global reduced-motion overrides in `src/styles/utilities/motion-overrides.css`
- Automatically disables all animations/transitions when `prefers-reduced-motion: reduce`
- Linter recognizes global support for files in `src/styles/`, `src/components/`, and `src/features/`

**Dark Mode Requirements:**
- All components must have `[data-theme="dark"]` variants
- Use CSS variables for colors (never hardcoded hex values)
- Linter enforces consistent dark mode patterns

**Running CSS Linter:**
```bash
npm run lint:css
```

See [STYLES.md](STYLES.md) for comprehensive CSS architecture and conventions.

---

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and event bus usage
- [SESSION.md](SESSION.md) - Provider Pattern implementation
- [API-INTEGRATION.md](API-INTEGRATION.md) - API architecture
- [TESTING.md](TESTING.md) - Testing architecture
- [STYLES.md](STYLES.md) - CSS architecture and conventions
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) - Project-wide code standards
