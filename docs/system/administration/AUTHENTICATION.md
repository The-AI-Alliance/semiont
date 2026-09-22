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
2. **Bearer validation** — the gateway validates the token on every protected request (router-level `authMiddleware`), verifying an issuer token against the issuer's published keys and building the caller's principal from the claims it carries. There is no directory to consult: the identity is the token.
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
        Principal[Principal<br/>DID, email, name, domain]
        API[Protected APIs]
    end

    App -->|"1. sign in"| IdP
    IdP -.->|"2. access token"| App

    App -->|"3. Authorization: Bearer <token>"| MW
    MW -->|"4. verify signature against"| JWKS
    MW -->|"5. derive from the token's own claims"| Principal
    Principal --> API
    App -->|"6. POST /api/tokens/media (resource-scoped)"| TokenGen
```

No datastore appears in that diagram, and that is the point: step 5 reads the
token, not a table. Semiont kept a `users` table until 2026-09-18; see
[Database](./DATABASE.md) for what replaced it.

## Authentication Model

### Core principles

- **Bearer-only**: authentication is an `Authorization: Bearer <jwt>` header. JS attaches it explicitly — it is **not** an ambient credential, so the API works with CORS `origin: '*'` and no `Access-Control-Allow-Credentials` (see [Security](./SECURITY.md)).
- **Router-level protection**: each router applies `authMiddleware` to its protected routes; protection is explicit.
- **Stateless, with no per-request lookup**: the principal is derived from the token's claims on every request. A display-name change at the issuer reaches the gateway when the holder's next token is minted, not before — there is no row to update and nothing cached to invalidate.
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
| Access | the realm the launcher imports, [`apps/launcher/internal/launcher/identity.go`](../../../apps/launcher/internal/launcher/identity.go) | `keycloakAccessTokenLifespan`, written into the realm as `accessTokenLifespan`. A knowledge base overrides it with `accessTokenLifespan` in its `[identity]` section. **Applied only on first boot** — import skips an existing realm, so a deployment older than the change keeps what it was created with, and `semiont start` warns when the realm's actual lifespan disagrees with the config. |
| Agent | [`apps/gateway/src/routes/auth.ts`](../../../apps/gateway/src/routes/auth.ts) | `AGENT_TOKEN_TTL_SECONDS`, the one named constant; holders read `exp` off the token rather than restating it |
| Media | [`apps/gateway/src/auth/jwt.ts:189`](../../../apps/gateway/src/auth/jwt.ts#L189) | `expiresIn: '5m'` |

### Revocation

**Disable the account at the issuer.** It stops minting for that person immediately, which ends their access as soon as the token they are holding expires.

That delay is the whole of the trade, and it is deliberate. Semiont previously kept an `isActive` column and checked it on every request, which cut off a live token on its next call. It also meant two systems answering one question, able to disagree, with only the issuer's answer capable of stopping a token from being minted at all. The column is gone; the issuer decides, and the access token lifetime above bounds how long a revoked person can still act.

Disabling also stops the refresh grant, so the person cannot mint a replacement when the one they hold expires.

**Signing out in a client is a client-side act.** The token lives in memory and the client drops it. The gateway is not told, and nothing server-side changes.

**Agent tokens are the exception with no issuer behind them.** An agent identity is synthetic — derived from a (provider, model) pair rather than registered anywhere — so there is no account to disable. Its lifetime is the whole of its revocation window. Disabling at the issuer the *service account* that asked for it stops further mints, but cannot touch a token already handed out.

## Who a person is, and who vouches for it

### The subject claim

`[identity] subjectClaim` names the issuer claim a person's DID is built from:

```toml
[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
subjectClaim = "sub"     # the issuer's stable identifier; "email" names people by address
```

It is required — the gateway, every sidecar and `semiont start` refuse a config without it, naming the key — and it has no default: which claim identifies a person is declared per deployment, never inferred. The DID is `did:web:<site domain>:users:<claim value>`, under the same `[site] domain` the deployment mints its software agents beneath, so a person and the software working for them are peers under one authority. With `"sub"`, a changed email changes nothing about who authored what; with `"email"`, the address is the identity, and the operator has said so.

### The trust boundary

The gateway, the services behind it (Archivist, Stower, dispatcher, the sidecars), and the administrator who runs them and commits the event log are **one party**. The gateway verifies every bearer token and stamps the verified DID onto every event as `_userId`; nothing behind it re-verifies, because there is nothing to gain — from outside, this knowledge base vouched for its log either way. What the record holds is therefore the knowledge base's word: every provenance fact on an artifact is either the verified emitter of an event or derived by joining events whose emitters were verified, and nothing an emitter asserts about identity in a payload is honoured. Verification of that log by a reader *outside* the knowledge base — a signature under a key the emitter controls — is not a property a single deployment has; it belongs to federation between knowledge bases, where each signs what it vouches for.

## Endpoint Protection

### Public endpoints (no auth)

- `GET /api/health` — health check
- `GET /.well-known/oauth-protected-resource` — names the issuer this deployment trusts (RFC 9728)
- `/`, `/api`, `/api/docs`, `/api/swagger`, `/api/openapi.json` — the API documentation and the OpenAPI document itself

That is the complete list. The OpenAPI spec is the single source of truth for it — an operation declaring no `security` is public — and `route-spec-coverage.test.ts` fails the build if any other registered route answers an unauthenticated caller with anything but 401.

There is no password endpoint, no provider endpoint and no refresh endpoint. People obtain tokens from the issuer.

### Service-account endpoint

`POST /api/tokens/agent` is **not** public. A sidecar authenticates at the issuer as its own service account, presents that token here as a bearer, and receives a software-agent token naming a (provider, model) identity. The gateway verifies the bearer against the issuer's keys and requires a flat `roles` claim containing `semiont-service`; every refusal is a 401, checked *before* the body is parsed.

Two identities, deliberately: the service account is the **process**, the agent DID is the **work**. One worker holds several agent identities at once when a deployment configures different models for different job types, so the caller's credential cannot be the agent's identity.

This replaced a single shared secret (`SEMIONT_WORKER_SECRET`) that every sidecar carried and the gateway compared by string equality. That secret granted any agent identity to anyone holding it, was scoped to no caller, and could only be rotated by restarting the whole stack.

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
4. **Subject and email** — the claim `[identity] subjectClaim` names must be present and non-empty, an `email` is required, and an `email_verified` of false is refused.
5. **Principal** — built from those claims. The DID is `did:web:<site domain>:users:<subject>`, the subject being the value of the configured claim — the email is carried for display and is not part of the identity; `name` and `picture` are carried through when the issuer sends them. Nothing is looked up, and there is no second admission check.

**A token the gateway itself signed** (software agents only):

1. **Signature** — HMAC-SHA256 against the `JWT_SECRET` key ring.
2. **Payload structure** — runtime Zod validation against `JWTPayloadSchema`; a token whose claims do not parse is rejected, not coerced.
3. **Expiration** — enforced at verification.

The claims are trusted on this path precisely because the gateway signed them: it is both the minter and the verifier, so a valid signature means this process asserted these facts itself.

### Gateway-signed token payload

Agents and media only — a person's token is the issuer's, and its claims are whatever that realm mints.

```json
{
  "did": "did:web:example.com:agents:anthropic:claude-opus-5",
  "email": "anthropic-claude-opus-5@agents.example.com",
  "name": "anthropic claude-opus-5",
  "domain": "example.com",
  "iat": 1698765432,
  "exp": 1698769032
}
```

`did` is the identity everything downstream keys on — the bus stamps it on every event, resource creation attributes to it, the signal ledger claims under it. It replaced a `userId` cuid that named a row in a table that no longer exists. There is no `isAdmin` claim and no `provider` claim; the shape is enforced at verification by `JWTPayloadSchema`.

## Implementation Details

### Bearer validation (`apps/gateway/src/middleware/auth.ts`)

The middleware accepts a media token via `?token=` for `GET /api/resources/:id`, otherwise an `Authorization: Bearer` header; a missing token returns the actionable 401 above. On a valid token it resolves the principal (`principalFromToken` in `apps/gateway/src/identity/`) and sets `c.get('principal')`.

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
```

There are **no** OAuth client credentials here and no `NEXTAUTH_*` variables. The gateway never speaks to an identity provider on a person's behalf, so it holds no client secret; it only verifies tokens against the issuer's published keys. The issuer this deployment trusts is named in the knowledge base's `[identity]` configuration.

### Secret management

Store `JWT_SECRET` in secure secret storage (e.g. AWS Secrets Manager); never commit it; use a different secret per environment; rotate regularly. See [Configuration Guide](./CONFIGURATION.md). The sidecars' service-account credentials are the issuer's to hold and are rotated there.

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

Two of those the launcher does write into the realm it imports, rather than inherit, so they are decisions someone can read back rather than Keycloak defaults that move with an upgrade — the access token lifetime in the table above, and the **user profile**. The profile requires `firstName` and `lastName`, so a person an administrator created an account for is asked for their own name at first sign-in. Keycloak composes the `name` claim from those two, and that claim is what every annotation and resource they author is attributed to; `semiont useradd` deliberately sets no display name, because splitting one typed string on a space gets "Mary Jane" and "van der Berg" wrong.

An operator federating a **different** issuer owes Semiont the following. Everything else above is this realm's shape, not a requirement of the gateway.

**Every token the gateway accepts:**

- **`iss` exactly equal to the configured issuer URL.** Discovery is read at `<issuer>/.well-known/openid-configuration`, and a document naming a different `issuer` is refused rather than followed.
- **RS256, verifiable against the `jwks_uri` that document publishes.** Keys are selected by `kid`; no other algorithm is accepted.
- **`aud` carrying this knowledge base's resource identifier** — the exact string `/.well-known/oauth-protected-resource` publishes as `resource`. It is derived from the committed `did:web` domain, not configured, so it cannot be set to something else at the issuer's convenience: the issuer must be told to stamp it. This is the requirement operators miss, and missing it fails every request with a 401 that looks like a key problem.

**A person's token also needs** the claims [Validation layers](#validation-layers-per-request) lists — a `sub`, an `email`, and an `email_verified` that is not `false`. `name` is optional, and is what every annotation and resource they author is attributed to.

**A service account's token also needs** a flat `roles` array containing `semiont-service` — an array of strings at the top level, deliberately not Keycloak's nested `realm_access.roles`. An issuer with its own group model maps it into that claim.

**A worker's token also needs `semiont-worker`** in that same array. The gateway stamps it onto the agent token a worker mints, and the dispatcher admits a `job:claim` only from a token carrying it — `semiont-service` is what every sidecar has, so it cannot be what distinguishes a worker. A worker that is not yours is admitted by granting its client this role; nothing else changes.

**For people and the CLI to sign in at all**, the issuer needs a device-grant-capable public client (`semiont login`) and an authorization endpoint that enforces PKCE with redirect URIs covering the Browser.

**Each Semiont service needs its own client**, not one shared between them: the archivist, dispatcher, gateway, librarian, smelter, weaver and worker each authenticate as themselves, and a shared credential would let any one of them mint any other's identity. Under `[identity] type = "keycloak"` the launcher creates all seven. Under `type = "oidc"` you create them at your own issuer and supply each secret as `SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>` — see [Maintenance](./MAINTENANCE.md) for rotation.

`semiont start` preflights every one of these against whatever issuer is configured and reports what it finds, so a federation that does not conform says so at startup rather than one 401 at a time. For a realm the launcher runs, `semiont identity sync` repairs what the preflight finds: it creates missing service-account clients, reconciles an existing client's roles mapper (a realm imported before the worker role existed), adds the loopback redirect URIs, turns the implicit flow off, and sets the access-token lifetime to match the config. It reconciles configuration only and never touches accounts.

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
- The token may lack the claim `[identity] subjectClaim` names; the gateway refuses it, naming the claim.

**Sign-in fails at the issuer**
- The account may be disabled there. That is where enable and disable live; `semiont useradd --active` re-enables one.
- Nothing about this is visible in the gateway's logs, because the gateway is never contacted for a sign-in that fails.

## Related Documentation

- [Architecture Overview](../README.md) - Application architecture and service communication
- [Security](./SECURITY.md) - CORS posture, secrets, hardening
- [Running Semiont on AWS](../platforms/AWS.md) - what you must wire up yourself
- [Database Management](./DATABASE.md) - the PostgreSQL Keycloak uses; Semiont keeps no schema
- [Configuration](./CONFIGURATION.md) - the `[identity]` section

---

**Authentication**: bearer-only. People's tokens are minted by the trusted issuer and verified here against its published keys; the gateway signs only agent and media tokens. A person is named by the configured subject claim under the knowledge base's own domain. Revocation is disabling the account at the issuer, bounded by the access token lifetime. Open CORS.
**Last Updated**: 2026-09-22
