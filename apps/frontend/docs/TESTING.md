# Frontend Testing Guide

**Last Updated**: 2026-01-12

Comprehensive guide to testing the Semiont frontend and how it integrates with the @semiont/react-ui component library testing.

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

Testing in the Semiont frontend is split between two packages following the component library factorization:

- **@semiont/react-ui**: Tests framework-agnostic components and business logic
- **apps/frontend**: Tests Next.js specific integrations and page wrappers

**Key Principles**:
1. **Type Safety First** - TypeScript provides compile-time validation
2. **Separation of Concerns** - Business logic tested in react-ui, integration tested in frontend
3. **API Mocking** - MSW v2 provides realistic mocking without code changes
4. **Performance as Testing** - Lighthouse CI and bundle analysis catch regressions
5. **Error Boundaries** - Runtime error handling for edge cases

## Testing Architecture

```
┌─────────────────────────────────────┐
│         apps/frontend               │
│         Test Coverage:              │
│                                     │
│  • Next.js page wrappers            │
│  • API routes                       │
│  • NextAuth integration             │
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
- Custom hooks (useResources, useAnnotations, etc.)
- Utility functions
- Provider logic
- UI components (Button, Card, ResourceViewer, etc.)

**In apps/frontend** (Next.js specific):
- Page wrappers that use Next.js hooks
- API route handlers
- NextAuth configuration
- Integration flows across pages
- App-specific components

## Running Tests

### Using Semiont CLI (Recommended)

```bash
# With SEMIONT_ENV set (e.g., export SEMIONT_ENV=local)

# Run all frontend tests with coverage
semiont test --service frontend

# Run specific test types for frontend
semiont test --service frontend --suite unit         # Unit tests only
semiont test --service frontend --suite integration  # Integration tests only
semiont test --service frontend --suite security    # Security tests only

# Override environment for staging tests
semiont test --environment staging --service frontend --suite integration

# Watch mode for development
semiont test --service frontend --suite unit --watch

# Skip coverage reporting for faster runs
semiont test --service frontend --no-coverage
```

### Direct npm Scripts

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests (excludes integration tests)
npm run test:integration   # Integration tests only (signup flows, etc.)
npm run test:api           # API route tests only
npm run test:security      # Security-focused tests only

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (development)
npm run test:watch

# Type checking
npm run type-check

# Build (includes type checking)
npm run build

# Performance testing
npm run perf
```

### Performance Benefits

Specific test type filtering provides significant performance improvements:

- **Unit tests**: Fast execution by excluding integration tests
- **Integration tests**: Massive speedup for testing user flows
- **API tests**: Focuses on Next.js API routes
- **Security tests**: Authentication, GDPR compliance, and validation tests

## Test Stack

- **Test Runner**: [Vitest](https://vitest.dev/) - Fast, ESM-native test runner built on Vite
- **Testing Library**: [React Testing Library](https://testing-library.com/react) for component testing
- **API Mocking**: [MSW v2](https://mswjs.io/) for intercepting and mocking API requests
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
- `src/components/__tests__/CookieBanner.test.tsx`
- `src/lib/__tests__/cookies.test.ts`
- `src/hooks/__tests__/useAuth.test.ts`

### Integration Tests

```
src/
└── app/auth/__tests__/
    └── signup-flow.integration.test.tsx  # Multi-component user flows
```

**What to test**:
- Multi-step user flows (signup, login, document creation)
- Component interactions across boundaries
- End-to-end feature workflows

### API Tests

```
src/
└── app/
    ├── auth/[...nextauth]/__tests__/     # NextAuth.js route tests
    ├── cookies/consent/__tests__/        # Cookie consent API tests
    └── cookies/export/__tests__/         # Data export API tests
```

**What to test**:
- Next.js API route handlers
- Request/response validation
- Error handling

### Security Tests

Security-focused tests are identified by naming pattern (`*security*`) and test:
- Authentication flows and JWT validation
- GDPR compliance features (cookie consent, data export)
- Admin access controls and authorization
- Input validation and sanitization

### Mock Infrastructure

```
src/mocks/                        # MSW mock handlers
├── browser.ts                    # Browser-side MSW setup
├── server.ts                     # Node-side MSW setup
└── handlers.ts                   # API mock handlers
```

## Writing Tests

### Component Test Example

```typescript
// src/components/__tests__/CookieBanner.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CookieBanner } from '../CookieBanner';

describe('CookieBanner', () => {
  it('should show banner when consent is not given', async () => {
    render(<CookieBanner />);

    expect(screen.getByText(/We use cookies/)).toBeInTheDocument();
  });

  it('should handle accept all cookies', async () => {
    render(<CookieBanner />);

    const acceptButton = screen.getByText('Accept All');
    fireEvent.click(acceptButton);

    // Banner should be hidden after accepting
    expect(screen.queryByText('Accept All')).not.toBeInTheDocument();
  });
});
```

### API Mocking with MSW

```typescript
// src/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/hello/greeting', () => {
    return HttpResponse.json({
      message: 'Hello from MSW!',
      timestamp: new Date().toISOString(),
    });
  }),

  http.post('/api/auth/login', async ({ request }) => {
    const { email } = await request.json();
    return HttpResponse.json({
      user: { email, id: '123' },
      token: 'mock-jwt-token',
    });
  }),
];
```

### Testing with Vitest

Vitest provides a Jest-compatible API with better ESM support:

```typescript
// Mocking modules
vi.mock('@/lib/cookies', () => ({
  getCookieConsent: vi.fn(),
  setCookieConsent: vi.fn(),
}));

// Spying on functions
const mockFn = vi.fn();
vi.spyOn(window, 'fetch').mockResolvedValue(response);

// Assertions
expect(element).toBeInTheDocument();
expect(mockFn).toHaveBeenCalledWith(expectedArgs);
```

### Hook Testing Example

```typescript
// src/hooks/__tests__/useAuth.test.ts
import { renderHook, waitFor } from '@testing-library/react';
import { useAuth } from '../useAuth';

describe('useAuth', () => {
  it('should return authentication status', async () => {
    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });
  });
});
```

### Integration Test Example

```typescript
// src/app/auth/__tests__/signup-flow.integration.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SignupPage from '../signup/page';

describe('Signup Flow', () => {
  it('should complete full signup process', async () => {
    render(<SignupPage />);

    // Fill out form
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'test@example.com' }
    });

    // Submit form
    fireEvent.click(screen.getByText('Sign Up'));

    // Verify success
    await waitFor(() => {
      expect(screen.getByText('Welcome!')).toBeInTheDocument();
    });
  });
});
```

## Testing Philosophy

### Type Safety as Test Coverage

TypeScript provides compile-time validation across all components:

```typescript
// All components are fully typed
export function GreetingSection(): JSX.Element {
  const { data, error, isLoading } = api.hello.greeting.useQuery();
  // TypeScript ensures data structure matches API contract
}
```

**Benefits**:
- Catch type errors before runtime
- IDE autocomplete and refactoring support
- Self-documenting code

### Error Boundary Testing

Runtime error capture and graceful degradation:

```typescript
// Wrap components in error boundaries
<AsyncErrorBoundary>
  <ComponentThatMightFail />
</AsyncErrorBoundary>
```

**What this provides**:
- Production error capture
- Graceful UI degradation
- Error reporting integration

### Performance-Based Quality Assurance

```bash
# Comprehensive performance testing
npm run perf                    # Full performance analysis
npm run lighthouse             # User experience validation
npm run analyze-bundle         # Bundle size regression detection
```

**Metrics tracked**:
- Bundle size over time
- Lighthouse scores (performance, accessibility, SEO)
- Page load times
- Time to Interactive (TTI)

### Quality Assurance Approach

The frontend relies on multiple layers of quality assurance:

1. **Strict TypeScript** - Catches errors at compile time
2. **Unit Tests** - Critical business logic validation
3. **Integration Tests** - User flow validation
4. **Performance Monitoring** - Real user experience validation
5. **Error Boundaries** - Production error capture and recovery
6. **Bundle Analysis** - Prevent performance regressions
7. **API Contract Testing** - Backend tests validate shared interfaces

## Configuration

### Vitest Configuration

```javascript
// vitest.config.js
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

### TypeScript Support for Tests

Tests benefit from the same strict TypeScript checking as the main codebase:

```bash
# Type check main code
npm run type-check

# Type check test files
npm run type-check:test

# Type check everything
npm run type-check:all
```

A separate `tsconfig.test.json` extends the main TypeScript config to include test files, ensuring type safety across all code.

**Note**: Test files were previously excluded from TypeScript compilation but now have full type checking enabled for better test quality and maintainability.

### ESM Configuration

The project uses native ES modules throughout, ensuring compatibility with modern JavaScript tooling.

## Current Test Coverage

- **42 test files** with **903 tests** - 100% passing
- Comprehensive coverage of cookie consent system, authentication, and UI components
- Key areas with excellent coverage:
  - Cookie management (`cookies.ts`) - 87.57% coverage
  - Cookie UI components - 100% coverage
  - Authentication components - 100% coverage
  - Error boundaries - 100% coverage

## Manual Testing

```bash
# Test authentication flow
curl http://localhost:3000/api/auth/session

# Test API integration
curl http://localhost:3000/api/auth/csrf

# Performance testing
npm run perf
```

## Pure Component Testing Pattern

### Overview

The codebase follows the **Humble Object Pattern** for React components, with business logic components now living in @semiont/react-ui and thin wrappers in the frontend.

### Component Architecture with @semiont/react-ui

**Pure Component** (in `@semiont/react-ui`):
- Contains business logic and UI structure
- All data passed as props or via providers
- No framework-specific hooks (Next.js)
- Thoroughly tested in the react-ui package

**Page Wrapper** (in `apps/frontend/app/`):
- Implements provider interfaces for Next.js
- Calls Next.js hooks (`useRouter`, `useSearchParams`, etc.)
- Wraps components from @semiont/react-ui
- So thin it rarely needs testing

### Example Structure

```typescript
// ✅ Pure Component (@semiont/react-ui/src/components/ResourceViewer.tsx)
export interface ResourceViewerProps {
  resourceId: string;
  onEdit?: (resource: Resource) => void;
  className?: string;
}

export function ResourceViewer(props: ResourceViewerProps) {
  // Uses injected providers for data
  const resources = useResources(); // From ApiClientProvider
  const { t } = useTranslations(); // From TranslationProvider

  const { data, isLoading } = resources.get.useQuery(props.resourceId);

  // Pure component logic - all framework-agnostic
  return (
    <div className={props.className}>
      <h1>{t('resource.title')}</h1>
      {/* ... rest of UI */}
    </div>
  );
}

// ✅ Page Wrapper (apps/frontend/app/[locale]/resources/[id]/page.tsx)
import { ResourceViewer } from '@semiont/react-ui';

export default function ResourcePage({ params }: { params: { id: string } }) {
  // Thin wrapper - just passes params
  return <ResourceViewer resourceId={params.id} />;
}
```

### Testing with Factored Components

**Test in @semiont/react-ui** (business logic):

```typescript
// packages/react-ui/src/components/__tests__/ResourceViewer.test.tsx
import { render, screen } from '@testing-library/react';
import { ResourceViewer } from '../ResourceViewer';
import { TestProviders } from '../../test-utils';

it('renders resource title', async () => {
  const mockResource = {
    id: '123',
    title: 'Test Resource',
    content: 'Test content'
  };

  render(
    <TestProviders
      apiClient={{ resources: { get: { useQuery: () => ({ data: mockResource }) } } }}
      translations={{ 'resource.title': 'Resource Title' }}
    >
      <ResourceViewer resourceId="123" />
    </TestProviders>
  );

  expect(await screen.findByText('Resource Title')).toBeInTheDocument();
  expect(screen.getByText('Test Resource')).toBeInTheDocument();
});
```

**Frontend wrapper tests** (minimal, if needed):

```typescript
// apps/frontend/app/[locale]/resources/[id]/__tests__/page.test.tsx
// Usually not needed - wrapper is too thin
// If testing is required, mock @semiont/react-ui components

vi.mock('@semiont/react-ui', () => ({
  ResourceViewer: ({ resourceId }: { resourceId: string }) => (
    <div>ResourceViewer: {resourceId}</div>
  )
}));
```

### Testing Pattern

**Test the pure component** (contains all business logic):

```typescript
// ✅ Good: Test pure component
import { render, screen } from '@testing-library/react';
import { AdminSecurityPage } from '../components/AdminSecurityPage';

it('renders page title', () => {
  const props = {
    providers: [],
    allowedDomains: [],
    isLoading: false,
    theme: 'light' as const,
    onThemeChange: vi.fn(),
    translations: {
      title: 'Security Settings',
      subtitle: 'Configure authentication',
      // ... rest of translations
    },
    Toolbar: () => <div>Toolbar</div>,
    ToolbarPanels: () => <div>Panels</div>,
  };

  render(<AdminSecurityPage {...props} />);

  expect(screen.getByText('Security Settings')).toBeInTheDocument();
});
```

**Skip the page wrapper** (too thin to test):

```typescript
// ❌ Bad: Testing page wrapper requires mocking everything
import Page from '../page'; // The wrapper

it('renders page', () => {
  // Need to mock: useQuery, useTheme, useTranslations, etc.
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

**Component testing is now split across packages:**

**@semiont/react-ui (1250+ tests):**
- Core UI components: `Button`, `Card`, `Toast`, `StatusDisplay`
- Resource components: `ResourceViewer`, `AnnotateView`, `BrowseView`
- Auth components: `SignUpForm`, `AuthErrorDisplay`, `WelcomePage`
- Annotation components: All annotation UI and popups
- Hooks: `useResources`, `useAnnotations`, `useToast`, etc.
- Utilities: Validation, query keys, annotation registry

**apps/frontend:**
- Page wrappers: Thin Next.js page components
- Integration tests: Multi-step user flows
- API routes: NextAuth, cookie consent, data export
- App-specific components: Home, About, Privacy pages

### Reference Examples

**Testing @semiont/react-ui components:**
```bash
# Run react-ui tests
cd packages/react-ui
npm test

# Example test locations
packages/react-ui/src/components/__tests__/Button.test.tsx
packages/react-ui/src/hooks/__tests__/useResources.test.tsx
packages/react-ui/src/features/auth/__tests__/SignUpForm.test.tsx
```

**Testing frontend integration:**
```bash
# Run frontend tests
cd apps/frontend
npm test

# Example test locations
src/app/[locale]/auth/__tests__/signup-flow.integration.test.tsx
src/app/api/auth/[...nextauth]/__tests__/route.test.ts
```

**Key Testing Pattern**: Business logic lives in @semiont/react-ui and is thoroughly tested there. The frontend only tests Next.js-specific integration and thin wrapper components.

## Future Testing Enhancements

Planned improvements for higher test coverage:

1. **Component Unit Tests** - Expand critical UI component testing
2. **Hook Testing** - Custom React hook validation
3. **Integration Tests** - Full user authentication flows
4. **Visual Regression Tests** - UI consistency validation with Percy/Chromatic
5. **E2E Testing** - Complete user journey validation with Playwright

## Related Documentation

### Testing Guides
- [System Testing Guide](../../../docs/TESTING.md) - Testing across all services
- [Backend Testing](../../backend/docs/TESTING.md) - Backend API tests

### Development Guides
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Contributing Guide](../../../docs/CONTRIBUTING.md) - Contribution guidelines

### External Resources
- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [MSW Documentation](https://mswjs.io/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)

---

**Test Runner**: Vitest
**Coverage Tool**: V8
**Last Updated**: 2026-01-05
