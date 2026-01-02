# GitHub Actions & Automation

This directory contains GitHub Actions workflows and automation configuration for the Semiont project.

## 🔄 Workflows

### Security Tests (`security-tests.yml`)
**Primary security testing workflow** that runs on every push and PR:

**Frontend Security Testing**:
- ✅ Runs comprehensive security test suites
- ✅ Builds and starts the application
- ✅ Verifies admin routes return 200 (not 307 redirects)
- ✅ Confirms no admin content leakage in unauthorized responses
- ✅ Validates proper "Access Denied" messages
- ✅ Checks for sensitive data patterns in responses

**Backend Security Testing**:
- ✅ Tests API authentication enforcement
- ✅ Verifies admin endpoints require proper authorization
- ✅ Confirms error responses don't leak sensitive data
- ✅ Validates proper JSON error formats
- ✅ Uses test PostgreSQL database

**Security Verification Checks**:
```bash
# Frontend verification
curl -I http://localhost:3000/admin  # Must return 200, not 307
curl -s http://localhost:3000/admin | grep -i "admin\|dashboard"  # Must return empty

# Backend verification  
curl http://localhost:3001/api/admin/users  # Must return 401
curl -H "Authorization: Bearer invalid" http://localhost:3001/api/admin/users  # Must return 401
```

### Continuous Integration (`ci.yml`)
**General testing and building workflow**:
- Frontend: Tests, linting, type-checking, building
- Backend: Tests, type-checking, building with PostgreSQL
- CDK: Infrastructure tests and synthesis
- Scripts: TypeScript compilation and validation

### CodeQL Analysis (`codeql-analysis.yml`)
**Automated security code scanning**:
- Runs on push, PR, and weekly schedule
- Analyzes JavaScript/TypeScript code for security vulnerabilities
- Uses enhanced security queries for better coverage
- Uploads results to GitHub Security tab

## 🔧 Configuration Files

### Dependabot (`dependabot.yml`)
**Automated dependency updates**:
- Weekly dependency updates for all npm packages
- Separate configurations for frontend, backend, CDK, scripts
- Security-focused updates with proper labeling
- Automatic PR creation for dependency updates

### CodeQL Config (`codeql/codeql-config.yml`)
**Enhanced security analysis configuration**:
- Security-extended and security-and-quality queries
- Focuses on source code directories, excludes test files
- Custom query filters for security-relevant findings

## 📋 Templates

### Pull Request Template (`pull_request_template.md`)
**Comprehensive PR checklist** with security focus:
- **Security Checklist**: Authentication, authorization, information disclosure
- **Testing Requirements**: Security tests, manual verification
- **Admin Route Security**: Specific checks for admin functionality  
- **API Security**: Backend endpoint protection verification
- **Reviewer Guidelines**: Security review requirements

### Security Issue Template (`ISSUE_TEMPLATE/security_vulnerability.yml`)
**Structured security vulnerability reporting**:
- Severity classification (Low → Critical)
- Component identification (Frontend, Backend, Auth, etc.)
- Detailed impact assessment
- Reproduction steps and evidence
- Security test integration

## 🚀 Workflow Triggers

### Security Tests
```yaml
# Runs on:
- push: [main, develop]
- pull_request: [main, develop]  
- paths: apps/frontend/**, apps/backend/**
- workflow_dispatch: # Manual trigger
```

### CI Tests
```yaml  
# Runs on:
- push: [main, develop]
- pull_request: [main, develop]
- workflow_dispatch: # Manual trigger
```

### CodeQL Analysis
```yaml
# Runs on:
- push: [main, develop]
- pull_request: [main, develop]
- schedule: "0 6 * * 1" # Weekly Monday 6 AM UTC
- workflow_dispatch: # Manual trigger
```

## 🛡️ Security Workflow Details

### Environment Setup
Both frontend and backend security tests use:
- **Node.js 20**: Latest LTS version
- **PostgreSQL 15**: Test database for backend
- **Environment Variables**: Test credentials and configuration
- **Dependency Caching**: npm cache for faster builds

### Test Environment Variables
```bash
# Frontend
SERVER_API_URL=http://localhost:3001
NEXT_PUBLIC_SITE_NAME=Semiont Test
NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=example.com

# Backend  
DATABASE_URL=postgresql://testuser:testpassword@localhost:5432/testdb
JWT_SECRET=test-secret-for-ci
GOOGLE_CLIENT_ID=test-client-id
GOOGLE_CLIENT_SECRET=test-client-secret
```

### Security Verification Commands
The workflows run these security checks:

**Frontend Admin Route Security**:
```bash
# Check status code (must be 200, not 307)
status_code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/admin)

# Check for admin content leakage
response=$(curl -s http://localhost:3000/admin)
echo "$response" | grep -qi "admin.*dashboard\|user.*management"

# Verify access denied message
echo "$response" | grep -q "Access Denied"

# Check for sensitive data patterns
echo "$response" | grep -qE "postgresql://|sk_[a-zA-Z0-9]+|@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
```

**Backend API Security**:
```bash
# Test authentication requirement
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/admin/users  # Must be 401

# Test invalid token handling  
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid" http://localhost:3001/api/admin/users  # Must be 401

# Check error response format
response=$(curl -s http://localhost:3001/api/admin/users)
echo "$response" | grep -q '"error".*"Unauthorized"'
```

## 📊 Security Reporting

### Workflow Status
Each security workflow generates a detailed status report:
- ✅ **PASSED**: All security checks successful
- ❌ **FAILED**: Security vulnerabilities detected

### Coverage Reports
- **Test Coverage**: Uploaded to Codecov with security test focus
- **Security Findings**: CodeQL results available in Security tab
- **Workflow Summary**: Detailed results in GitHub Actions summary

### Failure Handling
If security tests fail:
1. **Workflow fails immediately** - prevents merging
2. **Detailed error messages** show specific security issues
3. **Summary report** indicates which checks failed
4. **PR status check** blocks merge until fixed

## 🔐 Security Best Practices

### For Developers
1. **Run security tests locally** before pushing:
   ```bash
   cd apps/frontend && npm run test:security
   cd apps/backend && npm run test:security
   ```

2. **Check admin route behavior** manually:
   ```bash
   npm run dev  # Start development server
   curl -I http://localhost:3000/admin  # Should be 200, not 307
   ```

3. **Review security checklist** in PR template
4. **Test with different user roles** (unauthenticated, non-admin, admin)

### For Reviewers
1. **Verify all security tests pass** in CI
2. **Review security checklist** in PR description
3. **Manual testing** for authentication changes
4. **Code review** focusing on security implications

## 🚨 Emergency Procedures

### Security Vulnerability Response
1. **Critical Issues**: Immediate hotfix workflow
2. **High/Medium Issues**: Priority fix in next release
3. **Low Issues**: Addressed in regular development cycle

### Workflow Failure Response
1. **Security test failures**: Block all merges until resolved
2. **CI test failures**: Fix required but may allow merge with approval
3. **CodeQL alerts**: Review and address based on severity

## 📈 Monitoring & Metrics

### Key Metrics Tracked
- **Security test pass rate** (target: 100%)
- **CodeQL findings trend** (target: decreasing)
- **Dependency vulnerability count** (target: 0 high/critical)
- **Security issue response time** (target: <24h for critical)

### Alerts & Notifications
- **Failed security tests**: Immediate notification
- **New CodeQL findings**: Weekly summary
- **Dependency vulnerabilities**: Daily check
- **Security issue reports**: Immediate triage

---

## 🎯 Summary

This GitHub Actions setup provides **comprehensive security automation** including:

- **Automated Security Testing**: Prevents security regressions
- **Code Security Analysis**: Identifies potential vulnerabilities  
- **Dependency Management**: Keeps dependencies secure and updated
- **Process Enforcement**: Security checklists and templates
- **Continuous Monitoring**: Regular security assessments

**The system is designed to catch security issues early and prevent them from reaching production.**