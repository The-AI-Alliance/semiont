# Authentication Architecture

Semiont uses **bearer-only** authentication: every request authenticates with an `Authorization: Bearer` JWT (or, for media, a short-lived `?token=`). There are **no session cookies** — the gateway carries no ambient credentials, which is what lets CORS be fully open (`*`) and a KB be hosted on the public internet.

**Related Documentation:**
- [Architecture Overview](../README.md) - Overall application architecture
- [Security](./SECURITY.md) - CORS posture, secret management, hardening checklist
- [Secrets](../services/SECRETS.md) - how secrets reach services
- [Configuration Guide](./CONFIGURATION.md) - Environment and secret management

## Overview

Three pieces make up the auth system:

1. **Sign-in happens elsewhere.** People authenticate at the knowledge base's trusted issuer and receive a token from it. The gateway mints no human credential and holds no password; it is a resource server, not an auth server.
2. **Bearer validation** — the gateway validates the token on every protected request (router-level `authMiddleware`), verifying an issuer token against the issuer's published keys and loading the matching user row.
3. **Revocation belongs to the issuer.** Disabling an account there stops new tokens at once. A token already issued stays valid until it expires, and that lifetime is the revocation window.

## Authentication Flow Diagram

```mermaid
graph TB
    subgraph "Client (SPA / SDK / CLI)"
        App[App holds token in memory]
    end

    subgraph "Trusted Issuer"
        IdP[Identity provider<br/>owns credentials and accounts]
        JWKS[Published signing keys]
    end

    subgraph "Gateway API"
        TokenGen[Agent and media token mint]
        MW[authMiddleware<br/>Bearer + ?token= validator]
        API[Protected APIs]
        Users[(Users table<br/>roles and display name)]
    end

    App -->|"1. sign in"| IdP
    IdP -.->|"2. access token"| App

    App -->|"3. Authorization: Bearer <token>"| MW
    MW -->|"4. verify signature against"| JWKS
    MW -->|"5. find or create the row for this subject"| Users
    MW --> API
    App -->|"6. POST /api/tokens/media (resource-scoped)"| TokenGen
```

## Authentication Model

### Core principles

- **Bearer-only**: authentication is an `Authorization: Bearer <jwt>` header. JS attaches it explicitly — it is **not** an ambient credential, so the API works with CORS `origin: '*'` and no `Access-Control-Allow-Credentials` (see [Security](./SECURITY.md)).
- **Router-level protection**: each router applies `authMiddleware` to its protected routes; protection is explicit.
- **Stateless token, per-request user load**: the token is stateless, but the middleware loads the user row every request, so a role or display-name change takes effect immediately.
- **One admission decision, held by the issuer**: the gateway admits every subject whose token verifies. It keeps no allowlist and no per-user enable flag, because a second answer to "may this person sign in" can only disagree with the first — and only the issuer's answer can stop a token being minted.

### Token lifecycle

| Token | TTL | Carried as | Purpose |
|---|---|---|---|
| **Access** | **5 minutes** | `Authorization: Bearer` | Per-request API auth for people; minted by the issuer, validated here on every protected route. This is the revocation window: a disabled account's token works until it expires. |
| **Agent** | **1 hour** | `Authorization: Bearer` | Software-agent identity for background workers (`/api/tokens/agent`). No account exists at the issuer to disable, so this lifetime is the whole of the revocation window. |
| **Media** | 5 minutes | `?token=` query param | Resource-scoped token for `GET /api/resources/:id` (images, PDFs) where a header can't be set. |

This table is the only place these values are written down; everywhere else says
"short-lived" and links here. Each one is one `grep` from its mint site — check a
row against the literal, not against another document:

| Token | Minted at | Literal |
|---|---|---|
| Access | the realm the launcher imports, [`apps/launcher/internal/launcher/identity.go`](../../../apps/launcher/internal/launcher/identity.go) | `keycloakAccessTokenLifespan`, written into the realm as `accessTokenLifespan`. **Only on first boot** — import skips an existing realm, so a deployment older than a change to that constant keeps what it was created with. |
| Agent | [`apps/gateway/src/routes/auth.ts`](../../../apps/gateway/src/routes/auth.ts) | `AGENT_TOKEN_TTL_SECONDS`, the one named constant; holders read `exp` off the token rather than restating it |
| Media | [`apps/gateway/src/auth/jwt.ts:189`](../../../apps/gateway/src/auth/jwt.ts#L189) | `expiresIn: '5m'` |

### Revocation

**Disable the account at the issuer.** It stops minting for that person immediately, which ends their access as soon as the token they are holding expires.

That delay is the whole of the trade, and it is deliberate. Semiont previously kept an `isActive` column and checked it on every request, which cut off a live token on its next call. It also meant two systems answering one question, able to disagree, with only the issuer's answer capable of stopping a token from being minted at all. The column is gone; the issuer decides, and the access token lifetime above bounds how long a revoked person can still act.

Disabling also stops the refresh grant, so the person cannot mint a replacement when the one they hold expires.

**Signing out in a client is a client-side act.** The token lives in memory and the client drops it. The gateway is not told, and nothing server-side changes.

**Agent tokens are the exception with no issuer behind them.** Their synthetic accounts exist only in Semiont, so there is nothing to disable. Their lifetime is their revocation window, and rotating `SEMIONT_WORKER_SECRET` stops new ones being minted without affecting tokens already handed out.

## Endpoint Protection

### Public endpoints (no auth)

- `GET /api/health` — health check
- `GET /api` — API documentation, and the OpenAPI document itself
- `GET /.well-known/oauth-protected-resource` — names the issuer this deployment trusts (RFC 9728)
- `POST /api/tokens/agent` — software-agent token mint, gated by the shared worker secret rather than by a bearer

There is no password endpoint, no provider endpoint and no refresh endpoint. People obtain tokens from the issuer.

### Protected endpoints (`authMiddleware`)

Require a valid `Authorization: Bearer` access token. Examples: `GET /api/users/me`, `GET /api/status`, `POST /api/tokens/media`, the bus endpoints, and all of `/api/resources/*`.

```http
GET /api/users/me HTTP/1.1
Host: api.semiont.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

`GET /api/users/me` answers with the caller's **DID**, which is the name the rest of the system
uses for them: the bus stamps it on every event, resource creation is attributed to it, and the
signal ledger claims under it. A client compares against this to recognise its own work in the
data. It used to answer with the User row's id, which appeared nowhere else and so could be
compared against nothing, and to echo the caller's own token back to the caller who had just
sent it.

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

## JWT Security

### Validation layers (per request)

The gateway dispatches on the token's `iss` claim, and the two paths verify differently.

**A token from the trusted issuer** (every human):

1. **Signature** — verified against the issuer's published JWKS.
2. **Issuer and audience** — must match the configured issuer and this knowledge base's derived resource identity.
3. **Expiration** — enforced by the verifier.
4. **Subject and email** — a `sub` is required, an `email` is required, and an `email_verified` of false is refused.
5. **User row** — found by (issuer, subject), else by email and linked, else created. This is a lookup, not a second admission check.

**A token the gateway itself signed** (software agents only):

1. **Signature** — HMAC-SHA256 against the `JWT_SECRET` key ring.
2. **Payload structure** — runtime Zod validation against `JWTPayloadSchema`; a token whose claims do not parse is rejected, not coerced.
3. **Expiration** — enforced at verification.
4. **User row** — loaded by id and rejected if absent. The row is what the request runs as; the claims are not trusted to still describe it.

### Access token payload

```json
{
  "userId": "user-123",
  "email": "user@example.com",
  "name": "User Name",
  "domain": "example.com",
  "provider": "google",
  "isAdmin": false,
  "iat": 1698765432,
  "exp": 1698766032
}
```

## Implementation Details

### Bearer validation (`apps/gateway/src/middleware/auth.ts`)

The middleware accepts a media token via `?token=` for `GET /api/resources/:id`, otherwise an `Authorization: Bearer` header; a missing token returns the actionable 401 above. On a valid token it loads the principal (`principalFromToken` in `apps/gateway/src/identity/`) and sets `c.get('user')`.

### Route protection (`apps/gateway/src/routes/resources/shared.ts`)

```typescript
import { authMiddleware } from '../../middleware/auth';

export function initResourcesRouter(router: Hono) {
  router.use('/api/resources/*', authMiddleware);
  router.use('/resources/*', authMiddleware); // W3C IRI endpoints also require auth
}
```

## Environment Configuration

### Required environment variables (gateway)

```bash
JWT_SECRET=your-jwt-secret                 # signs agent and media tokens only
SEMIONT_WORKER_SECRET=...                  # gates POST /api/tokens/agent
```

There are **no** OAuth client credentials here and no `NEXTAUTH_*` variables. The gateway never speaks to an identity provider on a person's behalf, so it holds no client secret; it only verifies tokens against the issuer's published keys. The issuer this deployment trusts is named in the knowledge base's `[identity]` configuration.

### Secret management

Store `JWT_SECRET` and `SEMIONT_WORKER_SECRET` in secure secret storage (e.g. AWS Secrets Manager); never commit them; use different secrets per environment; rotate regularly. See [Configuration Guide](./CONFIGURATION.md).

Nothing generates the signing key at request time, and the gateway **refuses to boot** without one rather than surfacing the problem at first sign-in. Who supplies it depends on where the stack runs:

| Placement | Supplied by | Where it lives |
|---|---|---|
| local | `semiont start` | `<state-root>/jwt-secret`, mode `0600`, one per KB root |
| codespace | `.devcontainer/post-create.sh` | `.devcontainer/.env` inside the codespace |

Both announce which key they used — `Token-signing key: generated and persisted at …` / `reused from …` / `from JWT_SECRET in the environment`. Neither ever prints the key. If tokens start failing, that line tells you whether the key changed.

### Rotating `JWT_SECRET` without cutting off the sidecars

`JWT_SECRET` is an **ordered, comma-separated list**: the first key signs, *every* key verifies. A single value is the one-key case and behaves exactly as before.

Replacing the key outright is what causes an outage: every agent and media token stops verifying at once. Sidecars recover on their own, because a 401 sends them back to `/api/tokens/agent`, but every in-flight request fails first and a listen-only feed stays dead until its next scheduled renewal. Rotating through the list avoids that entirely. People are unaffected either way; their tokens are the issuer's and verify against its keys.

```bash
# 1. Mint a new key and put it FIRST, keeping the old one behind it.
export JWT_SECRET="$(openssl rand -hex 32),$OLD_SECRET"
semiont start --service gateway        # or restart however you deploy

# 2. Nothing breaks. New tokens are signed with the new key; tokens already
#    issued still verify against the old one, and each re-mints under the new
#    key when its holder next authenticates.

# 3. Once every outstanding agent token has had a chance to be re-minted
#    (an hour, the agent TTL above), drop the tail:
export JWT_SECRET="$NEW_SECRET"
semiont start --service gateway
```

**The ring signs agent and media tokens only.** People's tokens come from the issuer and verify against its published keys, so a `JWT_SECRET` rotation does not touch them. Retiring the old key early cuts off any sidecar still holding a token minted under it; wait out the agent TTL, or accept that the stragglers re-authenticate, which they do on a 401 without operator involvement.

Details worth knowing:

- **Each key must be at least 32 characters.** The check is per key, not on the whole string — `<valid>,short` would otherwise pass trivially. `semiont start` refuses such a value up front rather than letting the gateway crash-loop.
- **A comma cannot appear in a key**, so the delimiter is unambiguous: generated keys are hex, and the documented recipe is `openssl rand -hex 32`.
- **Media tokens** (`?token=`) sign and verify through the same ring, so they rotate with everything else. Their 5-minute TTL makes the grace window academic, but they are not on a separate path.
- **Two keys is the normal maximum.** The ring exists for a rotation window, not as a key store; trial verification costs one extra HMAC per key on the failing path.

## Security Best Practices

### Token handling

1. **Bearer tokens live in JS memory**, not cookies — the SDK holds them and attaches them explicitly. There is no httpOnly cookie, and the gateway holds no long-lived credential of its own for a person.
2. **The access token lifetime is the containment window.** A leaked token works until it expires, and disabling the account at the issuer prevents a replacement rather than cancelling the one in hand. Keep the realm's lifetime short for that reason.
3. **Always use HTTPS in production.**
4. **Open CORS is intentional and safe here** because no credentials are carried (see [Security](./SECURITY.md)). Never re-introduce credentialed CORS or origin-reflection.

### At the issuer

The decisions that used to sit here now sit in the realm: who may register, which domains are admitted, how long an access token lives, and whether an account is enabled. Semiont enforces none of them and cannot compensate for them.

### API

1. Routes explicitly apply `authMiddleware`. 2. Rate-limit per IP/user (edge rate-limiting is your deployment platform's concern). 3. Validate inputs with Zod. 4. Log auth events; the startup log records the bearer-only / open-CORS posture.

> **MCP programmatic access** — the old browser-mediated MCP token routes (`/api/tokens/mcp-setup`, `/api/tokens/mcp-generate`) were removed when auth moved bearer-only; MCP provisioning is being re-architected (each gateway KB owns its own grant handshake). MCP `login` is not available until that rebuild lands.

## Troubleshooting

**"Unauthorized" (401)**
- Confirm the `Authorization: Bearer <token>` header is present and well-formed.
- A raw browser navigation to a protected resource is unauthenticated by design — use the SDK or a media `?token=`.
- The token may be expired — obtain a new one from the issuer.
- The token may be for another audience. This deployment accepts only tokens whose audience is its own derived resource identity, published at `/.well-known/oauth-protected-resource`.
- The token's email may not be marked verified by the issuer, which is refused.

**Sign-in fails at the issuer**
- The account may be disabled there. That is where enable and disable live; `semiont useradd --active` re-enables one.
- Nothing about this is visible in the gateway's logs, because the gateway is never contacted for a sign-in that fails.

## Related Documentation

- [Architecture Overview](../README.md) - Application architecture and service communication
- [Security](./SECURITY.md) - CORS posture, secrets, hardening
- [Running Semiont on AWS](../platforms/AWS.md) - what you must wire up yourself
- [Database Management](./DATABASE.md) - the PostgreSQL Keycloak uses; Semiont keeps no schema

---

**Authentication**: bearer-only. People's tokens are minted by the trusted issuer and verified here against its published keys; the gateway signs only agent and media tokens. Revocation is disabling the account at the issuer, bounded by the access token lifetime. Open CORS.
**Last Updated**: 2026-09-18
