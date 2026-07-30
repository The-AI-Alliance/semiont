# Authentication Architecture

Semiont uses **bearer-only** authentication: every request authenticates with an `Authorization: Bearer` JWT (or, for media, a short-lived `?token=`). There are **no session cookies** — the backend carries no ambient credentials, which is what lets CORS be fully open (`*`) and a KB be hosted on the public internet.

**Related Documentation:**
- [Architecture Overview](../README.md) - Overall application architecture
- [Security](./SECURITY.md) - CORS posture, secret management, hardening checklist
- [Secrets](../services/SECRETS.md) - how secrets reach services
- [Configuration Guide](./CONFIGURATION.md) - Environment and secret management

## Overview

Three pieces make up the auth system:

1. **Sign-in** — the browser SPA (Vite + React) or any SDK consumer exchanges credentials (password or Google OAuth) for a JWT, returned **in the response body**. There is no auth server in front of the API and no NextAuth — the SPA is a pure client.
2. **Bearer validation** — the backend validates the JWT on every protected request (router-level `authMiddleware`), loading the user from the database.
3. **Revocable sessions** — a per-user revocation epoch (`User.tokenVersion`) makes **logout server-side, immediate, and all-devices**.

## Authentication Flow Diagram

```mermaid
graph TB
    subgraph "Client (SPA / SDK / CLI)"
        App[App holds token in memory]
    end

    subgraph "OAuth Provider"
        Google[Google OAuth 2.0]
    end

    subgraph "Backend API"
        TokenGen[Token endpoints]
        MW[authMiddleware<br/>Bearer + ?token= validator]
        API[Protected APIs]
        Users[(Users table<br/>tokenVersion epoch)]
    end

    App -->|"1. POST /api/tokens/password<br/>or /api/tokens/google"| TokenGen
    Google -.->|OAuth credential| App
    TokenGen -->|"2. JWT in body (access + refresh)"| App
    TokenGen --> Users

    App -->|"3. Authorization: Bearer <access>"| MW
    MW -->|"validate sig + tokenVersion + load user"| Users
    MW --> API
    App -->|"4. SDK Session: POST /api/tokens/refresh<br/>(refresh → new access)"| TokenGen
    App -->|"5. POST /api/users/logout → bump tokenVersion (204)"| Users
```

## Authentication Model

### Core principles

- **Bearer-only**: authentication is an `Authorization: Bearer <jwt>` header. JS attaches it explicitly — it is **not** an ambient credential, so the API works with CORS `origin: '*'` and no `Access-Control-Allow-Credentials` (see [Security](./SECURITY.md)).
- **Router-level protection**: each router applies `authMiddleware` to its protected routes; protection is explicit.
- **Stateless access, per-request user load**: the access token is a stateless JWT, but the middleware loads the user every request — which is what makes revocation (below) ~free and immediate.
- **Revocable sessions**: logout is meaningful — it revokes server-side across all devices, not just a local cookie delete.
- **Domain restrictions**: email-domain-based access control (`ALLOWED_EMAIL_DOMAINS`).

### Token lifecycle

| Token | TTL | Carried as | Purpose |
|---|---|---|---|
| **Access** | **10 minutes** | `Authorization: Bearer` | Per-request API auth; validated on every protected route. |
| **Refresh** | **30 days** | request body to `/api/tokens/refresh` | The SDK **Session** silently mints new access tokens from it. |
| **Agent** | 24 hours | `Authorization: Bearer` | Software-agent identity for background workers (`/api/tokens/agent`). |
| **Media** | 5 minutes | `?token=` query param | Resource-scoped token for `GET /api/resources/:id` (images, PDFs) where a header can't be set. |

This table is the only place these values are written down; everywhere else says
"short-lived" and links here. Each one is one `grep` from its mint site — check a
row against the literal, not against another document:

| Token | Minted at | Literal |
|---|---|---|
| Access | [`apps/backend/src/routes/auth.ts:128`](../../../apps/backend/src/routes/auth.ts#L128) | `generateToken(jwtPayload, '10m')` |
| Refresh | [`apps/backend/src/routes/auth.ts:129`](../../../apps/backend/src/routes/auth.ts#L129) | `generateToken(jwtPayload, '30d')` |
| Agent | [`apps/backend/src/routes/auth.ts:430`](../../../apps/backend/src/routes/auth.ts#L430) | `}, '24h')` |
| Media | [`apps/backend/src/auth/jwt.ts:189`](../../../apps/backend/src/auth/jwt.ts#L189) | `expiresIn: '5m'` |

Every JWT carries the user's **`tokenVersion`** at mint time (a required claim — there is no compatibility default). Both access-validation and `/api/tokens/refresh` reject when `payload.tokenVersion !== user.tokenVersion`.

### Revocation — what logout does

`POST /api/users/logout` increments `User.tokenVersion` and returns **`204`**. That single bump:

- **Kills the refresh token** — `/refresh` now rejects it, so no new access tokens can be minted.
- **Rejects live access tokens** on their next request — the per-request user load makes the epoch check ~free.

So logout is **immediate and all-devices**. (Per-device logout would need a per-session table; deliberately deferred — the epoch doesn't preclude adding it later.)

The counter is a **logical clock**, chosen over a wall-clock `tokensValidAfter` timestamp on purpose: Semiont is a global, multi-instance system, so comparing a mint-time `iat` (stamped by one instance) against a logout timestamp (stamped by another) would be unsound under clock skew. Exact integer equality is clock-independent. (Honest caveat shared by any DB-backed scheme: revocation is only as instant as cross-region replication of the `User` row.)

## Endpoint Protection

### Public endpoints (no auth)

- `GET /api/health` — health check
- `GET /api` — API documentation
- `POST /api/tokens/password` — password sign-in (returns JWT in body)
- `POST /api/tokens/google` — Google OAuth sign-in (returns JWT in body)
- `POST /api/tokens/refresh` — refresh-token exchange (validates `tokenVersion` + `isActive`)
- `POST /api/tokens/agent` — software-agent token mint

### Protected endpoints (`authMiddleware`)

Require a valid `Authorization: Bearer` access token (signature, payload schema, expiry, user exists + `isActive`, matching `tokenVersion`, allowed domain). Examples: `GET /api/users/me`, `POST /api/tokens/media`, `POST /api/users/accept-terms`, `POST /api/users/logout`, and all `/api/resources/*`.

```http
GET /api/users/me HTTP/1.1
Host: api.semiont.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

`GET /api/users/me` returns the token in its body — the bearer-in-body path the SDK relies on (no cookie to read).

### Media tokens (`?token=`)

`GET /api/resources/:id` additionally accepts a short-lived, resource-scoped **media token** as `?token=` (minted by `POST /api/tokens/media`), checked **before** the `Authorization` header. This is the path `<img>` / PDF / media use, where a request header can't be set. It is the *only* `?token=` path — it does not apply to the bare `/resources/:id` IRI.

### Bare-IRI navigation → 401

A raw browser navigation to a protected resource (e.g. pasting a `/resources/:id` IRI) is unauthenticated and returns **401** — there is no cookie and no login redirect. The missing-token 401 carries an actionable `hint`:

```json
{
  "error": "Unauthorized",
  "hint": "Authentication required: send an `Authorization: Bearer <token>` header. A raw browser navigation to a protected resource is unauthenticated."
}
```

The IRI is meant for SDK / `Bearer` dereference; the `hint` keeps a forgotten header from being misdiagnosed as the old CORS mystery.

### Admin endpoints

Admin routes require a valid token **plus** `isAdmin: true`, returning `403` otherwise (e.g. `PATCH /api/admin/users/:id`).

## JWT Security

### Validation layers (per request)

1. **Signature** — HMAC-SHA256 against `JWT_SECRET`.
2. **Payload structure** — runtime Zod validation; `tokenVersion` is a **required** claim (a token minted before the field fails `safeParse` → re-login, the correct revoke-on-rollout posture).
3. **Expiration** — access tokens are short-lived.
4. **User + epoch** — the user is loaded from the DB; rejected if absent, not `isActive`, or `payload.tokenVersion !== user.tokenVersion` (revoked).
5. **Domain** — email domain checked against the allowed list.

### Access token payload

```json
{
  "userId": "user-123",
  "email": "user@example.com",
  "name": "User Name",
  "domain": "example.com",
  "provider": "google",
  "isAdmin": false,
  "tokenVersion": 0,
  "iat": 1698765432,
  "exp": 1698766032
}
```

## Implementation Details

### Bearer validation (`apps/backend/src/middleware/auth.ts`)

The middleware accepts a media token via `?token=` for `GET /api/resources/:id`, otherwise an `Authorization: Bearer` header; a missing token returns the actionable 401 above. On a valid token it loads the principal (`OAuthService.getPrincipalFromToken` → `prisma.user.findUnique`), enforcing the `isActive` and `tokenVersion` checks, and sets `c.get('user')`.

### Route protection (`apps/backend/src/routes/resources/shared.ts`)

```typescript
import { authMiddleware } from '../../middleware/auth';

export function initResourcesRouter(router: Hono) {
  router.use('/api/resources/*', authMiddleware);
  router.use('/resources/*', authMiddleware); // W3C IRI endpoints also require auth
}
```

### Logout (`apps/backend/src/routes/auth.ts`)

```typescript
authRouter.post('/api/users/logout', authMiddleware, async (c) => {
  const user = c.get('user');
  await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } }, // revoke all of this user's tokens
  });
  return c.body(null, 204);
});
```

## Environment Configuration

### Required environment variables (backend)

```bash
JWT_SECRET=your-jwt-secret
DATABASE_URL=postgresql://user:pass@localhost:5432/semiont
ALLOWED_EMAIL_DOMAINS=example.com,company.com
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com   # for /api/tokens/google
GOOGLE_CLIENT_SECRET=your-client-secret
```

There are **no** `NEXTAUTH_*` variables — the frontend is a pure SPA with no auth server.

### Secret management

Store `JWT_SECRET` and OAuth credentials in secure secret storage (e.g. AWS Secrets Manager); never commit them; use different secrets per environment; rotate regularly. See [Configuration Guide](./CONFIGURATION.md).

Nothing generates the signing key at request time, and the backend **refuses to boot** without one rather than surfacing the problem at first sign-in. Who supplies it depends on where the stack runs:

| Placement | Supplied by | Where it lives |
|---|---|---|
| local | `semiont start` | `<state-root>/jwt-secret`, mode `0600`, one per KB root |
| codespace | `.devcontainer/post-create.sh` | `.devcontainer/.env` inside the codespace |

Both announce which key they used — `Token-signing key: generated and persisted at …` / `reused from …` / `from JWT_SECRET in the environment`. Neither ever prints the key. If tokens start failing, that line tells you whether the key changed.

### Rotating `JWT_SECRET` without signing everyone out

`JWT_SECRET` is an **ordered, comma-separated list**: the first key signs, *every* key verifies. A single value is the one-key case and behaves exactly as before.

Replacing the key outright is what causes an outage: it invalidates every access **and** refresh token at once, and refresh cannot heal it — `/api/tokens/refresh` verifies the presented token with the current key before issuing anything, so every session needs a fresh sign-in. Rotating through the list avoids that entirely.

```bash
# 1. Mint a new key and put it FIRST, keeping the old one behind it.
export JWT_SECRET="$(openssl rand -hex 32),$OLD_SECRET"
semiont start --service backend        # or restart however you deploy

# 2. Nothing breaks. New tokens are signed with the new key; tokens already
#    issued still verify against the old one, and each re-mints under the new
#    key at its next refresh.

# 3. Once every outstanding refresh token has had a chance to refresh
#    (refresh TTL is 30 days), drop the tail:
export JWT_SECRET="$NEW_SECRET"
semiont start --service backend
```

**Retiring the old key early is what breaks sessions** — any refresh token that has not been used since the rotation dies with it. Wait a full refresh TTL, or accept that the stragglers re-authenticate.

Details worth knowing:

- **Each key must be at least 32 characters.** The check is per key, not on the whole string — `<valid>,short` would otherwise pass trivially. `semiont start` refuses such a value up front rather than letting the backend crash-loop.
- **A comma cannot appear in a key**, so the delimiter is unambiguous: generated keys are hex, and the documented recipe is `openssl rand -hex 32`.
- **Logout still wins.** Revocation is a `tokenVersion` epoch check that runs independently of the key ring: a token revoked by signing out stays revoked even though its signature verifies against a ring member. A rotation is not an amnesty.
- **Media tokens** (`?token=`) sign and verify through the same ring, so they rotate with everything else. Their 5-minute TTL makes the grace window academic, but they are not on a separate path.
- **Two keys is the normal maximum.** The ring exists for a rotation window, not as a key store; trial verification costs one extra HMAC per key on the failing path.

## Security Best Practices

### Token handling

1. **Bearer tokens live in JS memory**, not cookies — the SDK holds them and attaches them explicitly. There is no httpOnly cookie. The XSS trade-off (a long-lived refresh token in JS) is mitigated by **revocability**: logout bumps `tokenVersion` and instantly invalidates it.
2. **The short access TTL** limits the window of a leaked access token; revocation is at the `/refresh` boundary and on every request.
3. **Always use HTTPS in production.**
4. **Open CORS is intentional and safe here** because no credentials are carried (see [Security](./SECURITY.md)). Never re-introduce credentialed CORS or origin-reflection.

### OAuth

1. Restrict redirect URIs to known callbacks. 2. Limit access by email domain. 3. Verify the email is confirmed by the provider. 4. Request minimal scopes.

### API

1. Routes explicitly apply `authMiddleware`. 2. Rate-limit per IP/user (edge rate-limiting is your deployment platform's concern). 3. Validate inputs with Zod. 4. Log auth events; the startup log records the bearer-only / open-CORS posture.

> **MCP programmatic access** — the old browser-mediated MCP token routes (`/api/tokens/mcp-setup`, `/api/tokens/mcp-generate`) were removed when auth moved bearer-only; MCP provisioning is being re-architected (each backend KB owns its own grant handshake). MCP `login` is not available until that rebuild lands.

## Troubleshooting

**"Unauthorized" (401)**
- Confirm the `Authorization: Bearer <token>` header is present and well-formed.
- A raw browser navigation to a protected resource is unauthenticated by design — use the SDK or a media `?token=`.
- The token may be expired — let the SDK Session refresh, or re-authenticate.
- After a **logout** anywhere, *all* of that user's existing tokens are revoked (the `tokenVersion` epoch advanced) — re-authenticate.

**Refresh fails (session ends)**
- A `401` from `/api/tokens/refresh` means the refresh token was revoked (logout) or the user is inactive — the SDK Session clears and stops retrying. Re-authenticate.

**OAuth callback fails**
- Verify the redirect URI matches the Google OAuth configuration and the Google client ID/secret are valid.

**Domain restriction blocks login**
- Confirm the user's email domain is in `ALLOWED_EMAIL_DOMAINS` and the email is verified by the provider.

## Related Documentation

- [Architecture Overview](../README.md) - Application architecture and service communication
- [Security](./SECURITY.md) - CORS posture, secrets, hardening
- [Running Semiont on AWS](../platforms/AWS.md) - what you must wire up yourself
- [Database Management](./DATABASE.md) - User table schema (incl. `tokenVersion`) and Prisma setup

---

**Authentication**: bearer-only JWT (short-lived access + long-lived refresh) with a per-user `tokenVersion` revocation epoch; `?token=` media tokens; open CORS.
**Last Updated**: 2026-06-20
