# Role-Based Access Control (RBAC)

## Current State

Semiont authenticates every user at a trusted issuer and recognizes exactly one
authorization decision on the gateway: authenticated, or not.

| Role | Flag | What it gates today |
|------|------|-------------|
| **User** | *(default)* | Full read/write access to all resources, annotations, and entity types |
| **Moderator** | `isModerator` | Nothing on the gateway; carried on the principal for clients to shape their own UI |
| **Admin** | `isAdmin` | Nothing on the gateway; carried on the principal for clients to shape their own UI |

### What This Means in Practice

- **All authenticated users can see and edit all content.** There is no per-resource, per-annotation, or per-user access control today.
- The gateway has no administration surface. Accounts are created, disabled, and assigned roles at the knowledge base's identity provider.
- Role flags are stored on the User record, echoed by `GET /api/auth/me`, and read by no gateway route. Treat them as a client-side hint, not a security boundary.

### Access Levels

- **Public**: `GET /api/health`, `POST /api/tokens/agent`, API documentation, the root splash page
- **Authenticated**: Everything else — resources, annotations, entity types, search, graph queries, status, and the bus

### What's NOT Implemented

- Per-resource or per-annotation access control
- Visibility restrictions (private/shared/public resources)
- Team or group-based permissions
- Custom roles beyond the three above
- Access control lists (ACLs)

Semiont recognizes that content-level access control is essential for multi-tenant and enterprise deployments. This is planned for future releases.

## Authentication

### Production (OAuth)

Authentication is handled through OAuth providers configured in the environment:

- Google OAuth
- GitHub OAuth
- GitLab OAuth

Sessions use bearer JWTs: short-lived access tokens re-minted from long-lived refresh tokens, revocable per-user via a `tokenVersion` epoch (logout revokes all of a user's tokens). [Authentication](../system/administration/AUTHENTICATION.md) states the TTLs.

### Development

In development mode (`NODE_ENV=development`), authentication can be simplified for local development.

## Roadmap

### Content-Level Access Control (Future)

- Per-resource visibility (private, shared, public)
- Team/group-based permissions
- Fine-grained annotation permissions
- Custom roles with configurable permission sets

### Enterprise Features (Future)

- Audit logging UI
- Temporary/time-limited permissions
- API key management with scoped access
- SAML/OIDC enterprise SSO

## Security Recommendations

Until content-level access control is implemented:

1. **Issuer Admission**: The issuer decides who may authenticate. Restrict registration and domain admission there.
2. **Network Security**: Deploy behind a firewall or VPN if sensitive data is involved
3. **Environment Isolation**: Use separate deployments for different user groups with different trust levels
4. **Treat every authenticated user as a full-access user**, because that is what the gateway does.

## For Developers

### Middleware Pattern

There is one gate, applied per router:

```typescript
resourcesRouter.use('/api/resources/*', authMiddleware);
```

`authMiddleware` verifies the bearer token, resolves the principal, and answers 401
when it cannot. No gateway route returns 403, because no gateway route consults a
role. A route that needs a narrower audience than "any authenticated user" needs a
new gate, and `route-spec-coverage.test.ts` is where its contract gets declared.

---

Last Updated: September 2026
