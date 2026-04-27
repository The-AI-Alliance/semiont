# Role-Based Access Control (RBAC)

## Current State

Semiont authenticates all users via OAuth and enforces three privilege levels through middleware on the backend:

| Role | Flag | Capabilities |
|------|------|-------------|
| **User** | *(default)* | Full read/write access to all resources, annotations, and entity types |
| **Moderator** | `isModerator` | User capabilities + entity type management |
| **Admin** | `isAdmin` | All capabilities + user management, exchange (backup/restore/export/import), system configuration |

### What This Means in Practice

- **All authenticated users can see and edit all content.** There is no per-resource, per-annotation, or per-user access control today.
- Moderator and Admin roles gate access to specific administrative features, not to content.
- Role flags (`isAdmin`, `isModerator`) are stored on the User record in the PostgreSQL database and checked by middleware on protected routes.

### Access Levels

- **Public**: Health checks, API documentation, OAuth endpoints (no authentication required)
- **Authenticated**: All resources, annotations, entity types, search, graph queries
- **Moderator**: Entity type management (`/api/entity-types` mutations)
- **Admin**: User management (`/api/admin/users`), exchange operations (`/api/admin/exchange/*`), system configuration

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

Sessions use JWT tokens: 7-day access tokens, 30-day refresh tokens.

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

1. **OAuth Domain Restrictions**: Configure `OAUTH_ALLOWED_DOMAINS` to limit who can authenticate
2. **Network Security**: Deploy behind a firewall or VPN if sensitive data is involved
3. **Environment Isolation**: Use separate deployments for different user groups with different trust levels
4. **Admin Assignment**: Limit admin role assignments to trusted users via the admin UI

## For Developers

### Middleware Pattern

Role checks are enforced via middleware on the backend:

```typescript
// Admin middleware pattern (used in routes/exchange.ts, routes/admin.ts)
const adminMiddleware = async (c, next) => {
  const user = c.get('user');
  if (!user || !user.isAdmin) {
    return c.json({ error: 'Forbidden: Admin access required' }, 403);
  }
  return next();
};
```

All protected routes apply `authMiddleware` first (JWT validation), then role-specific middleware as needed.

---

Last Updated: March 2026
