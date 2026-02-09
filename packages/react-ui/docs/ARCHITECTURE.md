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
- React Query hooks call `SemiontApiClient` directly
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

// ✅ CORRECT - Direct API call
export function useResources() {
  const client = useApiClient();

  return {
    list: {
      useQuery: () => useQuery({
        queryKey: ['resources'],
        queryFn: () => client!.listResources() // Direct call
      })
    }
  };
}
```

---

### Event-Driven Architecture

**Principle:** Components communicate via events, not callback props.

**Why:**

- Eliminates callback prop drilling (0 layers vs 4+ layers)
- No ref stabilization needed
- Type-safe with discriminated unions
- Automatic cache invalidation via events
- Foundation for real-time collaboration
- Components can be anywhere in the tree (no parent-child requirement)

**How:**

- Unified event bus for both backend SSE events and UI interaction events
- `MakeMeaningEventBusProvider` creates resource-scoped event bus
- Components emit events instead of calling callback props
- Components subscribe to events instead of receiving callback props
- React Query cache invalidates automatically via event subscriptions

**Backend Events (from Make-Meaning via SSE):**

- Detection lifecycle: `detection:started`, `detection:progress`, `detection:completed`
- Generation lifecycle: `generation:started`, `generation:progress`, `generation:completed`
- Annotation lifecycle: `annotation:added`, `annotation:removed`, `annotation:updated`
- Entity tags: `entity-tag:added`, `entity-tag:removed`
- Resource changes: `resource:archived`, `resource:unarchived`

**UI Events (Local User Interactions):**

- Selection events: `ui:selection:comment-requested`, `ui:selection:tag-requested`, `ui:selection:assessment-requested`, `ui:selection:reference-requested`

**Example - Before (Callback Props):**

```tsx
// ❌ WRONG - Callback prop drilling (4 layers deep)
interface ResourceViewerProps {
  onCommentRequested: (selection: Selection) => void;
  onTagRequested: (selection: Selection) => void;
  onAssessmentRequested: (selection: Selection) => void;
  // ... 14 more callback props
}

function ResourceViewer({ onCommentRequested, ...callbacks }: ResourceViewerProps) {
  return <TextSelector onCommentRequested={onCommentRequested} />;
}

// TextSelector must receive callback as prop
function TextSelector({ onCommentRequested }: { onCommentRequested: (sel: Selection) => void }) {
  const handleSelection = (sel: Selection) => {
    onCommentRequested(sel); // Call parent's callback
  };
  return <div onMouseUp={handleSelection}>...</div>;
}
```

**Example - After (Events):**

```tsx
// ✅ CORRECT - Event emission (0 layers)
function TextSelector() {
  const eventBus = useMakeMeaningEvents();

  const handleSelection = (selection: Selection) => {
    // Emit event - no callback props needed
    eventBus.emit('ui:selection:comment-requested', {
      exact: selection.exact,
      start: selection.start,
      end: selection.end,
      prefix: extractPrefix(selection.start),
      suffix: extractSuffix(selection.end)
    });
  };

  return <div onMouseUp={handleSelection}>...</div>;
}

// Another component subscribes to the event (can be anywhere in tree)
function AnnotationPanel() {
  const eventBus = useMakeMeaningEvents();
  const [pendingAnnotation, setPendingAnnotation] = useState(null);

  useEffect(() => {
    const handler = (selection) => {
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

**Real Results:**

- **ResourceViewer:** 17 callback props → 0 callback props (100% elimination)
- **ResourceViewer:** 9 useRef (callback stabilization) → 0 useRef (100% elimination)
- **ResourceViewer:** 30+ total props → 6 props (80% reduction)
- **Event-based cache invalidation:** Zero manual `refetch()` calls

**Setup:**

```tsx
import { MakeMeaningEventBusProvider } from '@semiont/react-ui';

export default function ResourcePage({ params }: { params: { id: string } }) {
  const rUri = resourceUri(params.id);

  return (
    <MakeMeaningEventBusProvider rUri={rUri}>
      <ResourceViewerPage rUri={rUri} />
    </MakeMeaningEventBusProvider>
  );
}
```

See [EVENTS.md](EVENTS.md) for complete documentation.

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

See [PROVIDERS.md](PROVIDERS.md) for details.

---

## Project Structure

```
packages/react-ui/
├── src/
│   ├── types/              # TypeScript interfaces
│   │   ├── ApiClientManager.ts
│   │   ├── TranslationManager.ts
│   │   ├── SessionManager.ts
│   │   └── ...
│   ├── contexts/           # React Context providers
│   │   ├── ApiClientContext.tsx
│   │   ├── TranslationContext.tsx
│   │   ├── SessionContext.tsx
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
│   │   ├── useApiClient.ts
│   │   ├── useTheme.ts
│   │   └── __tests__/     # Hook tests
│   ├── lib/               # Utility libraries
│   │   ├── api-hooks.ts   # React Query hooks
│   │   ├── query-keys.ts  # Cache keys
│   │   ├── validation.ts  # Form validation
│   │   └── __tests__/     # Library tests
│   ├── index.ts           # Main exports
│   └── test-utils.tsx     # Testing utilities
├── docs/                  # Documentation
│   ├── PROVIDERS.md
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
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "@tanstack/react-query": "^5.0.0",
    "@semiont/api-client": "*"
  }
}
```

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

Use React Query for server data:

```tsx
const { data } = useResources().list.useQuery();
```

### Context State

Use React Context for cross-cutting concerns:

```tsx
const { isAuthenticated } = useSessionContext();
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
import { APIError } from '@semiont/api-client';

const { data, error } = resources.list.useQuery();

if (error instanceof APIError) {
  if (error.status === 401) {
    // Handle unauthorized
  } else if (error.status === 404) {
    // Handle not found
  }
}
```

### Global Error Handlers

```tsx
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof APIError) {
        dispatch401Error('Session expired');
      }
    }
  })
});
```

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

### React Query Caching

- Default stale time: 5 minutes
- Smart invalidation on mutations
- Background refetching disabled by default

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
resources.all.useQuery();

// v2.0: New API (breaking change)
resources.list.useQuery();

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
- [PROVIDERS.md](PROVIDERS.md) - Provider Pattern implementation
- [API-INTEGRATION.md](API-INTEGRATION.md) - API architecture
- [TESTING.md](TESTING.md) - Testing architecture
- [STYLES.md](STYLES.md) - CSS architecture and conventions
- [CLAUDE.md](../../CLAUDE.md) - Project-wide code standards
