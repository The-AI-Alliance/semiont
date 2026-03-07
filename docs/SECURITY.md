# Semiont Security

This document describes the current security implementation in Semiont and provides guidance for secure deployment and operation.

## Current Security Features

### Authentication

Semiont implements authentication using NextAuth.js with support for:

- **Google OAuth**: Secure authentication via Google Identity Platform (production environments)
- **GitHub OAuth**: Secure authentication via GitHub (production environments)
- **GitLab OAuth**: Secure authentication via GitLab (production environments)
- **Session Management**: JWT-based session handling with configurable expiration
- **Backend JWT Tokens**: 7-day access tokens, 30-day refresh tokens for MCP clients

### Authorization

The current implementation includes:

- **Router-Level Authentication**: Each backend router applies JWT authentication middleware to protected routes
- **JWT Token Validation**: Bearer token authentication for API access with HMAC SHA256 signature verification
- **User Identification**: Each request includes user context (id, email, isAdmin, isModerator) for audit trails
- **Role-Based Access Control**: Admin and moderator roles implemented with middleware enforcement (see [RBAC.md](./RBAC.md))
- **OpenAPI Security Spec**: All routes documented with security requirements in OpenAPI specification

**Access Levels**:
- **Public**: Health checks, API documentation, OAuth endpoints (no authentication required)
- **Authenticated**: All resources, annotations, entity types (requires valid JWT)
- **Moderator**: Entity type management (requires isModerator=true or isAdmin=true)
- **Admin**: User management, system configuration (requires isAdmin=true)

### Security Testing

Comprehensive security test coverage ensures no authentication regressions:

- **route-auth-coverage.test.ts**: Tests ALL backend routes dynamically
  - Validates all non-public routes return 401 without authentication
  - Uses OpenAPI spec as single source of truth for public routes
  - Tests invalid tokens, malformed tokens, expired tokens
  - Auto-detects route patterns and catch-all routes
  - Provides coverage statistics (tested vs skipped routes)
  - Runs in CI/CD via `npm run test:security`

- **backend-security.test.ts**: Documents security requirements
  - Admin endpoint protection patterns
  - Approved error messages (no sensitive data leakage)
  - HTTP status code standards
  - Token validation flows
  - Information disclosure prevention

- **security-controls.test.ts**: Tests security headers
  - CORS configuration
  - Content security headers
  - Request validation

**CI/CD Integration**: Security tests run on every pull request via GitHub Actions ([.github/workflows/security-tests.yml](../.github/workflows/security-tests.yml))

### Data Security

#### Current Protections

- **Environment Variables**: Sensitive configuration stored in environment variables
- **HTTPS in Production**: TLS encryption for all production traffic (when deployed behind a reverse proxy)
- **Input Validation**: Zod schemas for request/response validation
- **SQL Injection Prevention**: Parameterized queries via Prisma ORM (when using SQL databases)

#### Storage

- **Event Store**: Append-only event log with filesystem or database backend
- **View Storage**: Projection data in configurable directory (`SEMIONT_ROOT`)
- **Graph Database**: Support for multiple graph databases (Neo4j, JanusGraph, AWS Neptune, InMemory)
  - Connection strings should be kept secure
  - Use environment variables for database credentials

## Deployment Security Recommendations

### Environment Configuration

```bash
# Required environment variables (keep secure)
export NEXTAUTH_SECRET="<strong-random-string>"
export NEXTAUTH_URL="https://your-domain.com"
export JWT_SECRET="<strong-random-string-32-chars-minimum>"
export GOOGLE_CLIENT_ID="<oauth-client-id>"
export GOOGLE_CLIENT_SECRET="<oauth-client-secret>"
export GITHUB_CLIENT_ID="<oauth-client-id>"
export GITHUB_CLIENT_SECRET="<oauth-client-secret>"
export GITLAB_CLIENT_ID="<oauth-client-id>"
export GITLAB_CLIENT_SECRET="<oauth-client-secret>"
export DATABASE_URL="<your-database-connection-string>"
export OAUTH_ALLOWED_DOMAINS="example.com,example.org"
```

### Production Deployment

1. **Use HTTPS**: Always deploy behind a reverse proxy with TLS termination
2. **Set NODE_ENV**: Ensure `NODE_ENV=production` to disable development shortcuts
3. **Secure Secrets**: Use a secrets management system for sensitive configuration
4. **Network Security**: Deploy backend services in private networks when possible
5. **Regular Updates**: Keep dependencies updated with security patches
6. **Domain Restrictions**: Configure OAUTH_ALLOWED_DOMAINS to limit OAuth access

### Development vs Production

| Feature | Development | Production |
|---------|------------|------------|
| Authentication | OAuth (optional) | Required (OAuth) |
| HTTPS | Optional | Required |
| Error Details | Full stack traces | Generic error messages |
| Debug Logging | Enabled | Disabled |
| CORS | Permissive | Restrictive (frontend domain only) |
| JWT Expiration | 7 days | 7 days (access), 30 days (refresh) |

## Security Best Practices for Operators

### Access Control

1. **OAuth Configuration**: Configure OAuth providers with appropriate redirect URIs
2. **Domain Restrictions**: Set OAUTH_ALLOWED_DOMAINS to restrict user registration by email domain
3. **Session Timeout**: Configure appropriate session expiration times (default: 24 hours NextAuth, 7 days backend JWT)
4. **API Keys**: Rotate API keys and secrets regularly
5. **Admin Accounts**: Limit admin role assignments to trusted users

### Monitoring

- Monitor authentication failures (401 responses)
- Track authorization failures (403 responses)
- Monitor API usage patterns for anomalies
- Review error logs for security-related issues
- Set up alerts for suspicious activities
- Monitor for brute force attempts on authentication endpoints

### Data Protection

1. **Backups**: Implement regular backup procedures for event store and projections
2. **File Permissions**: Ensure proper file system permissions on `SEMIONT_ROOT`
3. **Database Security**: Follow database-specific security guidelines
4. **Audit Trails**: Retain logs for security analysis (all events include userId)
5. **Secret Rotation**: Regularly rotate JWT_SECRET, NEXTAUTH_SECRET, and OAuth credentials

## Known Limitations

The following security features are **not yet implemented** and are planned for future releases:

- Automated vulnerability scanning in CI/CD
- End-to-end encryption for stored documents
- Multi-factor authentication (MFA) beyond OAuth provider support
- Comprehensive audit logging UI
- Data loss prevention (DLP) policies
- Rate limiting per user/IP
- IP allowlisting/blocklisting
- Session revocation API

## Roadmap

### Short-term
- Rate limiting middleware
- Session management UI (view/revoke sessions)
- Enhanced audit logging with queryable interface

### Medium-term
- Automated security scanning in CI/CD
- Data encryption at rest
- Advanced threat detection

### Long-term
- Enterprise compliance features (SOC2, GDPR)
- Advanced security analytics dashboard
- Zero-trust architecture

## Reporting Security Issues

If you discover a security vulnerability in Semiont:

1. **Do not** create a public GitHub issue
2. Email security details to the maintainers at [security contact to be added]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fixes (if any)
4. Allow reasonable time for response before public disclosure

## Development Security

### For Contributors

- Never commit secrets or credentials
- Use environment variables for configuration
- Follow secure coding practices
- Validate all user inputs with Zod schemas
- Handle errors securely (don't leak sensitive info)
- Keep dependencies updated
- Run security tests before submitting PRs

### Security Testing

Before deploying:
```bash
# Run security test suite
npm run test:security

# Check for known vulnerabilities
npm audit

# Update dependencies
npm update

# Run all tests including security
npm test
```

### Code Review Checklist

When reviewing PRs involving authentication/authorization:

- [ ] New routes apply appropriate authentication middleware
- [ ] Public routes are documented in OpenAPI spec (no `security` field)
- [ ] Protected routes documented with `security: [{ bearerAuth: [] }]`
- [ ] Admin/moderator routes check role flags
- [ ] No hardcoded secrets or credentials
- [ ] Input validation uses Zod schemas
- [ ] Error messages don't leak sensitive information
- [ ] Security tests updated if adding/modifying routes
- [ ] `npm run test:security` passes

## Compliance Note

Semiont is an open-source project and is provided "as-is". Organizations deploying Semiont are responsible for:
- Implementing appropriate security controls for their use case
- Ensuring compliance with relevant regulations (GDPR, HIPAA, SOC2, etc.)
- Performing security assessments
- Maintaining secure configurations
- Regular security audits
- Incident response planning

---

Last Updated: January 2026

For the latest security updates and patches, see the [GitHub repository](https://github.com/The-AI-Alliance/semiont).
