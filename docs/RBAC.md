# Role-Based Access Control (RBAC)

## Current State

**Important**: Semiont currently does **not** have role-based access control implemented. All authenticated users have equal access to all features.

### What's Currently Implemented

1. **Authentication Required**: In non-development environments, users must authenticate via OAuth to access the application
2. **User Context**: Each authenticated user has a unique ID and email associated with their session
3. **Development Mode**: When `NODE_ENV=development`, authentication can be bypassed for easier local development

### What's NOT Implemented Yet

- User roles (admin, editor, viewer, etc.)
- Permission levels
- Resource-level access control
- Admin-only features or endpoints
- User management interface
- Access control lists (ACLs)

## Authentication Methods

### Production (OAuth)

In production environments, authentication is handled through OAuth providers:

```typescript
// Currently supported providers
- Google OAuth (configured via GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
```

### Development

In development mode, authentication is simplified:
- Mock user sessions available
- No OAuth configuration required
- Intended for local development only

## Roadmap for RBAC

### Phase 1: Basic Roles (Planned)
- [ ] Admin role
- [ ] User role
- [ ] Role assignment mechanism
- [ ] Admin-only endpoints

### Phase 2: Permission System (Future)
- [ ] Define permission model
- [ ] Resource-level permissions
- [ ] Custom roles
- [ ] Role inheritance

### Phase 3: Advanced Features (Future)
- [ ] User management UI
- [ ] Audit logging
- [ ] Temporary permissions
- [ ] API key management

## Security Recommendations

Until RBAC is implemented, consider these security measures:

1. **Network Security**: Deploy behind a firewall or VPN if sensitive data is involved
2. **OAuth Domain Restrictions**: Configure OAuth to only allow specific email domains
3. **Environment Isolation**: Use separate deployments for different user groups
4. **External Access Control**: Use reverse proxy authentication or cloud provider IAM

## For Developers

### Preparing for RBAC

When contributing code, consider future RBAC implementation:

```typescript
// Example: Structure code to easily add role checks later
async function handleRequest(req: Request, user: User) {
  // Future: check user.role here
  // if (!hasPermission(user, 'resource:action')) {
  //   throw new ForbiddenError();
  // }

  // Current: all authenticated users can proceed
  if (!user) {
    throw new UnauthorizedError();
  }

  // ... handle request
}
```

### Authentication Context

The current user context is available in API routes:

```typescript
// Backend example
const user = await getUserFromRequest(request);
// user = { id: 'user_123', email: 'user@example.com' }
```

## Configuration

Current authentication configuration:

```bash
# Required for OAuth (production)
NEXTAUTH_SECRET="<secure-random-string>"
NEXTAUTH_URL="https://your-domain.com"
GOOGLE_CLIENT_ID="<your-client-id>"
GOOGLE_CLIENT_SECRET="<your-client-secret>"

# Development mode (optional)
NODE_ENV="development"  # Enables simplified auth
```

## FAQ

**Q: Can I restrict certain users from accessing specific features?**
A: Not currently. All authenticated users have the same access level.

**Q: How can I make my deployment more secure without RBAC?**
A: Use OAuth domain restrictions, deploy behind a VPN, or use infrastructure-level access controls.

**Q: When will RBAC be implemented?**
A: RBAC is on the roadmap but no specific timeline is set. Contributions are welcome!

**Q: Can I contribute RBAC implementation?**
A: Yes! Please open an issue first to discuss the design and approach.

---

Last Updated: September 2025

For updates on RBAC implementation, watch the [GitHub repository](https://github.com/The-AI-Alliance/semiont).