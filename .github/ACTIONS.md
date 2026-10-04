# GitHub Actions & Automation

This directory contains GitHub Actions workflows and automation configuration for the Semiont project.

## 🔄 Workflows

### Security Tests (`security-tests.yml`)
Runs on every push and pull request to `main` and `develop`. Its three jobs are
required status checks, so the workflow carries no `paths:` filter.

**Browser** (`browser-security`):
- Runs `npm run test:security` (the session gates, the locale layout, validation) and `npm run test:coverage` in `apps/browser`
- Builds the Browser, serves it, and probes `/moderate` and its sub-routes: each answers 200 with the SPA shell
- Fails if the shell carries moderation content or a secret-shaped string

**Gateway** (`gateway-security`):
- Builds the gateway and starts it on a configuration document written for the run
- `/api/status` and `/api/resources/does-not-exist` answer 401 with no credential and to a token that does not verify
- The 401 body is the JSON error shape, and carries no secret, stack trace or source path

These are probes of two routes. What a running gateway owes on every operation
the spec declares is the gateway conformance suite's to check (the
`gateway-conformance` job of `ci.yml`).

### Continuous Integration (`ci.yml`)
The Browser's suite, the Rust workspace's checks, the three conformance suites,
the package build, generated-code drift and the launcher's suites. Each job is
listed in [Testing](../docs/contributor/TESTING.md#continuous-integration).

### Gateway Crate Advisories (`gateway-advisories.yml`)
**The Rust workspace's crates against RustSec's advisory database**:
- `cargo deny check advisories bans sources`, as `deny.toml` configures it
- An advisory ignored there carries its reason; an ignore that stops matching fails the run
- Crates must come from crates.io, named by a version; a yanked crate fails
- Licences are not checked here: the Gateway Tests job's crate licence gate owns them

### CodeQL Analysis (`codeql-analysis.yml`)
**Automated security code scanning**:
- Runs on push, PR, and weekly schedule
- Analyzes the TypeScript, Go and Rust code
- Runs the `security-and-quality` query suite
- Uploads results to GitHub Security tab

## 🔧 Configuration Files

### Dependabot (`dependabot.yml`)
**Automated dependency updates**, weekly, each ecosystem with its own entry:
- npm: the workspaces (one entry at the root), `tests/e2e`, `tests/conformance`
- Go modules: `apps/launcher`, `packages/sdk-go`
- Cargo: the Rust workspace at the root, `apps/desktop/src-tauri` (each one grouped PR); the Rust toolchain: `rust-toolchain.toml`
- GitHub Actions, and the Docker base images of the Browser, the desktop builder and the seven service images
- A cooldown before a new release is adopted; security updates are not held by it
- `npm run lint:dependabot` (Architecture Compliance) fails when a tracked manifest has no entry, or an entry names a directory with none

### CodeQL Config (`codeql/codeql-config.yml`)
**The analysis configuration**:
- The `security-and-quality` queries, which include `security-extended`
- Scans the source directories of the apps and packages; excludes tests and build output
- Query filters keep findings tagged for security, reliability, correctness and maintainability

## 📋 Templates

### Pull Request Template (`pull_request_template.md`)
What a pull request states: the type of change, the areas changed, the suites
run, breaking changes and documentation. Its Security section applies to a
change that touches the gateway's routes, token handling or the Browser's
session code.

## 🚀 Workflow Triggers

### Security Tests
```yaml
# Runs on:
- push: [main, develop]
- pull_request: [main, develop]
- workflow_dispatch: # Manual trigger
```

### CI Tests
```yaml  
# Runs on:
- push: [main, develop]
- pull_request: [main, develop]
- workflow_dispatch: # Manual trigger
```

### Gateway Crate Advisories
```yaml
# Runs on:
- pull_request: # changes to apps/gateway's Cargo.toml, Cargo.lock or deny.toml, or the workflow
- schedule: "0 6 * * *" # Daily 6 AM UTC: the advisory database changes without a commit
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
- **Browser job**: Node.js 24, with the npm cache
- **Gateway job**: the Rust toolchain `rust-toolchain.toml` pins, with the cargo cache

Neither job starts a database or an issuer. The gateway holds no database, and
people authenticate at the knowledge base's issuer, never at the gateway; the
probes send no valid token, so no issuer has to answer.

### Test Environment Variables
```bash
# Browser
NODE_OPTIONS=--max-old-space-size=4096

# Gateway
JWT_SECRET=test-secret-key-for-testing-32char   # the gateway refuses a key under 32 characters
SEMIONT_OIDC_CLIENT_ID=semiont-gateway          # the gateway's own service account; boot refuses without it
SEMIONT_OIDC_CLIENT_SECRET=test-gateway-client-secret
```

### Security Verification Commands
The workflows run these security checks:

**Browser moderate-route security**:
```bash
# This is a Vite SPA: the server returns 200 + index.html for every route, so
# 200 is the expected answer and proves nothing on its own. What the probe
# checks is that the shell carries no server-rendered content and no secrets.
status_code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/moderate)

response=$(curl -s http://localhost:3000/moderate)
echo "$response" | grep -qE "postgresql://|sk_[a-zA-Z0-9]+|DELETE|admin@"
```

**Gateway API Security**:
```bash
# Test authentication requirement
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/status  # Must be 401

# Test invalid token handling
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid-token" http://localhost:4000/api/status  # Must be 401

# Check error response format
response=$(curl -s http://localhost:4000/api/status)
echo "$response" | grep -q '"error".*"Unauthorized"'
```

## 📊 Security Reporting

### Workflow Status
The `security-report` job writes a summary of the two jobs above:
- ✅ **PASSED**: every check in the job passed, listed by what it checked
- ❌ **FAILED**: a step of the job failed; its log says which

### Coverage Reports
- **Test Coverage**: the Browser's coverage, uploaded to Codecov under the `browser` flag
- **Security Findings**: CodeQL results available in Security tab
- **Workflow Summary**: the report above, in the GitHub Actions summary

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
   cd apps/browser && npm run test:security
   cargo build --release -p semiont-gateway && (cd tests/conformance && npm run test:gateway)
   ```

2. **Complete the Security section** of the PR template when the change touches the gateway's routes, token handling or the Browser's session code

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