# Backend Testing Guide

Backend testing guide focused on Vitest, HTTP contract testing, and backend-specific testing strategies.

**Related Documentation:**
- **[System Testing Guide](../../../docs/TESTING.md)** - **Read this first!** Complete testing strategy including Vitest, MSW v2, frontend testing, and test orchestration
- [Main README](../README.md) - Backend overview
- [Development Guide](./DEVELOPMENT.md) - Local development setup
- [Contributing Guide](./CONTRIBUTING.md) - Code style and patterns

**Scope**: This document covers backend-specific testing using Vitest, HTTP contract testing, and API endpoint validation. For system-wide testing including frontend testing, see the [System Testing Guide](../../../docs/TESTING.md).

## Backend Testing Philosophy

The backend uses **Vitest** with a focus on **HTTP contract testing**:

1. **Test the HTTP layer** - Status codes, headers, authentication, request/response validation
2. **Delegate business logic** - Subsystem logic tested in package tests (`@semiont/make-meaning`, `@semiont/event-sourcing`, etc.)
3. **Fast execution** - HTTP contract tests run in milliseconds with mocked subsystems
4. **TypeScript strict mode** - All tests fully typed
5. **Mock make-meaning** - Backend tests focus on HTTP exposure, not event-sourcing internals

## Test Organization

### HTTP Contract Tests (apps/backend/src/__tests__/routes/)

Tests focus on HTTP layer only - status codes, authentication, response structure:

```
src/__tests__/routes/
├── resources-crud.test.ts              # POST/GET/PATCH resources
├── annotations-crud.test.ts            # GET/PUT/DELETE annotations
├── resource-discovery.test.ts          # referenced-by, llm-context
└── detect-annotations-stream.test.ts   # Detection stream endpoints
```

**Pattern**: Test HTTP contract, mock `@semiont/make-meaning`:

```typescript
// Mock make-meaning subsystems
vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue({
      '@id': 'urn:semiont:resource:test',
      name: 'Test Resource',
    }),
  },
  startMakeMeaning: vi.fn().mockResolvedValue({
    eventStore: { append: vi.fn() },
    repStore: { store: vi.fn() },
    jobQueue: { createJob: vi.fn() },
    workers: [],
    graphConsumer: {}
  })
}));

// Test HTTP contract only
describe('POST /resources', () => {
  it('should return 201 with Location header', async () => {
    const response = await app.request('/resources', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Test', format: 'text/plain' }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toMatch(/^urn:semiont:resource:/);
  });

  it('should return 401 without authentication', async () => {
    const response = await app.request('/resources', {
      method: 'POST',
      body: JSON.stringify({ content: 'Test', format: 'text/plain' }),
    });

    expect(response.status).toBe(401);
  });
});
```

### Security Tests

```
src/__tests__/
├── route-auth-coverage.test.ts  # Comprehensive route authentication testing
├── backend-security.test.ts     # Security requirements documentation
└── security-controls.test.ts    # CORS and security headers
```

**Key Security Tests**:

- **route-auth-coverage.test.ts** - **Critical comprehensive test**
  - Tests ALL registered Hono routes dynamically
  - Uses OpenAPI spec as single source of truth for public routes
  - Validates all non-public routes return 401 without authentication
  - Tests invalid tokens, malformed tokens, expired tokens
  - Auto-detects route patterns and catch-all routes
  - **Prevents authentication regressions** when adding/modifying routes

### Subsystem Tests (packages/*/src/__tests__/)

Business logic tests belong in package tests, not backend:

```
packages/make-meaning/src/__tests__/
├── detection/
│   ├── entity-extractor.test.ts       # Entity detection algorithms
│   └── entity-extractor-charset.test.ts
├── generation/
│   └── resource-generation.test.ts    # Resource generation logic
├── jobs/
│   ├── assessment-detection-worker.test.ts
│   ├── comment-detection-worker.test.ts
│   ├── highlight-detection-worker.test.ts
│   └── tag-detection-worker.test.ts
└── graph/
    └── consumer.test.ts                # Graph database consumer

packages/event-sourcing/src/__tests__/
└── view-materializer.test.ts           # Event projection logic
```

**Pattern**: Test business logic directly, no HTTP layer:

```typescript
// Test business logic in packages
describe('EntityExtractor', () => {
  it('should extract entity references from text', () => {
    const text = 'The AI Alliance is a global consortium.';
    const entities = extractEntities(text);

    expect(entities).toContainEqual({
      type: 'Organization',
      text: 'The AI Alliance',
      startOffset: 0,
      endOffset: 16
    });
  });
});
```

## Running Backend Tests

### Using npm Scripts

```bash
# Run all backend tests
npm test

# Run specific test files
npm test -- src/__tests__/routes/resources-crud.test.ts

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage

# Type checking
npm run typecheck
```

## What to Test Where

### ✅ Backend HTTP Contract Tests (apps/backend/src/__tests__/routes/)

Test HTTP exposure:

```typescript
// ✅ GOOD: HTTP contract test
it('should return 404 for non-existent resource', async () => {
  const { ResourceContext } = await import('@semiont/make-meaning');
  vi.mocked(ResourceContext.getResourceMetadata).mockResolvedValueOnce(null);

  const response = await app.request('/resources/nonexistent', {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });

  expect(response.status).toBe(404);
});

it('should return 401 without authentication', async () => {
  const response = await app.request('/resources/test', {
    method: 'PATCH',
    body: JSON.stringify({ archived: true })
  });

  expect(response.status).toBe(401);
});

it('should return 400 for invalid content type', async () => {
  const response = await app.request('/resources', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}` },
    body: JSON.stringify({
      content: 'Test',
      format: 'invalid/mime-type'
    })
  });

  expect(response.status).toBe(400);
});
```

### ✅ Package Subsystem Tests (packages/*/src/__tests__/)

Test business logic:

```typescript
// ✅ GOOD: Subsystem logic test (in packages/make-meaning)
it('should materialize view from resource.created event', async () => {
  const event: ResourceCreatedEvent = {
    type: 'resource.created',
    resourceId: resourceId('test-resource'),
    userId: userId('user-123'),
    version: 1,
    payload: {
      name: 'Test Resource',
      format: 'text/plain',
      checksum: 'abc123'
    }
  };

  const view = await materializer.apply(null, event);

  expect(view).toEqual({
    '@id': 'urn:semiont:resource:test-resource',
    name: 'Test Resource',
    representations: [{
      mediaType: 'text/plain',
      checksum: 'abc123',
      rel: 'original'
    }]
  });
});
```

### ❌ What NOT to Test

```typescript
// ❌ BAD: Testing business logic in backend tests
// This belongs in packages/make-meaning tests
describe('POST /resources', () => {
  it('should extract entities from content', async () => {
    // Testing entity extraction algorithm - WRONG PLACE!
  });

  it('should materialize view correctly', async () => {
    // Testing event-sourcing logic - WRONG PLACE!
  });
});

// ❌ BAD: Integration tests between subsystems
// Backend tests should mock subsystems
describe('Resource Creation Flow', () => {
  it('should create resource and update graph database', async () => {
    // Testing subsystem integration - WRONG PLACE!
    // Use package tests or E2E tests instead
  });
});
```

## Current Test Coverage

### HTTP Contract Tests (apps/backend)

1. **resources-crud.test.ts** (12 tests)
   - POST /resources (create) - 201, 401, 400 validation
   - GET /resources (list) - 200, 401, pagination, filtering
   - PATCH /resources/:id (update) - 200, 404, 401, archiving

2. **annotations-crud.test.ts** (15 tests)
   - GET /resources/:id/annotations (list) - 200, 401, W3C format
   - PUT /resources/:resourceId/annotations/:annotationId/body - 200, 404, 401
   - DELETE /resources/:resourceId/annotations/:annotationId - 204, 404, 401

3. **resource-discovery.test.ts** (6 tests)
   - GET /resources/:id/referenced-by - 200, 404, 401, filtering
   - POST /resources/:id/llm-context - 200, 404, 401

4. **detect-annotations-stream.test.ts** (existing)
   - POST /resources/:id/detect-*-stream endpoints

### Security Tests

- **route-auth-coverage.test.ts** - Comprehensive authentication coverage
- All routes tested for 401 without authentication
- OpenAPI spec validation

### Subsystem Tests (packages)

- **packages/make-meaning** - 456 tests (detection, generation, jobs, graph)
- **packages/event-sourcing** - 225 tests (view materialization, projections)
- **packages/content** - Content processing tests

## Writing New HTTP Contract Tests

### 1. Create Test File

```typescript
// src/__tests__/routes/my-feature.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { userId, email } from '@semiont/api-client';
import { JWTService } from '../../auth/jwt';
import type { Hono } from 'hono';
import type { EnvironmentConfig } from '@semiont/core';

// Mock subsystems
vi.mock('@semiont/make-meaning', () => ({
  ResourceContext: {
    getResourceMetadata: vi.fn().mockResolvedValue({ /* ... */ })
  },
  startMakeMeaning: vi.fn().mockResolvedValue({ /* ... */ })
}));

vi.mock('../../db', () => ({ /* ... */ }));
vi.mock('../../auth/oauth', () => ({ /* ... */ }));

describe('My Feature HTTP Contract', () => {
  let app: Hono;
  let authToken: string;

  beforeAll(async () => {
    // Initialize JWTService
    const mockConfig: EnvironmentConfig = { /* ... */ };
    JWTService.initialize(mockConfig);

    authToken = JWTService.generateToken({ /* ... */ });

    // Mock database and OAuth
    // ...

    // Import app after mocks
    const { app: importedApp } = await import('../../index');
    app = importedApp;
  });

  describe('POST /my-endpoint', () => {
    it('should return 200 on success', async () => {
      const response = await app.request('/my-endpoint', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ /* ... */ }),
      });

      expect(response.status).toBe(200);
    });

    it('should return 401 without authentication', async () => {
      const response = await app.request('/my-endpoint', {
        method: 'POST',
        body: JSON.stringify({ /* ... */ }),
      });

      expect(response.status).toBe(401);
    });

    it('should return 400 for invalid input', async () => {
      const response = await app.request('/my-endpoint', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ /* invalid data */ }),
      });

      expect(response.status).toBe(400);
    });
  });
});
```

### 2. Follow HTTP Contract Testing Principles

**DO test**:
- ✅ HTTP status codes (200, 201, 204, 400, 401, 404, 500)
- ✅ Authentication enforcement (401 without token)
- ✅ Response structure (JSON shape, required fields)
- ✅ Content-Type headers
- ✅ Location headers (for resource creation)
- ✅ Request validation (400 for invalid input)

**DON'T test**:
- ❌ Business logic algorithms
- ❌ Event-sourcing mechanics
- ❌ Database queries
- ❌ Worker behavior
- ❌ Graph database operations

### 3. Run Tests

```bash
npm test -- src/__tests__/routes/my-feature.test.ts
```

## Key Implementation Details

### Archive Pattern (No DELETE Route)

Resources are archived via PATCH, not DELETE:

```typescript
// ✅ Archive via PATCH
PATCH /resources/:id
Body: { archived: true }
Response: 200 with updated resource

// ❌ NO DELETE route
// DELETE /resources/:id is NOT implemented
// Archive is a state change, not deletion (event sourcing)
```

**Why PATCH instead of DELETE**:
1. Event-sourcing pattern (preserve audit trail)
2. Reversible operation (can unarchive)
3. UI uses PATCH for Archive button
4. More RESTful for soft-delete semantics

**Frontend implementation**: [apps/frontend/src/app/[locale]/know/resource/[id]/page.tsx:222-236](../../../apps/frontend/src/app/[locale]/know/resource/[id]/page.tsx#L222-L236)

```typescript
const handleArchive = useCallback(async () => {
  await updateDocMutation.mutateAsync({
    rUri,
    data: { archived: true }  // PATCH, not DELETE
  });
  await refetchDocument();
  showSuccess('Document archived');
}, [resource, rUri, updateDocMutation, refetchDocument, showSuccess, showError]);
```

**Backend implementation**: [apps/backend/src/routes/resources/routes/update.ts:50-60](../routes/resources/routes/update.ts#L50-L60)

```typescript
if (body.archived !== undefined && body.archived !== doc.archived) {
  if (body.archived) {
    await eventStore.appendEvent({
      type: 'resource.archived',
      resourceId: resourceId(id),
      userId: userId(user.id),
      version: 1,
      payload: { reason: undefined },
    });
  }
}
```

## Running Security Tests

Security tests are critical and run automatically in CI/CD:

```bash
# Run all security tests
npm test -- src/__tests__/route-auth-coverage.test.ts
npm test -- src/__tests__/backend-security.test.ts
npm test -- src/__tests__/security-controls.test.ts

# Watch mode
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
    continue; // Skip - documented as public
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

## Adding Routes: Security Test Checklist

When adding new backend routes:

1. **Apply authentication middleware**:
   ```typescript
   // Routes registered on authenticated router automatically protected
   router.post('/resources/:id/my-action', async (c) => {
     const user = c.get('user'); // Available automatically
   });
   ```

2. **Document in OpenAPI spec**:
   ```json
   {
     "post": {
       "summary": "My action",
       "security": [{ "bearerAuth": [] }],
       "responses": { "200": { ... } }
     }
   }
   ```

3. **Add HTTP contract tests**:
   ```typescript
   describe('POST /resources/:id/my-action', () => {
     it('should return 200 on success', async () => { /* ... */ });
     it('should return 401 without authentication', async () => { /* ... */ });
     it('should return 404 for non-existent resource', async () => { /* ... */ });
   });
   ```

4. **Run security tests**:
   ```bash
   npm test -- route-auth-coverage.test.ts
   ```

**For admin/moderator routes**:
```typescript
router.post('/admin/my-action', async (c) => {
  const user = c.get('user');
  if (!user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }
  // Admin logic
});
```

## Debugging Tests

### Run Single Test File

```bash
npm test -- resources-crud.test.ts
```

### Run Tests Matching Pattern

```bash
npm test -- --testNamePattern="should return 401"
```

### Enable Verbose Output

```bash
npm test -- --reporter=verbose
```

### Watch Mode for TDD

```bash
npm run test:watch
```

## Related Documentation

- **[System Testing Guide](../../../docs/TESTING.md)** - Complete testing strategy including frontend (Vitest, MSW v2, React Testing Library)
- **[TEST-BACKEND.md](../../../TEST-BACKEND.md)** - Backend testing reorganization plan
- [Development Guide](./DEVELOPMENT.md) - Setting up test environment
- [Contributing Guide](./CONTRIBUTING.md) - Testing requirements for PRs
- [API Reference](./API.md) - API endpoints to test

---

**Last Updated**: 2026-01-30
**Scope**: Backend HTTP contract testing with Vitest (Node.js, TypeScript, Security)
**Test Framework**: Vitest (not Jest)
**Testing Pattern**: HTTP contract tests (backend) + business logic tests (packages)
