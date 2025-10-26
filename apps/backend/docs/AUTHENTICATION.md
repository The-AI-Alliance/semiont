# Backend Authentication Guide

Backend developer's guide to implementing and debugging authentication in the Semiont backend.

**Related Documentation:**
- **[System Authentication Architecture](../../../docs/AUTHENTICATION.md)** - **Read this first!** Complete authentication flows, diagrams, NextAuth.js + backend integration, and MCP implementation
- [Main README](../README.md) - Backend overview
- [API Reference](./API.md) - API endpoints
- [Development Guide](./DEVELOPMENT.md) - Local setup

**Scope**: This document is a practical guide for backend developers. For the complete authentication architecture, flow diagrams, and frontend integration, see the [System Authentication Architecture](../../../docs/AUTHENTICATION.md).

## Quick Reference

### Default Security Model

- **All API routes require authentication by default**
- **Explicit list for public endpoints**
- **JWT Bearer token authentication**
- **Automatic middleware** - no need to manually add auth to routes

### Public Endpoints

Only these endpoints are accessible without authentication:

- `GET /api/health` - Health check for AWS ALB/ELB monitoring
- `GET /api` - API documentation endpoint
- `POST /api/auth/google` - OAuth login initiation

All other routes automatically require JWT authentication.

## Adding Authentication to New Routes

**All routes are automatically protected!** No need to add `authMiddleware` manually.

```typescript
// This route is AUTOMATICALLY protected
app.get('/api/my-new-endpoint', async (c) => {
  const user = c.get('user'); // User context automatically available
  const userId = user.sub;
  const isAdmin = user.isAdmin;

  // Your protected logic here
  return c.json({ data: 'protected' });
});
```

### Making a Route Public

Only add routes to `PUBLIC_ENDPOINTS` if they truly need to be public:

```typescript
// In src/index.ts
const PUBLIC_ENDPOINTS = [
  '/api/health',
  '/api/auth/google',
  '/api',
  // '/api/my-public-endpoint',  // Add public endpoints here
];
```

### Admin-Only Routes

For admin-only endpoints, check the `isAdmin` flag:

```typescript
app.delete('/api/users/:id', async (c) => {
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

- **Automatic protection** - All routes protected by default
- **Environment validation** - JWT_SECRET must be 32+ characters
- **Request validation** - All inputs validated with Zod schemas
- **SQL injection prevention** - Prisma ORM with parameterized queries
- **CORS configuration** - Frontend domain whitelist
- **Domain restrictions** - OAuth limited to allowed domains

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

---

**Last Updated**: 2025-10-23
**Scope**: Backend authentication implementation and debugging
