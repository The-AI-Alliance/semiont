# Gateway Authentication Guide

Gateway developer's guide to implementing and debugging authentication in the Semiont gateway.

**Related Documentation:**
- **[System Authentication Architecture](../../../docs/system/administration/AUTHENTICATION.md)** - **Read this first!** The complete bearer-only authentication model, flows, and diagrams
- [Main README](../README.md) - Gateway overview
- [Semiont Protocol](../../../docs/protocol/README.md) - The eight verbs and the bus
- [Development Guide](./DEVELOPMENT.md) - Local setup

**Scope**: This document is a practical guide for gateway developers. For the complete authentication architecture and flow diagrams, see the [System Authentication Architecture](../../../docs/system/administration/AUTHENTICATION.md).

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

```

### Public Endpoints

These endpoints are documented in the OpenAPI spec as public (no `security` field):

- `GET /api/health` - Health check for load balancer monitoring
- `GET /.well-known/oauth-protected-resource` - Which issuer this gateway trusts (RFC 9728)
- `POST /api/tokens/agent` - Software-agent token exchange (the shared worker secret is the credential)

All other routes require JWT authentication via router-level middleware.

## Adding Authentication to New Routes

### Create a New Protected Router

When creating a new router, apply auth middleware to protect all routes:

```typescript
// src/routes/my-feature.ts
import { Hono } from 'hono';
import type { Principal } from '../identity/principal';
import { authMiddleware } from '../middleware/auth';

export const myFeatureRouter = new Hono<{ Variables: { principal: Principal } }>();

// Apply auth middleware to all routes under /api/my-feature/*
myFeatureRouter.use('/api/my-feature/*', authMiddleware);

// All routes below are now protected
myFeatureRouter.get('/api/my-feature/items', async (c) => {
  const principal = c.get('principal'); // derived from the token's own claims
  const who = principal.did;            // did:web:<domain>:users:<email>

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
    const principal = c.get('principal'); // available automatically
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

### Role Gates

The gateway has exactly one authorization gate: `authMiddleware`, which answers
401 or admits the request. Nothing in the gateway reads a role to decide access,
and no route returns 403.

The principal carries no role flags at all. It is derived from the token's own
claims — DID, email, name, image, domain — and nothing more, so there is no
admission opinion for the gateway to hold and none to leak into a response.
Accounts are administered at the knowledge base's identity provider, and a
token's lifetime is the revocation window: disabling an account there stops the
issuer minting and refreshing, and a token already issued works until it expires.

## Gateway Authentication Flow

### 1. Token Reception

```bash
# Client sends JWT in Authorization header
curl -H "Authorization: Bearer eyJhbGc..." \
  http://localhost:4000/api/documents
```

### 2. Automatic Validation

The auth middleware automatically:
- Extracts the token from the `Authorization: Bearer` header (or the `?token=` media token on `GET /api/resources/:id`)
- Dispatches on the token's `iss`: a token from the trusted issuer is verified
  against that issuer's published keys (JWKS), issuer and audience checked; a
  gateway-minted agent token is verified against the gateway's own key ring
- Checks token expiration
- Builds the principal from the verified claims — no lookup, because there is
  no directory here to look in
- Attaches the principal to the request context

### 3. Route Access

```typescript
// Principal available in all protected routes
app.get('/api/documents', async (c) => {
  const principal = c.get('principal');
  // principal.did    - who this is, and what their events are attributed to
  // principal.email  - from the token's claims
  // principal.domain - the email's domain for a person; the deployment's for an agent
});
```

## Token & Session Endpoints

People sign in at the trusted issuer and refresh there; the gateway mints only the
tokens below. Align behavior to the canonical
[System Authentication](../../../docs/system/administration/AUTHENTICATION.md).

### `POST /api/tokens/media`

Mint a short-lived, resource-scoped **media token** for header-less fetches
(`<img>`, `<iframe>`, PDF.js) that can't send an `Authorization` header.

- **Auth**: Requires a valid access token
- **Body**: `{ resourceId: string }`
- **Returns**: `{ token: string }` — a 5-minute token scoped to that one resource,
  presented as `GET /api/resources/:id?token=…` and verified by the auth
  middleware's media path

### Signing out

The gateway has no logout endpoint, because it never issued the session. A client
signs out by forgetting its stored session and revoking the refresh token at the
issuer (RFC 7009), which is what stops a new access token from being minted. The
access token already in hand stays valid until it expires, minutes later. Nothing
server-side has to be consulted per request to make that true, which is what lets
the gateway run N replicas without a shared revocation table.

> **MCP clients.** The previous browser-mediated MCP token-provisioning flow has been
> **removed**. Today `packages/mcp-server` runs single-gateway with a **static**
> `SEMIONT_ACCESS_TOKEN` (from env) that does **not** refresh — so it stops working
> once the access token expires. A refreshing provisioning flow is being rebuilt;
> this guide will document it once it lands.

## JWT Token Structure

A person's token is the issuer's: its claims are the issuer's, and the gateway
reads `sub`, `email`, `email_verified`, and `name` from it. A gateway-minted
token carries the claim set validated by `JWTPayloadSchema` in
[src/types/jwt-types.ts](../src/types/jwt-types.ts) and, for a software agent,
its `agentDid`.

### Agent Token

```json
{
  "did": "did:web:example.github.io:my-kb:agents:anthropic:claude-sonnet-5",
  "email": "anthropic-claude-sonnet-5@agents.example.github.io",
  "name": "anthropic claude-sonnet-5",
  "domain": "example.github.io:my-kb",
  "iss": "semiont-gateway",
  "iat": 1698765432,
  "exp": 1698769032
}
```

The DID is the whole identity: there is no row id beside it, and no role flag.
The lifetime IS the revocation window — an hour — because no account exists
anywhere to disable. That is the price of agents having no issuer accounts, and
it is why the exchange is the gateway's only minting surface.

## Security Implementation

### JWT Validation Layers

The gateway validates tokens through these layers:

1. **Signature verification** - RS256 against the issuer's published keys (JWKS)
   for a token from the trusted issuer; HMAC SHA256 against the gateway's own
   key ring for an agent token it minted itself
2. **Issuer and audience** - `iss` names the trusted issuer, `aud` carries this
   knowledge base's derived resource identity
3. **Payload structure** - Zod schema validation
4. **Expiration checking** - Token not expired

There is no fifth layer. Verification once ended with a database lookup that
confirmed the account existed and was active, and with an email-domain
allowlist; both are gone. Admission belongs to the issuer, so a token the
issuer signed and has not expired is admitted.

### Security Features

- **Router-level protection** - Routes protected via router.use() middleware
- **Comprehensive test coverage** - route-spec-coverage.test.ts validates all routes
- **Environment validation** - each key in JWT_SECRET must be 32+ characters (it may be a comma-separated rotation ring)
- **Request validation** - All inputs validated with Zod schemas
- **SQL injection prevention** - not applicable; the gateway issues no SQL and holds no database
- **CORS** - open (`origin: '*'`, no credentials); safe because auth is bearer-only, not cookie-based
- **Domain restrictions** - OAuth limited to allowed domains

### Security Test Coverage

The gateway includes comprehensive route-level authentication test coverage:

- **Dynamic route testing** - Tests ALL registered Hono routes automatically
- **OpenAPI spec validation** - Uses OpenAPI as single source of truth for public routes
- **401 validation** - Verifies all non-public routes return 401 without auth
- **Token validation** - Tests invalid tokens, malformed tokens, expired tokens
- **Auto-detection** - Automatically detects catch-all routes and route patterns
- **Coverage reporting** - Provides statistics on tested vs skipped routes
- **CI/CD integration** - Runs via `npm run test:security` in GitHub Actions

This test ensures no authentication regressions occur when adding or modifying routes.

## Debugging Authentication Issues

### Common Gateway Issues

**"Unauthorized" Error (401)**:

```bash
# JWT_SECRET is an ordered, comma-separated KEY RING: the first key signs,
# every key verifies. Check each key's length, not the joined string.
echo "$JWT_SECRET" | tr ',' '\n' | awk '{ print NR": "length($0)" chars" }'  # each must be 32+

# Test a token manually against every key in the ring (prints the payload
# from whichever one accepts it).
node -e '
  const jwt = require("jsonwebtoken");
  const token = process.argv[1];
  for (const secret of process.env.JWT_SECRET.split(",").map(s => s.trim())) {
    try { console.log(jwt.verify(token, secret)); process.exit(0); } catch {}
  }
  console.error("no key in JWT_SECRET verifies this token");
  process.exit(1);
' "TOKEN"
```

Verifying against `process.env.JWT_SECRET` directly only works when the ring holds a
single key — with a rotation in progress it passes the whole comma-joined string as one
secret and always fails. See
[Rotating `JWT_SECRET`](../../../docs/system/administration/AUTHENTICATION.md#rotating-jwt_secret-without-signing-everyone-out)
for the rotation procedure.

**Unexpected 401**:

No route answers 403 — the gateway reads no role to decide access, so a refusal
is always a failure to authenticate. Inspect the resolved principal:

```typescript
app.get('/api/debug-principal', async (c) => {
  const principal = c.get('principal');
  return c.json({ principal });
});
```

**Token Validation Fails**:

```env
# Enable debug logging in .env
DEBUG=hono:*
LOG_LEVEL=debug
```

**Issuer Token Rejected**:

- The token's `iss` must equal the configured identity `issuer` exactly (scheme, host, port, path)
- The token's `aud` must carry the configured `audience`
- The issuer's JWKS must be reachable from the gateway; a signing key the gateway has not seen triggers one re-fetch

### Gateway Debugging Tools

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
# In development — per key, since JWT_SECRET may be a rotation ring
echo "$JWT_SECRET" | tr ',' '\n' | awk '{ print "key "NR": "length($0)" chars" }'
```

**3. Check User Context**:

```typescript
// Add debug endpoint
app.get('/api/debug/whoami', async (c) => {
  const principal = c.get('principal');
  return c.json({
    authenticated: !!principal,
    did: principal?.did,
    email: principal?.email,
    domain: principal?.domain
  });
});
```

## Implementation Reference

For complete implementation details including:
- Complete authentication flow diagrams
- OAuth provider setup
- Environment variable configuration
- Security best practices

See [System Authentication Architecture](../../../docs/system/administration/AUTHENTICATION.md).

## Related Documentation

- **[System Authentication Architecture](../../../docs/system/administration/AUTHENTICATION.md)** - Complete auth flows and implementation
- [@semiont/http-transport Reference](../../../packages/http-transport/docs/API-Reference.md) - How clients carry the bearer token and refresh it
- [Development Guide](./DEVELOPMENT.md) - Setting up OAuth credentials locally
- [Testing Guide](./TESTING.md) - Testing authenticated endpoints

## Architecture Summary

**Current Implementation (Since August 2025)**:
- Router-level authentication via `router.use()`
- No global authentication middleware
- No PUBLIC_ENDPOINTS array
- OpenAPI spec defines public vs protected routes
- Comprehensive test coverage via route-spec-coverage.test.ts

**Implementation Files**:
- [src/middleware/auth.ts](../src/middleware/auth.ts) - JWT validation middleware
- [src/routes/resources/shared.ts](../src/routes/resources/shared.ts) - Resources router with auth

---

**Last Updated**: 2026-06-20
**Scope**: Gateway authentication implementation and debugging
