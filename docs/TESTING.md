# Testing Guide - Semiont

This guide covers the testing strategy and implementation for the Semiont project, with a focus on the modern testing stack used in the frontend.

## Overview

The Semiont project uses a modern testing stack built on:
- **Vitest** - Fast, ESM-native test runner
- **MSW v2** - API mocking without implementation details
- **React Testing Library** - Component testing focused on user behavior
- **ES Modules** - Native JavaScript module system throughout

## Test Types and Organization

Semiont organizes tests into four distinct categories for targeted testing:

### 🧩 **Unit Tests**
Test individual components, functions, and hooks in isolation:
- Component rendering and props handling
- Hook behavior and state management
- Utility function logic
- Individual API client methods

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
  - Used by default frontend tests and backend unit tests

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
  process.env.NEXT_PUBLIC_API_URL = config.site.apiUrl;
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

## Frontend Testing Stack

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
    "type-check": "tsc --noEmit",
    "type-check:test": "tsc --noEmit -p tsconfig.test.json",
    "type-check:all": "npm run type-check && npm run type-check:test"
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

// Mock Next.js router
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
vi.mock('./api-client', () => ({
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

### Using the Semiont CLI

The recommended way to run tests is through the `semiont` CLI, which provides intelligent test type filtering and coverage reporting:

```bash
# Run all tests with coverage (default behavior)
semiont test

# Run tests by service and suite
semiont test --service frontend --suite unit     # Frontend unit tests
semiont test --service backend --suite integration # Backend integration tests  
semiont test --service all --suite security      # Security tests on all services

# Run tests by environment
semiont test --environment local              # Local tests (default, uses mocks)
semiont test --environment staging --suite integration        # Integration tests against staging
semiont test --environment production --suite e2e             # E2E tests on production

# Run tests by suite only (all services)
semiont test --suite unit               # Unit tests for all services
semiont test --suite integration        # Integration tests for all services
semiont test --suite security          # Security tests for all services
semiont test --suite e2e               # E2E tests for all services

# Run tests by service only (all suites)  
semiont test --service frontend         # All frontend tests
semiont test --service backend          # All backend tests
semiont test --service database         # Database-specific tests

# Additional options
semiont test --no-coverage     # Skip coverage reporting
semiont test --watch           # Watch mode for development
semiont test --verbose         # Detailed output
semiont test --dry-run         # Show what would be tested
```

### Local Development Environment for Testing

For integration and API tests that require a database, the Semiont CLI provides an instant local development environment:

```bash
# 🚀 Quick start - full environment for integration tests
export SEMIONT_ENV=local
semiont start

# This automatically starts:
# ✅ PostgreSQL container with correct schema
# ✅ Backend API server with database connection  
# ✅ Frontend connected to real API

# Then run integration tests against real services
semiont test --suite integration

# Or run specific database-dependent tests
semiont test --service backend --suite integration
```

**Benefits for Testing:**
- **Real Database**: Integration tests use actual PostgreSQL instead of mocks
- **Consistent Environment**: Everyone gets identical test setup across machines
- **Zero Configuration**: No manual database setup or connection strings needed
- **Fresh Data**: Use `--reset` flag for clean test data between runs

**Testing Workflow with Local Environment:**

1. **Start local environment**:
   ```bash
   export SEMIONT_ENV=local
   semiont start  # Fresh database with sample data
   ```

2. **Run tests against real services**:
   ```bash
   semiont test --suite integration     # All integration tests
   semiont test --service backend --suite integration # Backend-specific integration
   ```

3. **Stop services when done**:
   ```bash
   semiont stop
   ```

**Database-Only Testing:**

For backend tests that only need a database:

```bash
# Start just the database
export SEMIONT_ENV=local
semiont start --service database

# Run backend tests
semiont test --service backend

# Clean up
semiont stop --service database
```

### Container Runtime Support

The local development environment supports both **Docker** and **Podman** container runtimes:

#### Docker (Default)
Works out of the box with no additional configuration.

#### Podman Setup
Podman is fully supported and often provides better performance and security. Here's how to configure it:

**Linux (Recommended):**
```bash
# 1. Enable Podman socket (rootless - more secure)
systemctl --user enable --now podman.socket

# 2. Set environment variables
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED=true

# 3. Start development environment
export SEMIONT_ENV=local
semiont start
```

**macOS:**
```bash
# 1. Set up Podman machine
podman machine init
podman machine start

# 2. Configure environment
export DOCKER_HOST="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
export TESTCONTAINERS_RYUK_DISABLED=true

# 3. Start development environment  
export SEMIONT_ENV=local
semiont start
```

**Alternative: .testcontainers.properties**
Create a `.testcontainers.properties` file in your project root:
```properties
# For rootless Podman (recommended)
docker.host=unix:///run/user/1000/podman/podman.sock
ryuk.disabled=true

# Or for rootful Podman
docker.host=unix:///run/podman/podman.sock
ryuk.privileged=true
```

**Benefits of Podman:**
- **Better Security**: Rootless containers by default
- **Better Performance**: No VM overhead on Linux
- **Resource Efficiency**: Lower memory usage than Docker Desktop
- **Daemonless**: No background daemon required

### Performance Benefits

Targeted test execution provides significant performance improvements:

- **Unit tests**: ~1007 frontend + 176 backend tests (excludes integration)
- **Integration tests**: ~5 frontend + 41 backend tests (massive speedup!)
- **API tests**: ~77 frontend + 60 backend endpoint tests
- **Security tests**: ~5 focused security validation tests

### Coverage Reporting

The CLI automatically generates:
- **Console coverage tables** with color-coded metrics
- **Directory-level breakdowns** showing coverage by code area
- **HTML reports** for detailed analysis (`apps/{frontend,backend}/coverage/index.html`)

Coverage reporting is enabled by default and can be disabled with `--no-coverage`.

### Direct npm Scripts

You can also run tests directly via npm in each app directory:

#### Frontend (`apps/frontend/`)
```bash
npm test                    # All tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:api           # API route tests only
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode
```

#### Backend (`apps/backend/`)
```bash
npm test                    # All tests
npm run test:unit          # Unit tests only  
npm run test:integration   # Integration tests only
npm run test:api           # API tests only
npm run test:security      # Security tests only
npm run test:coverage      # All tests with coverage
npm run test:watch         # Watch mode
```

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

### GitHub Actions Configuration

```yaml
name: Frontend Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
        
      - name: Run type checking
        run: npm run type-check
        
      - name: Run tests with coverage
        run: npm run test:coverage
        
      - name: Upload coverage reports
        uses: codecov/codecov-action@v3
        with:
          directory: ./coverage
```

## Related Documentation

### Application Testing Documentation
- [Frontend Testing](../apps/frontend/README.md#testing) - Frontend-specific testing setup, scripts, and philosophy
- [Backend Testing](../apps/backend/README.md#testing) - Backend API testing and integration tests
- [CLI Testing](../apps/cli/TESTING.md) - CLI command testing and validation

### Component Testing
- [Annotation Rendering Principles](../apps/frontend/docs/ANNOTATION-RENDERING-PRINCIPLES.md) - Property-based testing for annotation renderer
- [Frontend Architecture](../apps/frontend/docs/ARCHITECTURE.md) - Component structure and testing strategy

### W3C Compliance Testing
- [W3C-WEB-ANNOTATION.md](./W3C-WEB-ANNOTATION.md) - W3C Web Annotation compliance and testing

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [MSW Documentation](https://mswjs.io/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [MSW Best Practices](https://mswjs.io/docs/best-practices)