# Backend Authentication Guide

Backend developer's guide to implementing and debugging authentication in the Semiont backend.

**Related Documentation:**
- **[System Authentication Architecture](../../../docs/AUTHENTICATION.md)** - **Read this first!** Complete authentication flows, diagrams, NextAuth.js + backend integration, and MCP implementation
- [Main README](../README.md) - Backend overview
- [API Reference](./API.md) - API endpoints
- [Development Guide](./DEVELOPMENT.md) - Local setup

**Scope**: This document is a practical guide for backend developers. For the complete authentication architecture, flow diagrams, and frontend integration, see the [System Authentication Architecture](../../../docs/AUTHENTICATION.md).

## Quick Reference

### Security Model

- **Router-level authentication** - Each router applies auth middleware to its routes
- **JWT Bearer token authentication** - All protected routes require valid JWT
- **OpenAPI spec as source of truth** - Public vs protected routes documented in OpenAPI spec
- **Comprehensive test coverage** - All routes tested for proper authentication in CI/CD

### Authentication Pattern

Routes are protected at the router level using Hono's `router.use()` middleware:

```typescript
// Example: Resources router protects all /api/resources/* routes
export function createResourceRouter(): ResourcesRouterType {
  const router = new Hono<{ Variables: { user: User } }>();
  router.use('/api/resources/*', authMiddleware);  // Protects entire route group
  return router;
}

// Example: Entity types router
export const entityTypesRouter = new Hono<{ Variables: { user: User } }>();
entityTypesRouter.use('/api/entity-types/*', authMiddleware);

// Example: Admin router with layered middleware
export const adminRouter = new Hono<{ Variables: { user: User } }>();
adminRouter.use('/api/admin/*', authMiddleware, adminMiddleware);
```

### Public Endpoints

These endpoints are documented in the OpenAPI spec as public (no `security` field):

- `GET /api/health` - Health check for AWS ALB/ELB monitoring
- `GET /api` - API documentation endpoint
- `POST /api/auth/google` - OAuth login initiation
- `POST /api/auth/refresh` - Refresh token exchange for MCP clients

All other routes require JWT authentication via router-level middleware.

## Adding Authentication to New Routes

### Create a New Protected Router

When creating a new router, apply auth middleware to protect all routes:

```typescript
// src/routes/my-feature.ts
import { Hono } from 'hono';
import { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';

export const myFeatureRouter = new Hono<{ Variables: { user: User } }>();

// Apply auth middleware to all routes under /api/my-feature/*
myFeatureRouter.use('/api/my-feature/*', authMiddleware);

// All routes below are now protected
myFeatureRouter.get('/api/my-feature/items', async (c) => {
  const user = c.get('user'); // User context automatically available
  const userId = user.id;
  const isAdmin = user.isAdmin;

  // Your protected logic here
  return c.json({ data: 'protected' });
});
```

### Add Routes to Protected Router

If adding routes to an existing protected router (like `resourcesRouter` or `entityTypesRouter`), they automatically inherit authentication:

```typescript
// routes/resources/routes/my-new-route.ts
import { ResourcesRouterType } from '../shared';

export function registerMyNewRoute(router: ResourcesRouterType) {
  // This route is AUTOMATICALLY protected by router.use() in shared.ts
  router.post('/api/resources/:id/my-action', async (c) => {
    const user = c.get('user'); // User available automatically
    // Your logic here
  });
}
```

### Making a Route Public

To make a route public, either:

1. **Create a separate router without auth middleware** (for grouped public routes)
2. **Update OpenAPI spec** to mark route as public (no `security` field)

```typescript
// Example: Public routes router (no auth middleware)
export const publicRouter = new Hono();

// These routes are public
publicRouter.get('/api/health', async (c) => {
  return c.json({ status: 'healthy' });
});

publicRouter.get('/api', async (c) => {
  return c.json({ version: '1.0.0' });
});
```

**IMPORTANT**: Mark public routes in OpenAPI spec:

```json
// specs/src/paths/health.json
{
  "get": {
    "summary": "Health check",
    "responses": { ... }
    // No "security" field = public route
  }
}
```

### Admin-Only Routes

For admin-only endpoints, use layered middleware or check the `isAdmin` flag:

```typescript
// Method 1: Layered middleware (recommended for admin routers)
const adminMiddleware = async (c: any, next: any) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }
  return next();
};

adminRouter.use('/api/admin/*', authMiddleware, adminMiddleware);

// Method 2: Check flag in handler (for individual admin routes)
router.delete('/api/users/:id', async (c) => {
  const user = c.get('user');

  if (!user.isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Admin logic here
  await deleteUser(c.req.param('id'));
  return c.json({ success: true });
});
```

## Backend Authentication Flow

### 1. Token Reception

```bash
# Client sends JWT in Authorization header
curl -H "Authorization: Bearer eyJhbGc..." \
  http://localhost:4000/api/documents
```

### 2. Automatic Validation

The auth middleware automatically:
- Extracts token from Authorization header
- Verifies JWT signature
- Checks token expiration
- Validates user exists in database
- Attaches user to request context

### 3. Route Access

```typescript
// User context available in all protected routes
app.get('/api/documents', async (c) => {
  const user = c.get('user');
  // user.sub - User ID
  // user.email - User email
  // user.isAdmin - Admin flag
});
```

## MCP Authentication Endpoints

Special backend endpoints for Model Context Protocol clients. For complete MCP flow, see [System Authentication](../../../docs/AUTHENTICATION.md#mcp-authentication).

### `POST /api/auth/mcp-generate-token`

Generate a 30-day refresh token for MCP clients.

- **Auth**: Requires valid JWT access token
- **Called by**: Frontend's `/auth/mcp-setup` endpoint
- **Returns**: `{ refreshToken: string, expiresIn: number }`

### `POST /api/auth/refresh`

Exchange refresh token for new access token.

- **Auth**: Accepts refresh token in body
- **Used by**: MCP clients every hour
- **Returns**: `{ accessToken: string, expiresIn: number }`

### MCP Backend Usage Example

```typescript
// MCP client exchanges refresh token
const response = await fetch('https://api.semiont.com/api/auth/refresh', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken })
});

const { accessToken } = await response.json();

// Use access token for API requests
const documents = await fetch('https://api.semiont.com/api/documents', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
```

## JWT Token Structure

### Access Token (7-day expiration)

```json
{
  "sub": "user-123",
  "email": "user@example.com",
  "isAdmin": false,
  "iat": 1698765432,
  "exp": 1699370232
}
```

### Refresh Token (30-day expiration, MCP only)

```json
{
  "sub": "user-123",
  "type": "refresh",
  "iat": 1698765432,
  "exp": 1701357432
}
```

## Security Implementation

### JWT Validation Layers

The backend validates tokens through multiple layers:

1. **Signature verification** - HMAC SHA256
2. **Payload structure** - Zod schema validation
3. **Expiration checking** - Token not expired
4. **User verification** - User exists and active in database
5. **Domain validation** - Email domain allowed

### Security Features

- **Router-level protection** - Routes protected via router.use() middleware
- **Comprehensive test coverage** - route-auth-coverage.test.ts validates all routes
- **Environment validation** - JWT_SECRET must be 32+ characters
- **Request validation** - All inputs validated with Zod schemas
- **SQL injection prevention** - Prisma ORM with parameterized queries
- **CORS configuration** - Frontend domain whitelist
- **Domain restrictions** - OAuth limited to allowed domains

### Security Test Coverage

The backend includes comprehensive authentication testing via [route-auth-coverage.test.ts](../src/__tests__/route-auth-coverage.test.ts):

- **Dynamic route testing** - Tests ALL registered Hono routes automatically
- **OpenAPI spec validation** - Uses OpenAPI as single source of truth for public routes
- **401 validation** - Verifies all non-public routes return 401 without auth
- **Token validation** - Tests invalid tokens, malformed tokens, expired tokens
- **Auto-detection** - Automatically detects catch-all routes and route patterns
- **Coverage reporting** - Provides statistics on tested vs skipped routes
- **CI/CD integration** - Runs via `npm run test:security` in GitHub Actions

This test ensures no authentication regressions occur when adding or modifying routes.

## Debugging Authentication Issues

### Common Backend Issues

**"Unauthorized" Error (401)**:

```bash
# Check JWT secret matches
echo $JWT_SECRET | wc -c  # Must be 32+ characters

# Test token manually
node -e "console.log(require('jsonwebtoken').verify('TOKEN', process.env.JWT_SECRET))"
```

**"Forbidden" Error (403)**:

```typescript
// Check admin flag
app.get('/api/debug-user', async (c) => {
  const user = c.get('user');
  return c.json({ user });
});
```

**Token Validation Fails**:

```env
# Enable debug logging in .env
DEBUG=hono:*
LOG_LEVEL=debug
```

**MCP Token Exchange Fails**:

- Check refresh token hasn't expired (30 days)
- Verify `/api/auth/refresh` endpoint is accessible
- Ensure refresh token is correctly transmitted in body

### Backend Debugging Tools

**1. Log Authentication Attempts**:

```typescript
// In auth middleware
console.log('Auth attempt:', {
  hasHeader: !!authHeader,
  tokenLength: token?.length,
  userId: payload?.sub
});
```

**2. Verify JWT Secret**:

```bash
# In development
echo "JWT_SECRET length: $(echo -n $JWT_SECRET | wc -c)"
```

**3. Check User Context**:

```typescript
// Add debug endpoint
app.get('/api/debug/whoami', async (c) => {
  const user = c.get('user');
  return c.json({
    authenticated: !!user,
    userId: user?.sub,
    email: user?.email,
    isAdmin: user?.isAdmin
  });
});
```

## Implementation Reference

For complete implementation details including:
- Frontend NextAuth.js configuration
- Complete authentication flow diagrams
- OAuth provider setup
- Environment variable configuration
- Security best practices

See [System Authentication Architecture](../../../docs/AUTHENTICATION.md).

## Related Documentation

- **[System Authentication Architecture](../../../docs/AUTHENTICATION.md)** - Complete auth flows and implementation
- [API Reference](./API.md) - Authentication endpoint details
- [Development Guide](./DEVELOPMENT.md) - Setting up OAuth credentials locally
- [Testing Guide](./TESTING.md) - Testing authenticated endpoints

## Architecture Summary

**Current Implementation (Since August 2025)**:
- Router-level authentication via `router.use()`
- No global authentication middleware
- No PUBLIC_ENDPOINTS array
- OpenAPI spec defines public vs protected routes
- Comprehensive test coverage via route-auth-coverage.test.ts

**Implementation Files**:
- [src/middleware/auth.ts](../src/middleware/auth.ts) - JWT validation middleware
- [src/routes/resources/shared.ts](../src/routes/resources/shared.ts) - Resources router with auth
- [src/routes/entity-types.ts](../src/routes/entity-types.ts) - Entity types router with auth
- [src/routes/admin.ts](../src/routes/admin.ts) - Admin router with layered auth
- [src/__tests__/route-auth-coverage.test.ts](../src/__tests__/route-auth-coverage.test.ts) - Comprehensive security tests

---

**Last Updated**: 2026-01-21
**Scope**: Backend authentication implementation and debugging
