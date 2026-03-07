# Pull Request

## Description

Brief description of the changes in this PR.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Security fix
- [ ] Performance improvement
- [ ] Code refactoring
- [ ] Infrastructure/DevOps changes

## Areas Changed

- [ ] Frontend (`apps/frontend`)
- [ ] Backend (`apps/backend`)
- [ ] CLI (`apps/cli`)
- [ ] API Client (`packages/api-client`)
- [ ] Core (`packages/core`)
- [ ] MCP Server (`packages/mcp-server`)
- [ ] Test Utils (`packages/test-utils`)
- [ ] OpenAPI Specs (`specs/`)
- [ ] Demo Scripts (`demo/`)
- [ ] Documentation (`docs/`)
- [ ] GitHub Actions (`.github/workflows/`)
- [ ] Scripts (`scripts/`)
- [ ] Infrastructure/Deployment

## Security Checklist

**Required for all PRs that modify authentication, authorization, or admin functionality:**

### Authentication & Authorization

- [ ] No authentication logic moved to client-side
- [ ] All admin routes properly protected with server-side checks
- [ ] JWT tokens validated server-side only
- [ ] Session data comes from secure sources (database, not client claims)
- [ ] No hardcoded secrets or credentials

### Admin Route Security (Frontend)

- [ ] Admin routes use `AdminAuthWrapper` or equivalent server-side protection
- [ ] No admin content rendered for unauthorized users
- [ ] Access denied pages return 200 OK (not 307 redirects)
- [ ] No sensitive information in error responses
- [ ] Authentication checks use `getServerSession`

### API Security (Backend)

- [ ] Admin endpoints protected with `adminMiddleware`
- [ ] All endpoints return proper HTTP status codes (401/403/500)
- [ ] Error messages don't leak sensitive information
- [ ] Database queries protected behind authentication
- [ ] Input validation implemented

### Information Disclosure Prevention

- [ ] No database connection strings in error messages
- [ ] No file paths or stack traces exposed to clients
- [ ] No user emails or personal data in unauthorized responses
- [ ] No API keys or secrets in client-accessible responses
- [ ] Error messages are generic and safe

## Testing

- [ ] Added tests for new functionality
- [ ] All existing tests pass
- [ ] Security tests pass (`npm run test:security`)
- [ ] Manual testing completed for authentication flows
- [ ] Tested with different user roles (unauthenticated, non-admin, admin)

## Security Test Results

Please run and paste results:

### Frontend Security Tests

```bash
cd apps/frontend && npm run test:security
# Paste results here
```

### Backend Security Tests

```bash
cd apps/backend && npm run test:security
# Paste results here
```

### Manual Security Verification

If you modified admin routes, please verify:

```bash
# Start the application and test:
curl -I http://localhost:3000/admin
# Should return: HTTP/1.1 200 OK (not 307)

# Verify no admin content leakage:
curl -s http://localhost:3000/admin | grep -i "admin\|dashboard\|management"
# Should return no results
```

## Performance Impact

- [ ] No significant performance degradation
- [ ] Database queries optimized
- [ ] No N+1 query problems introduced
- [ ] Bundle size impact considered (for frontend changes)

## Breaking Changes

If this PR introduces breaking changes, please describe:

- What breaks
- Migration path for users
- Documentation updates needed

## Documentation

- [ ] Code comments updated
- [ ] README updated (if needed)
- [ ] API documentation updated (if applicable)
- [ ] Security documentation updated (if security-related)

## Additional Context

Add any other context, screenshots, or information about the pull request here.

---

## For Reviewers

### Security Review Required

- [ ] Authentication/authorization changes reviewed
- [ ] No security regressions introduced
- [ ] Error handling doesn't leak sensitive data
- [ ] All security tests passing
- [ ] Manual security verification completed

### Code Review

- [ ] Code follows project conventions
- [ ] No obvious bugs or issues
- [ ] Performance considerations addressed
- [ ] Tests provide adequate coverage
- [ ] Documentation is clear and accurate

### Final Checks

- [ ] All CI checks passing
- [ ] Security tests passing
- [ ] No merge conflicts
- [ ] Ready for deployment

---

**⚠️ SECURITY NOTICE:** If any security tests fail or if this PR modifies authentication/authorization logic, **DO NOT MERGE** until security issues are resolved and all tests pass.
