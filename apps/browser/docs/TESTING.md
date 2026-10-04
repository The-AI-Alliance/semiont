# Browser Testing Guide

Comprehensive guide to testing the Semiont Browser and how it integrates with the @semiont/react-ui component library testing.

## Table of Contents

- [Overview](#overview)
- [Testing Architecture](#testing-architecture)
- [Running Tests](#running-tests)
- [Test Stack](#test-stack)
- [Test Structure](#test-structure)
- [Writing Tests](#writing-tests)
- [Testing Philosophy](#testing-philosophy)
- [Configuration](#configuration)
- [Related Documentation](#related-documentation)

## Overview

Testing in the Semiont Browser is split between two packages following the component library factorization:

- **@semiont/react-ui**: Tests framework-agnostic components and business logic
- **apps/browser**: Tests app-specific integrations and route wrappers

**Key Principles**:
1. **Type Safety First** - TypeScript provides compile-time validation
2. **Separation of Concerns** - Business logic tested in react-ui, integration tested in the Browser
3. **Scripted Collaborators** - Component tests script the `SemiontBrowser` that `useSemiont()` returns; integration tests run the real SDK against a `fetch` stub
4. **Performance as Testing** - Bundle analysis catches regressions
5. **Error Boundaries** - Runtime error handling for edge cases

## Testing Architecture

```
┌─────────────────────────────────────┐
│         apps/browser               │
│         Test Coverage:              │
│                                     │
│  • App shell, routing, providers    │
│  • AuthShell & route guards         │
│  • App-specific components          │
│  • Integration flows                │
└─────────────┬───────────────────────┘
              │ uses
              ▼
┌─────────────────────────────────────┐
│    packages/react-ui                │
│         Test Coverage:              │
│                                     │
│  • Core UI components (1250+ tests) │
│  • Business logic                   │
│  • Custom hooks                     │
│  • Utilities and helpers            │
│  • Provider implementations         │
└─────────────────────────────────────┘
```

### What Gets Tested Where

**In @semiont/react-ui** (framework-agnostic):
- Pure components with business logic
- Custom hooks (useObservable, useResourceLoader, useResourceContent, etc.)
- Utility functions
- Provider logic
- UI components (Button, Toolbar, ResourceViewer, etc.)

**In apps/browser** (Vite SPA specific):
- App shell, routing, and provider composition (`providers.tsx`, `AuthShell`)
- Integration flows across components (e.g. a stored session the gateway refuses, surfacing the session-ended modal)
- App-specific components (Home, KnowledgeBasePanel, UserPanel, etc.)

## Running Tests

Run these from `apps/browser/`:

```bash
npm test                    # Everything
npm run test:unit           # Excludes integration tests
npm run test:integration    # Tests whose names match "integration"
npm run test:security       # Protected-layout session gates, the locale layout, validation
npm run test:a11y           # Accessibility assertions
npm run test:coverage       # Everything, with an HTML report in coverage/
npm run test:watch          # Watch mode
npm run test:ui             # Vitest UI

npm run typecheck           # tsc --noEmit
npm run typecheck:all       # Source + test tsconfigs
npm run build               # Typechecks as a prebuild step
```

The Browser tests read no environment config, so there is nothing to export and no
environment to select. To run one of these from the repo root instead, use
`npm run test:unit --workspace=apps/browser`.

There is no `semiont test` command: the `semiont` launcher runs knowledge bases,
not this monorepo's test suite.

For running these in a container, integration-test prerequisites, and the CI
matrix, see [docs/contributor/TESTING.md](../../../docs/contributor/TESTING.md).

## Test Stack

- **Test Runner**: [Vitest](https://vitest.dev/) - Fast, ESM-native test runner built on Vite
- **Testing Library**: [React Testing Library](https://testing-library.com/react) for component testing
- **Assertions**: Vitest's built-in assertions + [@testing-library/jest-dom](https://github.com/testing-library/jest-dom)

## Test Structure

Tests are organized by type for efficient targeted testing:

### Unit Tests

```
src/
├── components/__tests__/          # Component unit tests (UI logic)
├── lib/__tests__/                # Library function tests (utilities)
├── hooks/__tests__/              # Custom hook tests (state management)
└── app/__tests__/                # Page component tests (rendering)
```

**Example locations**:
- `src/components/__tests__/KnowledgeBasePanel.test.tsx`
- `src/lib/__tests__/validation.test.ts`
- `src/contexts/__tests__/AuthShell.test.tsx`

### Integration Tests

```
src/
└── contexts/__tests__/
    └── AuthShell.integration.test.tsx  # Multi-component user flows
```

**What to test**:
- Multi-step user flows (a refused session surfacing its modal)
- Component interactions across boundaries
- End-to-end feature workflows

### App Shell & Routing Tests

The SPA has no server and no API routes; the non-component Browser tests
cover the app shell, routing, and provider composition:

```
src/
├── __tests__/route-auth-shell.test.tsx   # route guards / AuthShell mounting
├── app/__tests__/providers.test.tsx      # root provider composition
└── contexts/__tests__/AuthShell.test.tsx # protected boundary + modals
```

**What to test**:
- Provider composition and the `SemiontProvider` / `AuthShell` boundary
- Route guards and protected-layout mounting
- Auth-failure modal surfacing and error handling

### Security Tests

`npm run test:security` runs the protected-layout session gates
(`src/app/[locale]/__tests__/protected-layout-session-gates.test.tsx`), the locale
layout test (`src/app/[locale]/__tests__/layout.test.tsx`), and the input-validation
tests (`src/lib/__tests__/validation.test.ts`).

### Test Doubles

Component tests replace `react-i18next` with a lookup table and `useSemiont()` with a
scripted browser, through `vi.mock`. Integration tests construct a real `SemiontBrowser`
over `WebBrowserStorage` and stub `fetch`; nothing inside `@semiont/sdk` is mocked
(`src/contexts/__tests__/AuthShell.integration.test.tsx`).

## Writing Tests

### Component Test Example

Condensed from `src/components/__tests__/KnowledgeBasePanel.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KnowledgeBasePanel } from '@/components/KnowledgeBasePanel';

const translations: Record<string, string> = {
  'KnowledgeBasePanel.title': 'Knowledge Bases',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/i18n/routing', () => ({
  usePathname: () => '/know/discover',
}));

// The panel reads the SemiontBrowser through useSemiont(); the test scripts one.
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const { BehaviorSubject } = await vi.importActual<typeof import('rxjs')>('rxjs');
  const production = {
    id: 'kb-1',
    did: 'did:web:prod.example',
    label: 'Production',
    endpoint: { kind: 'http', host: 'prod.example.com', port: 4000, protocol: 'https' },
  };
  const browser = {
    kbs$: new BehaviorSubject([production]),
    activeSession$: new BehaviorSubject({ kb: production }),
    setActiveKb: vi.fn(),
    removeKb: vi.fn(),
    signOut: vi.fn(),
    beginSignIn: vi.fn(),
    readActiveKb: vi.fn().mockResolvedValue({ kind: 'recorded' }),
    getKbSessionStatus: () => 'authenticated',
    emit: vi.fn(),
  };
  return {
    ...actual,
    useSemiont: () => browser,
    useKBDiscovery: () => ({ state: null, kbs: [] }),
  };
});

describe('KnowledgeBasePanel', () => {
  it('should render the panel title', () => {
    render(<KnowledgeBasePanel />);
    expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
  });

  it('should render each recorded knowledge base', () => {
    render(<KnowledgeBasePanel />);
    expect(screen.getByText('Production')).toBeInTheDocument();
  });
});
```

### Testing with Vitest

Vitest provides a Jest-compatible API with better ESM support:

```typescript
import { screen } from '@testing-library/react';

// Mocking modules: keep the real exports, replace one
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return { ...actual, useKBDiscovery: () => ({ state: null, kbs: [] }) };
});

// Spying on functions
const onRetry = vi.fn();
vi.spyOn(console, 'error').mockImplementation(() => {});

// Assertions
expect(screen.getByText('Knowledge Bases')).toBeInTheDocument();
expect(onRetry).toHaveBeenCalledTimes(1);
```

### Hook Testing Example

```typescript
// Mock useSemiont to return a browser with a fake active session, then assert
// downstream behavior. (For richer cases, inject a real SemiontBrowser via
// `<SemiontProvider browser={…}>`, as `src/contexts/__tests__/AuthShell.integration.test.tsx` does.)
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  const user$ = new BehaviorSubject({ did: 'did:web:example.com:users:3f2b9c14-7d81-4e55-9a02-6b1d8e40c7aa', name: 'Alice' });
  const activeSession$ = new BehaviorSubject({ user$, client: {}, kb: { id: 'kb-1' } });
  return {
    ...actual,
    useSemiont: () => ({
      activeSession$,
      activeKbId$: new BehaviorSubject('kb-1'),
      activeSignals$: new BehaviorSubject(null),
    }),
  };
});

describe('some component using session state', () => {
  it('renders for the signed-in user', () => {
    // ...
  });
});
```

## Testing Philosophy

### Type Safety as Test Coverage

TypeScript provides compile-time validation across all components:

```tsx
// All components are fully typed
export function ResourceTitle({ id }: { id: ResourceId }): JSX.Element {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const state = useObservable(semiont?.browse.resource(id));
  // `state` is typed CacheState<ResourceDescriptor> | undefined — the
  // compiler enforces the shape the API contract guarantees
  const resource = state && readyValue(state); // readyValue from @semiont/sdk
  return <h1>{resource?.name}</h1>;
}
```

**Benefits**:
- Catch type errors before runtime
- IDE autocomplete and refactoring support
- Self-documenting code

### Error Boundary Testing

Runtime error capture and graceful degradation, from
`src/components/__tests__/ErrorBoundary.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';

const ThrowError = ({ message }: { message: string }) => {
  throw new Error(message);
};

it('should display specialized async error UI when child throws', () => {
  render(
    <AsyncErrorBoundary>
      <ThrowError message="Async error" />
    </AsyncErrorBoundary>
  );

  expect(screen.getByText('Failed to load this section')).toBeInTheDocument();
  expect(screen.getByText('Async error')).toBeInTheDocument();
});
```

**What this provides**:
- Production error capture
- Graceful UI degradation
- Error reporting integration

### Quality Assurance Approach

The Browser relies on multiple layers of quality assurance:

1. **Strict TypeScript** - Catches errors at compile time
2. **Unit Tests** - Critical business logic validation
3. **Integration Tests** - User flow validation
4. **Performance Monitoring** - Real user experience validation
5. **Error Boundaries** - Production error capture and recovery
6. **Bundle Analysis** - Prevent performance regressions
7. **API Contract Testing** - Gateway tests validate shared interfaces

## Configuration

### Vitest Configuration

`vitest.config.mjs` extends the repo's shared config (`vitest.shared.config.ts`: globals,
the `src/**/*.test.{ts,tsx}` layout, v8 coverage):

```javascript
// vitest.config.mjs (condensed)
import { mergeConfig, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import baseConfig from '../../vitest.shared.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      typecheck: {
        tsconfig: './tsconfig.test.json',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }),
);
```

### TypeScript Support for Tests

Tests benefit from the same strict TypeScript checking as the main codebase:

```bash
# Type check main code
npm run typecheck

# Type check test files
npm run typecheck:test

# Type check everything
npm run typecheck:all
```

A separate `tsconfig.test.json` extends the main TypeScript config to include test files, ensuring type safety across all code.

### ESM Configuration

The project uses native ES modules throughout, ensuring compatibility with modern JavaScript tooling.

## Pure Component Testing Pattern

### Overview

The codebase follows the **Humble Object Pattern** for React components, with business logic components living in @semiont/react-ui and thin wrappers in the Browser.

### Component Architecture with @semiont/react-ui

**Pure Component** (in `@semiont/react-ui`):
- Contains business logic and UI structure
- All data passed as props or via providers
- No framework-specific hooks (no router or app-shell dependencies)
- Thoroughly tested in the react-ui package

**Route Wrapper** (in `apps/browser/src/`):
- Implements provider interfaces for the app shell
- Calls React Router hooks (`useParams`, `useSearchParams`, etc.)
- Wraps components from @semiont/react-ui
- So thin it rarely needs testing

### Example Structure

The resource page is one such pair:

- **Pure page** — `ResourceViewerPage` in `@semiont/react-ui`. The wrapper hands it the
  resource and its id, the locale, `Link` + `routes`, the Browser's `ToolbarPanels`, a
  `refetchDocument` callback, the session's stream status, and the knowledge base's name.
- **Route wrapper** — `src/app/[locale]/know/resource/[id]/page.tsx`. It reads the `:id`
  param and checks it with `isResourceId`, renders nothing but a loading state until a session
  is live, loads the resource through `createResourceLoaderStateUnit`, and renders
  `ResourceViewerPage` with what it loaded.

### Testing with Factored Components

**Test in @semiont/react-ui** (business logic), modeled on
`packages/react-ui/src/components/resource/__tests__/ResourceViewer.embeddable.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { createTestSemiontWrapper, renderInEnglish } from '@semiont/react-ui/test-utils';

it('renders content fed only a session, with no session provider mounted', () => {
  const { session } = createTestSemiontWrapper();

  renderInEnglish(
    <ResourceViewer
      session={session}
      resource={{
        '@context': 'https://www.w3.org/ns/activitystreams',
        '@id': rId,
        name: 'Doc',
        representations: [{ mediaType: 'text/plain', byteSize: 10 }],
        content: 'Embeddable content.',
      }}
      annotations={{ highlights: [], references: [], assessments: [], comments: [], tags: [] }}
    />,
  );

  expect(screen.getByText('Embeddable content.')).toBeInTheDocument();
});
```

**Browser wrapper tests** cover only what the wrapper adds.
`src/app/[locale]/know/resource/[id]/__tests__/navigation.test.tsx` checks that the
resource route rebuilds its loader when the `:id` or the session changes, with the pure
page replaced:

```tsx
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    ResourceViewerPage: ({ rUri }: { rUri: string }) => <div data-testid="resource-rid">{rUri}</div>,
  };
});
```

### Testing Pattern

**Test the pure component** (contains all business logic):

```tsx
// ✅ Good: Test pure component
import { render, screen } from '@testing-library/react';
import { EntityTagsPage } from '@semiont/react-ui';

it('renders page title', () => {
  const props = {
    entityTypes: [],
    isLoading: false,
    error: '',
    newTag: '',
    onNewTagChange: vi.fn(),
    onAddTag: vi.fn(),
    isAddingTag: false,
    theme: 'light' as const,
    activePanel: null,
    translations: {
      pageTitle: 'Entity Tags',
      pageDescription: 'Manage entity type tags',
      sectionTitle: 'Available Tags',
      sectionDescription: 'Tags for categorizing entities',
      inputPlaceholder: 'Enter new tag',
      addTag: 'Add Tag',
      adding: 'Adding...',
    },
    Toolbar: () => <div>Toolbar</div>,
    ToolbarPanels: () => <div>Panels</div>,
  };

  render(<EntityTagsPage {...props} />);

  expect(screen.getByText('Entity Tags')).toBeInTheDocument();
});
```

**Skip the page wrapper** (too thin to test):

```tsx
// ❌ Bad: Testing page wrapper requires mocking everything
import Page from '@/app/[locale]/moderate/entity-tags/page'; // The wrapper

it('renders page', () => {
  // Need to mock: the SDK session/client, useTheme, useTranslations, etc.
  vi.mock('...'); // Many mocks needed!
  renderWithProviders(<Page />); // Complex test setup
});
```

### Benefits

1. **No mocking needed** - Pure components test in isolation
2. **Faster tests** - No framework overhead
3. **More reliable** - Tests actual component logic, not mocks
4. **Better design** - Forces separation of concerns
5. **Easier refactoring** - Change hooks without breaking tests

### Current Status

**Component testing is split across packages:**

**@semiont/react-ui (1250+ tests):**
- Core UI components: `Button`, `Toast`, `StatusDisplay`
- Resource components: `ResourceViewer`, `AnnotateView`, `BrowseView`
- Auth components: `AuthErrorDisplay`
- Annotation components: All annotation UI and popups
- Hooks: `useObservable`, `useResourceContent`, `useMediaToken`, `useToast`, etc.
- Utilities: Validation, annotation registry

**apps/browser:**
- App shell & routing: providers, AuthShell, route guards
- Integration tests: Multi-step user flows
- App-specific components: Home, KnowledgeBasePanel, UserPanel

### Reference Examples

**Testing @semiont/react-ui components:**
```bash
# Run react-ui tests
cd packages/react-ui
npm test

# Example test locations
packages/react-ui/src/components/Button/__tests__/Button.test.tsx
packages/react-ui/src/hooks/__tests__/useResourceContent.test.tsx
packages/react-ui/src/features/auth/__tests__/AuthErrorDisplay.test.tsx
```

**Testing Browser integration:**
```bash
# Run the Browser tests
cd apps/browser
npm test

# Example test locations
src/contexts/__tests__/AuthShell.integration.test.tsx
```

**Key Testing Pattern**: Business logic lives in @semiont/react-ui and is thoroughly tested there. The Browser tests app-shell/routing/provider integration and app-specific components.

## Future Testing Enhancements

Planned improvements for higher test coverage:

1. **Component Unit Tests** - Expand critical UI component testing
2. **Hook Testing** - Custom React hook validation
3. **Integration Tests** - Full user authentication flows
4. **Visual Regression Tests** - UI consistency validation with Percy/Chromatic

## Related Documentation

### Testing Guides
- [System Testing Guide](../../../docs/contributor/TESTING.md) - Testing across all services
- [Gateway Testing](../../gateway/docs/TESTING.md) - Gateway API tests

### Development Guides
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Browser Architecture](./ARCHITECTURE.md) - High-level system design
- [Contributing Guide](../../../CONTRIBUTING.md) - Contribution guidelines

### External Resources
- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
