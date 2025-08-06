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
./scripts/semiont test

# Run tests by application
./scripts/semiont test frontend           # Frontend only
./scripts/semiont test backend            # Backend only
./scripts/semiont test all                # Both apps (default)

# Run tests by type
./scripts/semiont test unit               # Unit tests only
./scripts/semiont test integration        # Integration tests only  
./scripts/semiont test api               # API/route tests only
./scripts/semiont test security          # Security tests only

# Combine application and test type
./scripts/semiont test frontend unit     # Frontend unit tests
./scripts/semiont test backend api       # Backend API tests
./scripts/semiont test all security      # Security tests on both apps

# Additional options
./scripts/semiont test --no-coverage     # Skip coverage reporting
./scripts/semiont test frontend --watch  # Watch mode for development
./scripts/semiont test --verbose         # Detailed output
```

### Local Development Environment for Testing

For integration and API tests that require a database, the Semiont CLI provides an instant local development environment:

```bash
# 🚀 Quick start - full environment for integration tests
./scripts/semiont local start

# This automatically starts:
# ✅ PostgreSQL container with correct schema
# ✅ Backend API server with database connection  
# ✅ Frontend connected to real API

# Then run integration tests against real services
./scripts/semiont test integration

# Or run specific database-dependent tests
./scripts/semiont test backend integration
```

**Benefits for Testing:**
- **Real Database**: Integration tests use actual PostgreSQL instead of mocks
- **Consistent Environment**: Everyone gets identical test setup across machines
- **Zero Configuration**: No manual database setup or connection strings needed
- **Fresh Data**: Use `--reset` flag for clean test data between runs

**Testing Workflow with Local Environment:**

1. **Start local environment**:
   ```bash
   ./scripts/semiont local start --reset  # Fresh database with sample data
   ```

2. **Run tests against real services**:
   ```bash
   ./scripts/semiont test integration     # All integration tests
   ./scripts/semiont test api             # API endpoint tests
   ./scripts/semiont test backend integration # Backend-specific integration
   ```

3. **Stop services when done**:
   ```bash
   ./scripts/semiont local stop
   ```

**Database-Only Testing:**

For backend tests that only need a database:

```bash
# Start just the database
./scripts/semiont local db start --seed

# Run backend tests
./scripts/semiont test backend

# Clean up
./scripts/semiont local db stop
```

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

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [MSW Documentation](https://mswjs.io/)
- [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library Best Practices](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
- [MSW Best Practices](https://mswjs.io/docs/best-practices)