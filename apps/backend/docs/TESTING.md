# Backend Testing Guide

Backend testing guide focused on Jest, unit testing patterns, and backend-specific testing strategies.

**Related Documentation:**
- **[System Testing Guide](../../../docs/TESTING.md)** - **Read this first!** Complete testing strategy including Vitest, MSW v2, frontend testing, and test orchestration
- [Main README](../README.md) - Backend overview
- [Development Guide](./DEVELOPMENT.md) - Local development setup
- [Contributing Guide](./CONTRIBUTING.md) - Code style and patterns

**Scope**: This document covers backend-specific testing using Jest, testing TypeScript services, Prisma database tests, and API endpoint testing. For system-wide testing including Vitest, MSW, and frontend testing, see the [System Testing Guide](../../../docs/TESTING.md).

## Backend Testing Philosophy

The backend uses **Jest** with a focus on **simple, focused unit tests**:

1. **Test functions directly** - Avoid complex HTTP mocking
2. **Fast execution** - Unit tests run in milliseconds
3. **TypeScript strict mode** - All tests fully typed
4. **Pure business logic testing** - Test services, not framework code

## Running Backend Tests

### Using Semiont CLI (Recommended)

```bash
# Run all backend tests with coverage
semiont test --service backend

# Run specific test suites
semiont test --service backend --suite unit         # Unit tests only
semiont test --service backend --suite integration  # Integration tests
semiont test --service backend --suite security     # Security tests

# Watch mode for development
semiont test --service backend --suite unit --watch

# Skip coverage for faster runs
semiont test --service backend --no-coverage
```

### Direct npm Scripts

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests (excludes integration)
npm run test:integration   # Integration tests only
npm run test:api           # API endpoint tests
npm run test:security      # Security-focused tests

# Coverage and watch mode
npm run test:coverage      # Generate coverage report
npm run test:watch         # Watch mode for TDD

# Type checking
npm run type-check         # TypeScript validation
npm run build              # Full build with type check
```

## Test Organization

### Unit Tests (Jest)

```
src/__tests__/
├── auth/
│   ├── jwt.test.ts              # JWT token validation
│   └── oauth.test.ts            # OAuth service logic
├── middleware/
│   └── auth.test.ts             # Auth middleware tests
├── validation/
│   └── schemas.test.ts          # Zod schema validation
├── config/
│   ├── config.test.ts           # App configuration
│   └── env.test.ts              # Environment validation
└── db.test.ts                   # Database connection
```

### Integration Tests

```
src/__tests__/integration/
├── api-endpoints.test.ts        # Multi-service flows
└── contract-tests.test.ts       # API contract validation
```

### Security Tests

```
src/__tests__/
├── route-auth-coverage.test.ts  # Comprehensive route authentication testing
├── backend-security.test.ts     # Security requirements documentation
├── security-controls.test.ts    # CORS and security headers
└── api/
    ├── admin-endpoints.test.ts  # Admin access control
    └── documentation.test.ts    # API docs validation
```

**Key Security Tests**:

- **route-auth-coverage.test.ts** (615 lines) - **Critical comprehensive test**
  - Tests ALL registered Hono routes dynamically
  - Uses OpenAPI spec as single source of truth for public routes
  - Validates all non-public routes return 401 without authentication
  - Tests invalid tokens, malformed tokens, expired tokens
  - Auto-detects route patterns and catch-all routes
  - Provides coverage statistics (tested vs skipped routes)
  - **Prevents authentication regressions** when adding/modifying routes

## Backend Testing Patterns

### Unit Test Pattern

Test services directly without HTTP layer:

```typescript
// Good: Direct function testing
import { describe, it, expect, beforeEach } from '@jest/globals';
import { JWTService } from '../../auth/jwt';

describe('JWTService', () => {
  beforeEach(() => {
    process.env.SEMIONT_ENV = 'test';
  });

  it('should validate allowed domains', () => {
    expect(JWTService.isAllowedDomain('user@test.example.com')).toBe(true);
    expect(JWTService.isAllowedDomain('user@example.org')).toBe(true);
    expect(JWTService.isAllowedDomain('invalid@notallowed.com')).toBe(false);
  });

  it('should create valid JWT tokens', () => {
    const token = JWTService.createToken({
      sub: 'user-123',
      email: 'test@example.com',
      isAdmin: false
    });

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});
```

### Prisma Database Testing

Test database operations directly:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('User Database Operations', () => {
  it('should find users', async () => {
    const users = await prisma.user.findMany();
    expect(Array.isArray(users)).toBe(true);
  });

  it('should create user', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'test@example.com',
        name: 'Test User',
        provider: 'google',
        providerId: 'test-id'
      }
    });

    expect(user.email).toBe('test@example.com');
  });
});
```

### Zod Schema Testing

Validate all request/response schemas:

```typescript
import { CreateDocumentSchema } from '../../validation/schemas';

describe('CreateDocumentSchema', () => {
  it('should validate correct input', () => {
    const result = CreateDocumentSchema.safeParse({
      name: 'Test Document',
      content: 'Document content',
      contentType: 'text/markdown'
    });

    expect(result.success).toBe(true);
  });

  it('should reject invalid input', () => {
    const result = CreateDocumentSchema.safeParse({
      name: '',  // Invalid: empty name
      content: 'Document content'
    });

    expect(result.success).toBe(false);
  });
});
```

### Authentication Middleware Testing

Test JWT validation logic:

```typescript
import { authMiddleware } from '../../middleware/auth';

describe('Auth Middleware', () => {
  it('should reject missing token', async () => {
    const mockContext = {
      req: {
        header: () => null
      },
      json: jest.fn()
    };

    await authMiddleware(mockContext as any, jest.fn());

    expect(mockContext.json).toHaveBeenCalledWith(
      { error: 'Unauthorized' },
      401
    );
  });
});
```

## What NOT to Test

**Avoid complex mocking**:

```typescript
// ❌ BAD: Complex HTTP + OAuth mocking
// These tests are fragile and hard to maintain
describe('OAuth Flow', () => {
  it('should handle full OAuth flow', async () => {
    // Mocking HTTP requests, OAuth providers, database calls...
    // Too complex, test at integration level instead
  });
});
```

**Instead, test business logic directly**:

```typescript
// ✅ GOOD: Test the service function
describe('OAuthService', () => {
  it('should validate OAuth token', () => {
    const isValid = OAuthService.validateToken('token-data');
    expect(isValid).toBe(true);
  });
});
```

## Key Backend Test Coverage

Current focus areas:

1. **Route Authentication** - Comprehensive coverage via route-auth-coverage.test.ts
   - All routes tested for proper authentication
   - OpenAPI spec validation
   - Invalid/expired token handling
   - Auto-detects new routes (no hardcoded lists)

2. **JWT Service** - Token creation, validation, domain checking
   - HMAC SHA256 signature verification
   - Token expiration handling
   - Payload structure validation

3. **Validation Schemas** - 100% coverage of Zod schemas
   - Request body validation
   - Response schema validation
   - Error message validation

4. **Auth Middleware** - Token validation and user context
   - Bearer token extraction
   - User database lookup
   - Context injection

5. **Prisma Operations** - Database CRUD operations
6. **Environment Config** - Configuration validation

### Security Test Coverage Goals

- **Authentication**: 100% coverage (critical security) ✅
- **Route Protection**: 100% coverage via route-auth-coverage.test.ts ✅
- **Validation**: 100% coverage (all Zod schemas)
- **Business Logic**: >80% coverage
- **Integration Points**: Contract tests for all APIs

## Writing New Tests

### Add a Unit Test

1. Create test file in `src/__tests__/`:

```typescript
// src/__tests__/services/document-service.test.ts
import { describe, it, expect } from '@jest/globals';
import { DocumentService } from '../../services/document-service';

describe('DocumentService', () => {
  it('should validate document name', () => {
    const isValid = DocumentService.isValidName('My Document');
    expect(isValid).toBe(true);
  });
});
```

2. Run the test:

```bash
npm run test:unit
```

### Add an Integration Test

1. Create test in `src/__tests__/integration/`:

```typescript
// src/__tests__/integration/document-flow.test.ts
import { describe, it, expect } from '@jest/globals';

describe('Document Creation Flow', () => {
  it('should create document and update projections', async () => {
    // Test event store → projection update
  });
});
```

2. Run integration tests:

```bash
npm run test:integration
```

## Test Environment Configuration

### Jest Configuration

Backend uses Jest with TypeScript support:

```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/__tests__/**'
  ]
};
```

### Test Environment Variables

```env
# Set in tests
SEMIONT_ENV=test
JWT_SECRET=test-secret-at-least-32-characters-long
DATABASE_URL=postgresql://test:test@localhost:5432/test_db
```

## Debugging Backend Tests

### Run Single Test File

```bash
npm test -- jwt.test.ts
```

### Run Tests Matching Pattern

```bash
npm test -- --testNamePattern="JWT validation"
```

### Enable Verbose Output

```bash
npm test -- --verbose
```

### VS Code Debugging

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Jest Current File",
  "program": "${workspaceFolder}/node_modules/.bin/jest",
  "args": [
    "${fileBasename}",
    "--config=jest.config.js",
    "--runInBand"
  ],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

## Manual API Testing

Test endpoints manually during development:

```bash
# Health check
curl http://localhost:4000/api/health

# API documentation
curl http://localhost:4000/api

# Protected endpoint (requires JWT)
TOKEN="your-jwt-token"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/documents
```

## Running Security Tests

Security tests are critical and run automatically in CI/CD:

```bash
# Run all security tests
npm run test:security

# Run specific security test files
npm test route-auth-coverage.test.ts
npm test backend-security.test.ts
npm test security-controls.test.ts

# Run security tests in watch mode
npm run test:watch -- --testNamePattern=security
```

### Understanding route-auth-coverage.test.ts

This test is the **cornerstone of backend security testing**:

```typescript
// Dynamically loads OpenAPI spec
const publicRoutes = await loadPublicRoutesFromSpec();

// Gets ALL registered Hono routes
const routes = app.routes;

// Tests each route
for (const route of routes) {
  if (isPublicRoute(route.path, publicRoutes)) {
    // Skip - documented as public
    continue;
  }

  // Test without authentication - MUST return 401
  const res = await app.request(route.path, { method: route.method });
  expect(res.status).toBe(401);
}
```

**Why this matters**:
- Catches forgotten authentication middleware
- Validates OpenAPI spec matches implementation
- No hardcoded route lists (tests adapt to codebase changes)
- Prevents accidental exposure of protected endpoints

## Performance Optimization

### Fast Test Execution

- **Unit tests only**: ~500ms for full suite
- **All tests**: ~2-3 seconds
- **Watch mode**: Only re-runs changed tests

### Test Isolation

Each test should be independent:

```typescript
describe('UserService', () => {
  beforeEach(() => {
    // Reset state before each test
    jest.clearAllMocks();
  });

  it('test 1', () => {
    // Isolated test
  });

  it('test 2', () => {
    // Doesn't depend on test 1
  });
});
```

## Comparison with Frontend Testing

**Backend (Jest)**:
- Node.js environment
- Direct function testing
- Prisma database tests
- No DOM/browser APIs

**Frontend (Vitest - see [System Testing Guide](../../../docs/TESTING.md))**:
- Browser environment with jsdom
- React component testing
- MSW v2 for API mocking
- DOM interactions

## Related Documentation

- **[System Testing Guide](../../../docs/TESTING.md)** - Complete testing strategy including frontend (Vitest, MSW v2, React Testing Library)
- [Development Guide](./DEVELOPMENT.md) - Setting up test environment
- [Contributing Guide](./CONTRIBUTING.md) - Testing requirements for PRs
- [API Reference](./API.md) - API endpoints to test

## Adding Routes: Security Test Checklist

When adding new backend routes:

1. **Apply authentication middleware**:
   ```typescript
   // Add to existing protected router (automatic auth)
   router.post('/api/resources/:id/my-action', async (c) => {
     const user = c.get('user'); // Available automatically
   });

   // OR create new router with auth
   export const myRouter = new Hono<{ Variables: { user: User } }>();
   myRouter.use('/api/my-feature/*', authMiddleware);
   ```

2. **Document in OpenAPI spec**:
   ```json
   {
     "post": {
       "summary": "My action",
       "security": [{ "bearerAuth": [] }],  // Protected route
       "responses": { ... }
     }
   }
   ```

3. **Run security tests**:
   ```bash
   npm run test:security
   ```

4. **Verify coverage**:
   - route-auth-coverage.test.ts should automatically test your new route
   - Check test output for "Tested: X routes" to confirm coverage
   - If route is public, ensure it has NO `security` field in OpenAPI spec

**For admin/moderator routes**:
```typescript
router.post('/api/admin/my-action', async (c) => {
  const user = c.get('user');
  if (!user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }
  // Admin logic
});
```

---

**Last Updated**: 2026-01-21
**Scope**: Backend testing with Vitest (Node.js, TypeScript, Prisma, Security)
