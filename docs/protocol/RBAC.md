# Role-Based Access Control (RBAC)

## Current State

Semiont authenticates every caller at a trusted issuer and recognizes exactly one
authorization decision on the gateway: **authenticated, or not**. A refusal is
always **401**. No gateway route returns 403, because no gateway route consults a
role to decide access.

### The one role that is enforced

| Role | Claim | What it gates |
|------|-------|---------------|
| **`semiont-service`** | a flat `roles` array on the token | `POST /api/tokens/agent`, and the Archivist's read path |

It marks a **service account** — a sidecar process, not a person. A caller
holding it may exchange its own issuer token for a software-agent token, and may
read through the Archivist. It grants nothing else, and no human account carries
it.

The claim is a flat array of strings under `roles`, deliberately **not**
Keycloak's nested `realm_access.roles`. Nothing in the verification path carries
a vendor name, so an operator federating a different issuer maps their own groups
into the same claim. It is checked in
[`agent-minter.ts`](../../apps/gateway/src/identity/agent-minter.ts) and
[`archivist-read-path.ts`](../../packages/make-meaning/src/archivist-read-path.ts).

### There are no human roles

The gateway reads no role, flag, or group to decide what a person may do. The
`isAdmin` and `isModerator` flags are gone — not deprecated, removed. They lived
on a User row that no longer exists, and the
[`Principal`](../../apps/gateway/src/identity/principal.ts) built from a verified
token carries no role field at all.

Admin and moderator **realm** roles are a deferred decision, not pending work.
Nothing in Semiont is waiting on them.

### Access levels

- **Public**: `GET /api/health`, `GET /.well-known/oauth-protected-resource`, and the
  documentation meta-routes (`/`, `/api`, `/api/docs`, `/api/swagger`, `/api/openapi.json`)
- **Authenticated**: everything else — resources, annotations, entity types, search,
  graph queries, status, and the bus
- **Service account**: `POST /api/tokens/agent` and the Archivist read path additionally
  require the `semiont-service` role above

The OpenAPI spec is the single source of truth for which routes are public: an
operation declaring no `security` is public, and
[`route-spec-coverage.test.ts`](../../apps/gateway/src/__tests__/route-spec-coverage.test.ts)
fails the build if any other registered route answers something other than 401 to
an unauthenticated caller.

### What this means in practice

- **All authenticated people can see and edit all content.** There is no
  per-resource, per-annotation, or per-user access control.
- **The gateway has no administration surface.** Accounts are created, disabled,
  and assigned roles at the knowledge base's identity provider.
- **Admission is the issuer's.** The gateway admits every subject whose token
  verifies. It keeps no allowlist and no per-user enable flag, because a second
  answer to "may this person sign in" can only disagree with the first — and only
  the issuer's answer can stop a token being minted at all.

### What's NOT implemented

- Per-resource or per-annotation access control
- Visibility restrictions (private/shared/public resources)
- Team or group-based permissions
- Human roles of any kind on the gateway
- Access control lists (ACLs)

Semiont recognizes that content-level access control is essential for
multi-tenant and enterprise deployments. This is planned for future releases.

## Authentication

Semiont is a **resource server**. It mints no human credential, holds no
password, and runs no sign-in flow.

### How a caller obtains a token

| Caller | Grant | Where |
|---|---|---|
| A person in a browser | authorization code + PKCE | at the issuer |
| A script or the CLI | device authorization grant | at the issuer |
| A sidecar process | client credentials | at the issuer, as its own service account |

Which issuer a knowledge base trusts is named in its `[identity]` configuration
and published at `GET /.well-known/oauth-protected-resource` (RFC 9728). There
are no OAuth client secrets in the gateway's environment, and no provider is
configured here — federating Google, GitHub, an enterprise SAML IdP, or anything
else is the issuer's business, not Semiont's.

### Sessions and revocation

Access tokens are short-lived and minted by the issuer; the gateway validates
them against the issuer's published keys on every protected request. TTLs are in
[Authentication](../system/administration/AUTHENTICATION.md).

- **Refresh** happens at the **issuer's** token endpoint, not here. The SDK wires
  it automatically for sessions it created (`refreshAtIssuer` in
  [`oauth.ts`](../../packages/sdk/src/session/oauth.ts)). The gateway has no
  refresh endpoint.
- **Signing out** clears the stored tokens and revokes the **refresh** token at
  the issuer (RFC 7009, best-effort — an unreachable issuer must not trap someone
  in a session they asked to end). The access token in hand stays valid until it
  expires; its lifetime is that window.
- **Disabling an account** at the issuer stops new tokens immediately and stops
  the refresh grant, so the holder cannot mint a replacement.

There is no server-side session, no token-version epoch, and no gateway logout
route. Nothing the gateway stores has to be invalidated, because the gateway
stores nothing about a caller.

## Roadmap

### Content-Level Access Control (Future)

- Per-resource visibility (private, shared, public)
- Team/group-based permissions
- Fine-grained annotation permissions
- Roles the gateway actually consults, with configurable permission sets

### Enterprise Features (Future)

- Audit logging UI
- Temporary/time-limited permissions
- API key management with scoped access

Enterprise SSO is not on this list: it is available today, because the issuer
owns sign-in. Point a knowledge base at a realm federated to your IdP.

## Security Recommendations

Until content-level access control is implemented:

1. **Issuer admission**: the issuer decides who may authenticate. Restrict
   registration and domain admission there.
2. **Network security**: deploy behind a firewall or VPN if sensitive data is involved.
3. **Environment isolation**: use separate deployments for user groups with
   different trust levels.
4. **Treat every authenticated user as a full-access user**, because that is what
   the gateway does.

## For Developers

### Middleware pattern

There is one gate, applied per router:

```typescript
resourcesRouter.use('/api/resources/*', authMiddleware);
```

`authMiddleware` verifies the bearer token, resolves the principal, and answers
401 when it cannot. A route that needs a narrower audience than "any
authenticated caller" needs a new gate, and `route-spec-coverage.test.ts` is
where its contract gets declared.

---

Last Updated: September 2026
