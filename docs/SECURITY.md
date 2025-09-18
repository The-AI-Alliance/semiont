# Semiont Security

This document describes the current security implementation in Semiont and provides guidance for secure deployment and operation.

## Current Security Features

### Authentication

Semiont currently implements authentication using NextAuth.js with support for:

- **Google OAuth**: Secure authentication via Google Identity Platform (production environments)
- **Development Mode**: Simplified authentication for local development (NODE_ENV=development only)
- **Session Management**: JWT-based session handling with configurable expiration

### Authorization

The current implementation includes:

- **Authenticated Sessions**: All API endpoints require valid authentication tokens (except in development mode)
- **JWT Token Validation**: Bearer token authentication for API access with Zod-based payload validation
- **User Identification**: Each request includes user context for audit trails

**Note**: Fine-grained role-based access control (RBAC) is planned for future releases. Currently, all authenticated users have equal access to application features.

### Data Security

#### Current Protections

- **Environment Variables**: Sensitive configuration stored in environment variables
- **HTTPS in Production**: TLS encryption for all production traffic (when deployed behind a reverse proxy)
- **Input Validation**: Zod schemas for request/response validation
- **SQL Injection Prevention**: Parameterized queries via Prisma ORM (when using SQL databases)

#### Storage

- **Local File Storage**: Documents stored in configurable directory (`SEMIONT_ROOT`)
- **Database**: Support for multiple graph databases (Neo4j, JanusGraph, InMemory)
  - Connection strings should be kept secure
  - Use environment variables for database credentials

## Deployment Security Recommendations

### Environment Configuration

```bash
# Required environment variables (keep secure)
export NEXTAUTH_SECRET="<strong-random-string>"
export NEXTAUTH_URL="https://your-domain.com"
export GOOGLE_CLIENT_ID="<oauth-client-id>"
export GOOGLE_CLIENT_SECRET="<oauth-client-secret>"
export DATABASE_URL="<your-database-connection-string>"
```

### Production Deployment

1. **Use HTTPS**: Always deploy behind a reverse proxy with TLS termination
2. **Set NODE_ENV**: Ensure `NODE_ENV=production` to disable development shortcuts
3. **Secure Secrets**: Use a secrets management system for sensitive configuration
4. **Network Security**: Deploy backend services in private networks when possible
5. **Regular Updates**: Keep dependencies updated with security patches

### Development vs Production

| Feature | Development | Production |
|---------|------------|------------|
| Authentication | Optional/Simplified | Required (OAuth) |
| HTTPS | Optional | Required |
| Error Details | Full stack traces | Generic error messages |
| Debug Logging | Enabled | Disabled |
| CORS | Permissive | Restrictive |

## Security Best Practices for Operators

### Access Control

1. **OAuth Configuration**: Configure OAuth providers with appropriate redirect URIs
2. **Domain Restrictions**: Limit OAuth to specific email domains if needed
3. **Session Timeout**: Configure appropriate session expiration times
4. **API Keys**: Rotate API keys and secrets regularly

### Monitoring

- Monitor authentication failures
- Track API usage patterns
- Review error logs for security-related issues
- Set up alerts for suspicious activities

### Data Protection

1. **Backups**: Implement regular backup procedures for data and configurations
2. **File Permissions**: Ensure proper file system permissions on `SEMIONT_ROOT`
3. **Database Security**: Follow database-specific security guidelines
4. **Audit Trails**: Retain logs for security analysis

## Known Limitations

The following security features are **not yet implemented** and are planned for future releases:

- Fine-grained role-based access control (RBAC)
- Resource-level permissions
- Automated vulnerability scanning
- End-to-end encryption for stored documents
- Multi-factor authentication (MFA) beyond OAuth provider support
- Comprehensive audit logging
- Data loss prevention (DLP) policies

## Roadmap

### Medium-term
- Basic role system (admin/user)
- Enhanced audit logging
- Full RBAC implementation
- Resource-level permissions
- Advanced threat detection

### Long-term
- Enterprise compliance features (SOC2, GDPR)
- Advanced security analytics
- Zero-trust architecture

## Reporting Security Issues

If you discover a security vulnerability in Semiont:

1. **Do not** create a public GitHub issue
2. Email security details to the maintainers
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fixes (if any)

## Development Security

### For Contributors

- Never commit secrets or credentials
- Use environment variables for configuration
- Follow secure coding practices
- Validate all user inputs
- Handle errors securely (don't leak sensitive info)
- Keep dependencies updated

### Security Testing

Before deploying:
```bash
# Check for known vulnerabilities
npm audit

# Update dependencies
npm update

# Run security linters (if configured)
npm run lint
```

## Compliance Note

Semiont is an open-source project and is provided "as-is". Organizations deploying Semiont are responsible for:
- Implementing appropriate security controls for their use case
- Ensuring compliance with relevant regulations
- Performing security assessments
- Maintaining secure configurations

---

Last Updated: September 2025

For the latest security updates and patches, see the [GitHub repository](https://github.com/The-AI-Alliance/semiont).
