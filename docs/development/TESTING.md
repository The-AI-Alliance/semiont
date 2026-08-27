# Testing Guide - Semiont

This guide covers the testing strategy and implementation for the Semiont project, with a focus on the modern testing stack used in the Browser.

## Overview

The Semiont project uses a modern testing stack built on:
- **Vitest** - Fast, ESM-native test runner
- **MSW v2** - API mocking without implementation details
- **React Testing Library** - Component testing focused on user behavior
- **ES Modules** - Native JavaScript module system throughout

## Test Types and Organization

Semiont organizes tests into five distinct categories for targeted testing:

### 🧩 **Unit Tests**
Test individual components, functions, and hooks in isolation:
- Component rendering and props handling
- Hook behavior and state management
- Utility function logic
- Individual SDK namespace methods

### 🔗 **Integration Tests**
Test component interactions and multi-step workflows:
- Complete user flows (e.g., signup process)
- Component communication
- State management across components
- Form submission workflows

### 🌐 **API Tests**
Test API endpoints, route handlers, and middleware:
- HTTP request/response handling
- Authentication middleware
- Input validation
- Error handling
- Database operations

### 🔒 **Security Tests**
Focus on security-critical functionality:
- Authentication flows
- Authorization checks
- Input sanitization
- GDPR compliance features
- Cookie consent management
- Admin access controls

### 🎭 **End-to-End Tests**
Real-browser Playwright tests that drive the live Browser against a live backend and KB stack. Catch cross-layer regressions that unit and integration tests can't see:
- SSE timing and reconnect
- React lifecycle ↔ event-bus interaction
- Cross-package round-trips (Browser → backend → make-meaning → workers)
- Auth session rebuild after sign-out/sign-in
- Persistence: annotation reload, view-state survival

Lives in [`tests/e2e/`](../../tests/e2e/) (separate npm workspace; not bundled with package tests). See the [End-to-End Tests](#end-to-end-tests) section below for the full picture.

## Test Environment Configuration

Semiont uses a hierarchical test environment system to support different testing scenarios. The test orchestrator (`scripts/test.ts`) is the authoritative source for all test configuration, which is passed to downstream test processes via a temporary JSON file.

### How Configuration Works

1. **Configuration Generation**: When `scripts/test.ts` runs tests, it:
   - Determines the appropriate configuration based on environment, suite, and service
   - Loads and merges configuration from `environments/`
   - Writes the full configuration to a temporary JSON file
   - Sets `SEMIONT_TEST_CONFIG_PATH` environment variable pointing to this file
   - Shows the config file path in the output for transparency

2. **Configuration Access**: Test files can access configuration by:
   - Checking for `SEMIONT_TEST_CONFIG_PATH` environment variable
   - Reading and parsing the JSON file at that path
   - Using the configuration values for test setup

3. **Automatic Cleanup**: The temporary config file is automatically deleted when tests complete

### Environment Hierarchy

```
environments/
├── test.json        # Base test configuration (shared settings)
├── unit.json        # Unit tests (extends test + mocked dependencies)
└── integration.json # Integration tests (extends test + real database)
```

### Environment Selection

Tests automatically use the appropriate environment based on their type:

- **Unit Tests** (config: `unit.ts`):
  - Mocked database connections (`mockMode: true`)
  - No external service dependencies
  - Fast execution, ideal for TDD
  - Used by default Browser tests and backend unit tests

- **Integration Tests** (config: `integration.ts`):
  - Real PostgreSQL via Testcontainers (`useTestcontainers: true`)
  - Actual database operations
  - Full API endpoint testing
  - Used for backend integration tests

- **Base Test** (config: `test.ts`):
  - Shared configuration for all test types
  - Disabled production features (analytics, monitoring)
  - Test-specific domains and emails
  - Rarely used directly, serves as parent config

### Configuration Properties

Each test environment provides:
- Test-specific domain and email settings
- Disabled production features (analytics, maintenance mode)
- Appropriate database configuration (mocked vs. real)
- Security settings optimized for testing
- NODE_ENV set to 'test' for all test types

### Using Configuration in Tests

The configuration object passed to tests contains:

```typescript
{
  site: {
    name: string,
    url: string,
    apiUrl: string
  },
  aws: {
    region: string,
    account: string,
    // ... other AWS settings
  },
  app: {
    database: {
      url: string
    },
    // ... other app settings
  }
}
```

#### Option 1: Using the Config Loader Helper

```typescript
import { loadTestConfig, getTestConfigValue } from '@/config/test-config-loader';

// In your test setup
const config = loadTestConfig();
if (config) {
  // Use config.site.apiUrl, config.app.database.url, etc.
  const apiUrl = config.site.apiUrl;
  const dbUrl = config.app?.database?.url;
}

// Or get specific values
const apiUrl = getTestConfigValue('site.apiUrl', 'http://localhost:3001');
```

#### Option 2: Direct Access in Test Setup

```typescript
// In your test setup file (e.g., vitest.setup.js)
import { readFileSync } from 'fs';

const configPath = process.env.SEMIONT_TEST_CONFIG_PATH;
if (configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  // Use configuration values
  process.env.SERVER_API_URL = config.site.apiUrl;
  process.env.DATABASE_URL = config.app?.database?.url;
}
```

### Benefits of This Approach

1. **Single Source of Truth**: All configuration originates from `scripts/test.ts`
2. **Type Safety**: Configuration can be typed and validated
3. **Environment Agnostic**: Tests don't need to know about NODE_ENV
4. **Flexible**: Full configuration object available, not just simple flags
5. **Clean**: Temporary files are automatically cleaned up after tests
6. **Transparent**: Config file paths are shown in test output for debugging

## Browser Testing Stack

### Core Technologies

#### Vitest
- ESM-first test runner built on Vite
- Jest-compatible API for easy migration
- Blazing fast with parallel test execution
- Native TypeScript support

#### MSW (Mock Service Worker) v2
- Intercepts requests at the network level
- Works in both Node.js and browser environments
- Provides realistic API mocking
- No implementation details in tests

#### React Testing Library
- Encourages testing user interactions
- Focuses on accessibility and user experience
- Works seamlessly with Vitest

### Configuration

### TypeScript Configuration for Tests

To enable strict TypeScript checking for test files, create a separate `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vitest", "vitest/globals", "@testing-library/jest-dom", "node"],
    "noEmit": true,
    "allowJs": true
  },
  "include": [
    "vitest.setup.js",
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/**/*.spec.ts", 
    "src/**/*.spec.tsx",
    "src/**/__tests__/**/*",
    "src/mocks/**/*",
    "src/types/**/*"
  ],
  "exclude": ["node_modules"]
}
```

Add these scripts to `package.json` for type checking:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "typecheck:test": "tsc --noEmit -p tsconfig.test.json",
    "typecheck:all": "npm run typecheck && npm run typecheck:test"
  }
}
```

**Note**: When using Vitest with TypeScript, you may encounter issues with the `vi` namespace in type annotations. To fix this, import types explicitly:

```typescript
// Instead of:
const mock = fn as vi.MockedFunction<typeof fn>

// Use:
import type { MockedFunction } from 'vitest'
const mock = fn as MockedFunction<typeof fn>
```

#### `vitest.config.js`
```javascript
import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/*',
        'src/mocks/**',
        '**/__tests__/**',
        'vitest.setup.js'
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

#### `vitest.setup.js`
```javascript
import '@testing-library/jest-dom'
import { beforeAll, afterEach, afterAll, vi } from 'vitest'
import { server } from './src/mocks/server.js'

// Enable API mocking with MSW
beforeAll(() => server.listen({
  onUnhandledRequest: 'warn'
}))

// Reset any runtime request handlers we may add during the tests
afterEach(() => server.resetHandlers())

// Disable API mocking after the tests are done
afterAll(() => server.close())

// Mock the host's router
vi.mock('next/navigation', () => ({
  useRouter() {
    return {
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    }
  },
  useSearchParams() {
    return {
      get: vi.fn(),
    }
  },
  usePathname() {
    return ''
  },
  redirect: vi.fn(),
  notFound: vi.fn(),
}))

// Mock URL.createObjectURL and URL.revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
global.URL.revokeObjectURL = vi.fn()
```

### MSW Setup

#### `src/mocks/server.ts`
```typescript
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
```

#### `src/mocks/browser.ts`
```typescript
import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export const worker = setupWorker(...handlers)
```

#### `src/mocks/handlers.ts`
```typescript
import { http, HttpResponse } from 'msw'

export const handlers = [
  // Health check endpoint
  http.get('/api/health', () => {
    return HttpResponse.json({ status: 'ok' })
  }),

  // Authentication endpoints
  http.get('/api/auth/session', () => {
    return HttpResponse.json({
      user: { 
        email: 'test@example.com',
        name: 'Test User'
      }
    })
  }),

  // Cookie consent endpoint
  http.post('/api/cookies/consent', async ({ request }) => {
    const consent = await request.json()
    return HttpResponse.json({
      success: true,
      consent: {
        ...consent,
        timestamp: new Date().toISOString(),
        version: '1.0'
      }
    })
  }),
]
```

## Writing Tests

### Component Tests

```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CookiePreferences } from '../CookiePreferences'
import * as cookieLib from '@/lib/cookies'

// Mock the cookies library
vi.mock('@/lib/cookies', () => ({
  getCookieConsent: vi.fn(),
  setCookieConsent: vi.fn(),
  exportUserData: vi.fn(),
  COOKIE_CATEGORIES: [
    {
      id: 'necessary',
      name: 'Strictly Necessary',
      description: 'Essential cookies',
      required: true,
      cookies: ['session', 'csrf-token']
    },
    // ... more categories
  ]
}))

describe('CookiePreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Set up default mock behavior
    (cookieLib.getCookieConsent as vi.Mock).mockReturnValue({
      necessary: true,
      analytics: false,
      marketing: false,
      preferences: true,
      timestamp: '2024-01-01T00:00:00Z',
      version: '1.0'
    })
  })

  it('should display all cookie categories', () => {
    render(<CookiePreferences isOpen={true} onClose={vi.fn()} />)
    
    expect(screen.getByText('Strictly Necessary')).toBeInTheDocument()
    expect(screen.getByText('Analytics')).toBeInTheDocument()
    expect(screen.getByText('Marketing')).toBeInTheDocument()
    expect(screen.getByText('Preferences')).toBeInTheDocument()
  })

  it('should save preferences when clicking save button', async () => {
    const onClose = vi.fn()
    render(<CookiePreferences isOpen={true} onClose={onClose} />)
    
    // Toggle analytics on
    const analyticsSwitch = screen.getByRole('checkbox', { name: /Analytics/ })
    fireEvent.click(analyticsSwitch)
    
    // Click save
    const saveButton = screen.getByText('Save Changes')
    fireEvent.click(saveButton)
    
    // Verify the save was called with correct data
    expect(cookieLib.setCookieConsent).toHaveBeenCalledWith({
      necessary: true,
      analytics: true,
      marketing: false,
      preferences: true,
      timestamp: expect.any(String),
      version: expect.any(String)
    })
    expect(onClose).toHaveBeenCalled()
  })
})
```

### API Route Tests

```typescript
import { describe, it, expect, vi } from 'vitest'
import { POST } from '../route'
import { NextRequest } from 'next/server'

describe('POST /api/cookies/consent', () => {
  it('should store cookie consent', async () => {
    const request = new NextRequest('http://localhost:3000/api/cookies/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        necessary: true,
        analytics: true,
        marketing: false,
        preferences: true
      })
    })

    const response = await POST(request)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.consent).toMatchObject({
      necessary: true,
      analytics: true,
      marketing: false,
      preferences: true
    })
  })

  it('should reject invalid consent data', async () => {
    const request = new NextRequest('http://localhost:3000/api/cookies/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        necessary: false, // Invalid - necessary cookies are required
        analytics: true
      })
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
  })
})
```

### Testing Async Components

```typescript
import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GreetingSection } from '../GreetingSection'

// MSW will intercept this API call
describe('GreetingSection', () => {
  it('should display greeting from API', async () => {
    render(<GreetingSection />)
    
    // Wait for the API call to complete
    await waitFor(() => {
      expect(screen.getByText(/Hello from MSW!/)).toBeInTheDocument()
    })
  })
})
```

## Migration from Jest to Vitest

### Key Differences

1. **Import statements**
   ```typescript
   // Jest
   import { jest } from '@jest/globals'
   
   // Vitest
   import { vi } from 'vitest'
   ```

2. **Mocking**
   ```typescript
   // Jest
   jest.mock('./module')
   jest.fn()
   jest.spyOn()
   
   // Vitest
   vi.mock('./module')
   vi.fn()
   vi.spyOn()
   ```

3. **Configuration**
   - Jest uses `jest.config.js`
   - Vitest uses `vitest.config.js` with Vite-compatible configuration

4. **ESM Support**
   - Jest requires additional configuration for ESM
   - Vitest has native ESM support out of the box

### Migration Steps

1. **Install Vitest dependencies**
   ```bash
   npm install --save-dev vitest @vitest/coverage-v8 jsdom
   ```

2. **Update test scripts in package.json**
   ```json
   {
     "scripts": {
       "test": "vitest run",
       "test:watch": "vitest",
       "test:coverage": "vitest run --coverage",
       "test:unit": "vitest run --testNamePattern=\"^(?!.*integration).*\"",
       "test:integration": "vitest run --testNamePattern=\"integration\"",
       "test:api": "vitest run [specific-api-test-files]",
       "test:security": "vitest run --testNamePattern=\"security\""
     }
   }
   ```

3. **Replace Jest imports**
   - Find and replace `jest` with `vi`
   - Update any Jest-specific APIs

4. **Update MSW to v2**
   ```bash
   npm install msw@latest --save-dev
   ```

5. **Convert to ESM syntax**
   - Use `import` instead of `require`
   - Add `"type": "module"` to package.json if needed

## Best Practices

### 1. Test User Behavior, Not Implementation
```typescript
// ❌ Bad - Testing implementation details
expect(component.state.isOpen).toBe(true)

// ✅ Good - Testing user-visible behavior
expect(screen.getByText('Modal content')).toBeInTheDocument()
```

### 2. Use Accessible Queries
```typescript
// ❌ Bad - Using test IDs
const button = screen.getByTestId('submit-button')

// ✅ Good - Using accessible roles and text
const button = screen.getByRole('button', { name: /submit/i })
```

### 3. Mock at the Network Level
```typescript
// ❌ Bad - Mocking implementation
vi.mock('./http-transport', () => ({
  fetchData: vi.fn(() => Promise.resolve(mockData))
}))

// ✅ Good - Using MSW to mock at network level
http.get('/api/data', () => {
  return HttpResponse.json(mockData)
})
```

### 4. Keep Tests Focused
```typescript
// Each test should verify one behavior
it('should show error message when API fails', async () => {
  // Arrange - Set up error response
  server.use(
    http.get('/api/data', () => {
      return HttpResponse.error()
    })
  )
  
  // Act - Render component
  render(<DataDisplay />)
  
  // Assert - Check error is displayed
  await waitFor(() => {
    expect(screen.getByText(/error loading data/i)).toBeInTheDocument()
  })
})
```

### 5. Use Descriptive Test Names
```typescript
// ❌ Bad
it('should work', () => {})

// ✅ Good
it('should display user name after successful login', () => {})
```

### 6. Give `beforeEach`/`beforeAll` a Block Body

Vitest treats a function *returned* from a setup hook as that test's teardown
callback. `mockClear()`, `mockReset()`, and `mockRestore()` all return the mock
itself for chaining, so a concise-arrow hook silently registers the mock as
teardown — and the runner calls it after every test in the describe.

```typescript
// ❌ Bad - returns the mock; vitest calls it as teardown after each test
beforeEach(() => scrollSpy.mockClear());

// ✅ Good - block body returns undefined
beforeEach(() => { scrollSpy.mockClear(); });
```

This stays invisible until someone gives that mock a throwing or rejecting
implementation. Then the test body's assertions pass, teardown invokes the mock,
and the throw propagates — the test fails with the error's *construction* site as
the reported location and no assertion diff, which reads like a bug anywhere but
the hook. Only the mock-method forms are affected; `beforeAll(() =>
vi.clearAllMocks())` is fine, because `vi` is an object rather than a function.

## End-to-End Tests

The e2e suite at [`tests/e2e/`](../../tests/e2e/) is a separate npm workspace running Playwright against a real running stack. It exists to catch regressions that no in-process test can see: SSE timing windows, lifecycle-vs-bus race conditions, navigation tear-down, sign-out/sign-in session rebuild, and end-to-end persistence of annotations across reload.

The suite is **deliberately scoped**. It is the smallest set of paths that has broken before and that unit/integration tests can't catch. Pure component logic stays in unit tests; multi-component interaction in a mocked tree stays in integration tests; e2e is reserved for cross-layer behavior that requires the real wire.

### What's in scope

- **Not in CI.** Run locally against a manually-brought-up stack. Adding CI requires fixture isolation work that hasn't happened yet.
- **No fixture seeding.** Tests assume the target KB has ≥2 resources and ≥1 entity type — true of the default template KB. Property-style assertions ("the first resource", "any annotation"), not specific-content assertions.
- **No real OAuth.** Credentials sign-in only.
- **Single-worker.** Concurrency requires per-test isolation that doesn't exist yet.
- **Chromium only.** No cross-browser matrix.

### Layout

```text
tests/e2e/
├── specs/                            # one .spec.ts per regression-guarded path
│   ├── 01-sign-in.spec.ts            # sign-in → land on knowledge section
│   ├── 02-open-resource.spec.ts      # open from Discover, content loads
│   ├── 03-navigate-resources.spec.ts # tab between two open resources
│   ├── 04-manual-highlight.spec.ts   # select → motivation=highlight, persists across reload
│   ├── 05-manual-reference.spec.ts   # select → motivation=linking + entity type, persists
│   ├── 06-assisted-reference.spec.ts # assist widget dispatches across the wire
│   ├── 07-sign-out-sign-in.spec.ts   # session rebuilds; bus round-trips on fresh client
│   ├── 08-hover-beckon.spec.ts       # hover annotation → BeckonStateUnit focus signal flows
│   └── 99-diagnose-entity-types.spec.ts  # singleton-ness diagnostic (not a guard)
├── fixtures/
│   ├── auth.ts                       # signedInPage fixture; depends on bus
│   └── bus-log.ts                    # wire-level bus capture API
├── docs/                             # the operations manual (linked below)
├── playwright.config.ts
└── package.json                      # separate workspace — own deps
```

A regression in any of `01`–`08` fails the corresponding test. `99-diagnose-entity-types.spec.ts` is a running dashboard for the SSE-reconnect singleton invariants — it doesn't assert pass/fail in the regression sense.

### Protocol-level assertions, not just UI

The unique feature of the e2e suite is **wire-level assertions** via the bus-log capture. UI assertions are weak — "the highlight appeared" passes if the UI ended up right via a stale cache, a different endpoint, or a broken handler that got backfilled by a refetch. Protocol assertions are strong — "a `mark:create-request` was emitted, and a `mark:create-ok` arrived with matching `correlationId`" fails immediately if the wire regresses.

Every emit/recv/SSE/PUT/GET that crosses a transport boundary is logged in a grep-friendly format the moment `__SEMIONT_BUS_LOG__` is on:

```
[bus EMIT] mark:create-request [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
[bus RECV] mark:create-ok      [scope=res-1] [cid=a89a670a] [trace=8f3ca4ed] {...}
```

The `bus` fixture flips that flag via `addInitScript` before page load and collects the lines into a structured capture:

```ts
import { test, expect } from '../fixtures/auth';

test('manual highlight persists', async ({ signedInPage: page, bus }) => {
  await page.goto('/en/know/discover');
  bus.clear();  // scope assertions to what follows

  await page.getByRole('button', { name: /open resource/i }).first().click();
  // ... drive the highlight gesture ...

  // Wire-level assertion — strongest:
  await bus.expectRequestResponse('mark:create-request', 'mark:create-ok');

  // UI assertion — weaker, but catches rendering bugs:
  await expect(page.getByText(/your highlight/i)).toBeVisible();
});
```

The same bus log works in Node — set `SEMIONT_BUS_LOG=1` and every backend / worker / smelter emit gets logged. Useful well beyond e2e; covered in [`tests/e2e/docs/bus-logging.md`](../../tests/e2e/docs/bus-logging.md).

### Required environment

Two required, two with local-dev defaults:

| Var | Default | Purpose |
|---|---|---|
| `E2E_EMAIL` | (required) | User to sign in as |
| `E2E_PASSWORD` | (required) | Password for that user |
| `E2E_BROWSER_URL` | `http://localhost:3000` | The Browser the tests drive |
| `E2E_BACKEND_URL` | `http://localhost:4000` | Backend the sign-in form points at |

The default seeded admin is `admin@example.com` / `password`. No fallback — the suite fails fast if `E2E_EMAIL`/`E2E_PASSWORD` aren't set, on purpose (no silent use of a default account).

### Quick run

The recommended path on macOS is the official Playwright container, which can reach the dev stack's bridge IPs directly:

```sh
# 1. Bring up the stack (Browser + backend + KB), once per session.
#    See tests/e2e/README.md "Running against a freshly-built stack".

# 2. Re-grab IPs every time anything restarts (Apple container reassigns them).
container ls | grep -E 'semiont-(frontend|backend)'

# 3. Run the suite.
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://<browser-ip>:3000 \
  -e E2E_BACKEND_URL=http://<backend-ip>:4000 \
  -e CI=1 \
  mcr.microsoft.com/playwright:v1.59.1-noble \
  npm test
```

Use `npm test` rather than `npx playwright test`: `pretest` runs
`tsc --noEmit` over the specs and aborts before any browser starts.
`tests/e2e` is not a root workspace, so nothing else typechecks it.

Run from the host (with Node + Playwright installed):

```sh
cd tests/e2e
npm install
npx playwright install chromium    # one-time browser download
npm test
npm run test:headed     # watch the browser
npm run test:debug      # Playwright inspector (step through)
npm run test:ui         # Playwright runner UI
```

Run a single spec or a single test by title:

```sh
npm test -- specs/02-open-resource.spec.ts
npm test -- -g 'opens the first resource'
```

(`npm test -- <args>` keeps the typecheck gate; bare `npx playwright test`
skips it.)

`--repeat-each 5` is the default flake check — a deterministic test passes 5/5; a race fails a fraction of the time. Reach for it before claiming a flake is fixed.

### Debugging failures

Inner loop, in priority order:

1. **Re-run the failing test with the bus log** under `--repeat-each 3` to separate flake from determinism.
2. **Tail the backend** during the run: `container logs -f semiont-backend`. If the event never reaches the backend, it's a Browser emit/subscribe problem; if the backend logs the emit but no SSE write follows, it's a result-channel problem.
3. **Open the trace report** (`npm run show-report`). Each failed test has a DOM snapshot, a screenshot, a video, and a `trace.zip` for time-travel debugging in Playwright's trace viewer.
4. **Pull `console.error` from the trace** without booting the viewer — see [`tests/e2e/docs/debugging.md`](../../tests/e2e/docs/debugging.md#pulling-a-js-error-from-a-trace) for the JSONL recipe.
5. **Write a throwaway diagnostic spec** with the minimum flow and no assertions. If the diagnostic succeeds where the real test fails, the delta between them is the bug.
6. **Last resort: `npm run test:headed`** and watch.

The recurring lesson: instrument, don't speculate. A `console.log` in the product code → rebuild → restart → re-run is a 90-second round-trip. Twenty minutes of "what should happen" reasoning rarely beats it.

### Container rebuild flow (when you've changed product code)

Anything inside `@semiont/*` is published to a local Verdaccio and consumed via `npm install` in the container builds — your local source tree is invisible to the running stack until you republish.

| Change in | Rebuild | Restart |
|---|---|---|
| `packages/react-ui`, `packages/http-transport`, `packages/core`, `packages/sdk` | `./scripts/ci/local-build.sh` | Browser container |
| `apps/browser` only | `./scripts/ci/local-build.sh` | Browser container |
| `packages/make-meaning`, `event-sourcing`, anything backend-side | `./scripts/ci/local-build.sh` (rebuilds the `:local` images) | the stack: `SEMIONT_VERSION=local semiont start` |
| `apps/backend` | `./scripts/ci/local-build.sh` | the stack: `SEMIONT_VERSION=local semiont start` |

Two pitfalls that have caught real time before:

- **`SEMIONT_VERSION=local` is load-bearing.** `local-build.sh` builds all five images (and the launcher) as local-only `:local` tags — but a KB stack consumes them only when started with `SEMIONT_VERSION=local semiont start`. Without it, the launcher pulls the published images and your local changes are invisible.
- **Apple container `--rm` is unreliable.** Stopped containers linger and conflict on next start. Wipe with `container stop $name && container rm $name` before retrying.

Full step-by-step in [`tests/e2e/docs/containers.md`](../../tests/e2e/docs/containers.md).

### Writing a new e2e test

Keep the bar high: **a path that has broken before, that unit/integration tests can't catch.** Cross-layer regressions are the sweet spot.

Spec template:

```ts
// specs/NN-short-name.spec.ts
import { test, expect } from '../fixtures/auth';

test.describe('short description', () => {
  test('does the thing', async ({ signedInPage: page, bus }) => {
    await page.goto('/en/know/discover');
    bus.clear();

    await page.getByRole('button', { name: /some action/i }).click();

    // Strong: protocol assertion.
    await bus.expectRequestResponse('foo:requested', 'foo:result');

    // Optional: UI assertion for rendering details.
    await expect(page.getByText(/success/i)).toBeVisible();
  });
});
```

Key conventions:

- **Fixture ordering matters.** The `bus` fixture's `addInitScript` runs *before* `page.goto`. That ordering is guaranteed when you destructure `bus` in the test params or use `signedInPage` (which depends on `bus`). If you build a helper that creates its own `page`, re-attach the bus log there with `attachBusLog(page)` first.
- **Selectors prefer role + accessible name.** Fall back to `getByPlaceholder` only when role-based queries can't disambiguate. No `data-testid` convention yet.
- **Skip explicitly.** `test.skip(...)` with a one-line reason. Never let a test pass by silently returning early.

Full guide: [`tests/e2e/docs/writing.md`](../../tests/e2e/docs/writing.md).

### Known gotchas

The ones that have cost real debugging time, captured so you don't re-discover them:

- **`crypto.randomUUID` requires a secure context.** `localhost` and `127.0.0.1` count as secure; arbitrary `http://192.168.x.x` does not. The auth fixture polyfills it via `addInitScript`. The polyfill is also masking a latent product bug — any user hitting the Browser over HTTP from a non-localhost hostname hits the same issue.
- **Container IPs change on every restart.** Apple's container runtime reassigns bridge IPs on every `container run` and every `container start`. Re-grab both IPs before each test run.
- **Stale browser tabs poison backend logs.** A lingering tab from an earlier dev session retries SSE with an expired token, flooding `container logs` with `401`s. Close the tab before debugging.
- **Playwright image tag must match `@playwright/test`.** When `npm install` upgrades the package, pull the matching `mcr.microsoft.com/playwright:<version>-noble`.

Full list in [`tests/e2e/docs/gotchas.md`](../../tests/e2e/docs/gotchas.md).

### Where to read next

The operational depth lives in [`tests/e2e/docs/`](../../tests/e2e/docs/):

- **[running.md](../../tests/e2e/docs/running.md)** — invocation, single spec, headed, `--repeat-each`, host vs. container.
- **[containers.md](../../tests/e2e/docs/containers.md)** — Apple container CLI, Verdaccio, full rebuild lifecycle.
- **[writing.md](../../tests/e2e/docs/writing.md)** — spec template, fixture ordering, selector conventions.
- **[debugging.md](../../tests/e2e/docs/debugging.md)** — traces, JSONL recipes, diagnostic specs.
- **[bus-logging.md](../../tests/e2e/docs/bus-logging.md)** — `__SEMIONT_BUS_LOG__`, the `bus` capture fixture, every helper.
- **[gotchas.md](../../tests/e2e/docs/gotchas.md)** — full list of sharp edges.

## Coverage Goals

### Current Coverage
- Overall: ~22% line coverage
- Cookie management: 87.57%
- UI Components: 88-100%
- API routes: Limited coverage

### Target Coverage
- Critical business logic: 90%+
- UI components: 80%+
- Utility functions: 90%+
- API routes: 70%+

### Excluded from Coverage
- Test files themselves
- Mock data and handlers
- Configuration files
- Type definition files

## Running Tests

Tests run through each workspace's npm scripts — vitest underneath. There is no
`semiont test` command: the `semiont` launcher runs knowledge bases, not this
monorepo's test suite.

### Per-workspace scripts

Backend (`apps/backend/`):

```bash
npm test                    # Everything
npm run test:unit           # Excludes integration
npm run test:integration    # Spins up PostgreSQL (see below)
npm run test:api            # Admin endpoints, docs, auth middleware
npm run test:security        # Name-pattern: security
npm run test:coverage       # Everything, with coverage
npm run test:watch          # Watch mode
```

Browser (`apps/browser/`):

```bash
npm test                    # Everything
npm run test:unit           # Excludes integration
npm run test:integration    # Name-pattern: integration
npm run test:security       # Admin page/layout + validation
npm run test:a11y           # Accessibility assertions
npm run test:coverage       # Everything, with coverage
npm run test:watch          # Watch mode
```

From the repo root, `npm test` fans out to every workspace that defines a `test`
script (`--workspaces --if-present`), and `npm run typecheck` does the same for
`tsc --noEmit`.

To target one workspace from the root, use `--workspace`:

```bash
npm run test:unit --workspace=apps/backend
```

### Run them in a container

This repo's `node_modules` carries **musl** native binaries (rolldown,
lightningcss), so use an Alpine image — a glibc `node:24` fails with a
`*.linux-<arch>-gnu.node` module-not-found:

```bash
container run --rm -v "$(pwd)":/work -w /work node:24-alpine \
  sh -c 'npm run test:unit --workspace=apps/backend'
```

`tsc --noEmit` is libc-agnostic and runs under either image.

### Integration tests need a container runtime

Backend integration tests provision a real PostgreSQL with
[`@testcontainers/postgresql`](https://node.testcontainers.org/) rather than
mocking the database — see `apps/backend/src/__tests__/setup/database.ts`. Docker
works with no configuration. For Podman, point testcontainers at its socket:

**Linux (rootless):**
```bash
systemctl --user enable --now podman.socket
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
```

**macOS:**
```bash
podman machine init && podman machine start
export DOCKER_HOST="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
```

Ryuk (the testcontainers reaper) is disabled by the test setup itself, so there
is no `TESTCONTAINERS_RYUK_DISABLED` to export. If you prefer file-based
configuration, a `.testcontainers.properties` in the repo root works too:

```properties
docker.host=unix:///run/user/1000/podman/podman.sock
ryuk.disabled=true
```

### Coverage

`npm run test:coverage` writes an HTML report to
`apps/{frontend,backend}/coverage/index.html` alongside the console summary.

### End-to-end tests

E2E tests run against a live stack, not a workspace script — see
[End-to-End Tests](#end-to-end-tests) above for the environment they need and how
to bring the stack up.


## Debugging Tests

### Common Issues

1. **Module resolution errors**
   ```typescript
   // Use dynamic imports for ESM modules
   const cookiesModule = await import('@/lib/cookies')
   ```

2. **Vitest globals not found**
   ```typescript
   // Ensure globals: true in vitest.config.js
   // Or import explicitly:
   import { describe, it, expect } from 'vitest'
   ```

3. **MSW not intercepting requests**
   ```typescript
   // Check server is started in setup file
   // Verify request URL matches handler pattern
   ```

4. **Async tests timing out**
   ```typescript
   // Use waitFor for async operations
   await waitFor(() => {
     expect(screen.getByText('Loaded')).toBeInTheDocument()
   }, { timeout: 5000 })
   ```

### Debugging Tools

- `screen.debug()` - Print current DOM
- `screen.logTestingPlaygroundURL()` - Get testing playground link
- `vi.mocked(module).mock.calls` - Inspect mock calls
- MSW request logging in console

## Continuous Integration

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) is the authority on
what passes. It runs on every push and pull request, on Node 24, with these jobs:

| Job | What it covers |
|---|---|
| `test-browser` | `npm run typecheck` + `npm test` for `apps/browser` |
| `test-backend` | typecheck, `npm test`, and `npm run test:integration` for `apps/backend`, against a `postgres:15` service container |
| `test-comprehensive` | Browser and backend suites again, backend integration included, against a `postgres:15` service container |
| `validate-config` | `npm ci --include=optional` + `npm run build:packages` |
| `check-phantom-deps` | imports not declared in the importing package's `package.json` |
| `build-all` | every workspace builds, and `tsc --noEmit` across the monorepo |
| `generated-artifacts` | drift checks: bus registry vs generated code, the bundled OpenAPI spec vs `packages/sdk-go/client_gen.go`, and Go schema coverage |
| `test-launcher` | `apps/launcher` Go tests |

In CI the backend's integration tests reach the `postgres:15` service container
via `DATABASE_URL` rather than starting testcontainers.

Four other workflows carry test gates of their own:
[`security-tests.yml`](../../.github/workflows/security-tests.yml),
[`accessibility-tests.yml`](../../.github/workflows/accessibility-tests.yml),
[`architecture-compliance.yml`](../../.github/workflows/architecture-compliance.yml),
and [`package-tests.yml`](../../.github/workflows/package-tests.yml).

Locally, prefer the targeted script for the code you changed over re-running
everything — CI runs the full matrix.

## Related Documentation

### Application Testing Documentation
- [Browser Testing](../../apps/browser/README.md#testing) - Browser-specific testing setup, scripts, and philosophy
- [Backend Testing](../../apps/backend/README.md#testing) - Backend API testing and integration tests

### End-to-End Testing
- [tests/e2e/README.md](../../tests/e2e/README.md) - Suite overview, current spec list, full stack-rebuild flow
- [running.md](../../tests/e2e/docs/running.md) - Invocation, single spec, headed mode, repeat-each
- [containers.md](../../tests/e2e/docs/containers.md) - Container rebuild lifecycle, Verdaccio publishing, IP refresh
- [writing.md](../../tests/e2e/docs/writing.md) - Spec template, fixture ordering, protocol assertions
- [debugging.md](../../tests/e2e/docs/debugging.md) - Trace report, JSONL extraction, diagnostic specs
- [bus-logging.md](../../tests/e2e/docs/bus-logging.md) - Wire-level capture API and helpers
- [gotchas.md](../../tests/e2e/docs/gotchas.md) - Known sharp edges

### Component Testing
- [Annotation Rendering Principles](../../packages/react-ui/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Property-based testing for annotation renderer
- [Browser Architecture](../../apps/browser/docs/ARCHITECTURE.md) - Component structure and testing strategy

### W3C Compliance Testing
- [W3C-WEB-ANNOTATION.md](../protocol/W3C-WEB-ANNOTATION.md) - W3C Web Annotation compliance and testing

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [MSW Documentation](https://mswjs.io/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [MSW Best Practices](https://mswjs.io/docs/best-practices)