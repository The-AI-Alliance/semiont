# Role-Based Access Control (RBAC)

## Current Implementation

Semiont currently implements a basic admin/user role system with plans for comprehensive RBAC in future versions.

### Current Roles

#### Admin Role
Users with admin privileges have access to:
- Admin dashboard at `/admin`
- User management interface at `/admin/users`
- Security settings at `/admin/security`
- System configuration and monitoring
- All API endpoints including admin-only routes

#### Regular User Role
Standard authenticated users can:
- Access their own profile and settings
- Use the main application features
- Access public and user-level API endpoints

### Admin Setup

Admins are configured during deployment:

```bash
# Set admin email addresses (comma-separated)
semiont configure set --secret-path admin-emails --value "admin@example.com,alice@example.com"

# Set admin password (for non-OAuth environments)
# Will prompt for password if --value is not provided
semiont configure set --secret-path admin-password
```

Users who authenticate with email addresses in the admin list automatically receive admin privileges.

### Authentication Methods

1. **OAuth (Recommended)**
   - Google OAuth
   - GitHub OAuth
   - Automatic role assignment based on email address

2. **Direct Login**
   - Email/password authentication
   - Used when OAuth is not configured
   - Admin password for initial admin access

## Planned RBAC Features

### Future Role Hierarchy
```
Super Admin
├── Organization Admin
│   ├── Department Admin
│   └── Project Admin
│       ├── Editor
│       └── Viewer
└── System Admin
```

### Planned Capabilities

#### Fine-Grained Permissions
- Resource-level access control
- Action-specific permissions (read, write, delete, share)
- Time-based and conditional access rules

#### Dynamic Role Management
- Custom role creation
- Permission inheritance
- Delegated administration
- Temporary role assignments

#### Audit & Compliance
- Comprehensive audit logging
- Permission change tracking
- Compliance reporting
- Access analytics

### Implementation Roadmap

**Phase 1 (Current)**: Basic admin/user roles
**Phase 2**: Custom role creation and assignment
**Phase 3**: Resource-level permissions
**Phase 4**: Advanced features (delegation, conditions, audit)

## Security Best Practices

### Current Recommendations
1. Use OAuth for authentication when possible
2. Regularly review admin user list
3. Use strong passwords for admin accounts
4. Monitor admin actions through logs
5. Limit number of admin users to essential personnel

### Admin Management Commands

```bash
# View current admin configuration
semiont configure get --secret-path admin-emails

# Update admin list
semiont configure set --secret-path admin-emails --value "new-admin@example.com"

# Remove admin access (update list without the user)
semiont configure set --secret-path admin-emails --value "remaining-admin@example.com"

# Check admin access logs
semiont watch logs --filter admin
```

## API Security

Admin endpoints are protected at multiple levels:
- JWT token validation
- Email-based role verification
- Route-level middleware checks
- Audit logging of admin actions

Example protected endpoint:
```typescript
// Backend route protection
app.use('/api/admin/*', requireAdminRole);

// Frontend page protection
<AdminAuthWrapper>
  <AdminDashboard />
</AdminAuthWrapper>
```

## Troubleshooting

### Common Issues

**Admin can't access dashboard:**
- Verify email is in admin-emails list
- Check OAuth configuration matches email domain
- Ensure cookies are enabled for session management
- Check browser console for authentication errors

**Admin privileges not applied:**
- Clear browser cache and cookies
- Sign out and sign in again
- Verify JWT token contains correct email
- Check backend logs for authentication errors

**OAuth users not getting admin role:**
- Ensure OAuth email matches admin-emails exactly
- Check OAuth provider is returning email claim
- Verify OAuth configuration in secrets manager

For more deployment and configuration details, see [DEPLOYMENT.md](./DEPLOYMENT.md).