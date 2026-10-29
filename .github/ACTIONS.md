# GitHub Actions & Automation

This directory contains GitHub Actions workflows and automation configuration for the Semiont project.

## 🔄 Workflows

### Continuous Integration (`ci.yml`)
The one workflow every pull request runs whole: the lint gates, the map of
changed areas, generated-code drift, the Browser's and every npm package's
suite (each once, with coverage), the Rust workspace's checks, the conformance
suites on binaries built once, the Python projects, the launcher, the
compliance audits, the Browser's and the gateway's security probes, and
Lighthouse. A pull request, the merge queue's commit and a push to `main` run
the jobs whose areas they touched; the nightly schedule, a dispatch and a release's call run every job,
the Windows launcher among them. One job, `CI Gate`, is the check the merge
ruleset requires, and the merge queue merges a pull request once it passes on
the queue's commit of `main` and the pull requests ahead. Each job is listed in
[Testing](../docs/contributor/TESTING.md#continuous-integration).

The security probes are of two routes each. What a running gateway owes on
every operation the spec declares is the gateway conformance suite's to check
(the `gateway-conformance` job).

### CodeQL Security Analysis (`codeql-analysis.yml`)
CodeQL over the TypeScript, Go, Rust and Python, nightly on `main` and when a
release calls it.

### Gateway Crate Advisories (`gateway-advisories.yml`)
**The Rust workspace's crates against RustSec's advisory database**:
- `cargo deny check advisories bans sources`, as `deny.toml` configures it
- An advisory ignored there carries its reason; an ignore that stops matching fails the run
- Crates must come from crates.io, named by a version; a yanked crate fails
- Licences are not checked here: the Gateway Tests job's crate licence gate owns them

### npm Advisories (`npm-advisories.yml`)
**The npm packages the repository ships against GitHub's advisory database**:
- `npm audit --omit=dev` over every tracked lockfile (`.github/scripts/check-npm-advisories.mjs`); a high or critical advisory fails
- An advisory ignored in `.github/npm-advisories.json` carries its reason; an ignore that stops matching fails the run
- A release runs it first: `release.yml` creates no tag until it passes
- Development dependencies are not held here: Dependabot's alerts report those

### Python Image Licences (`python-image-licenses.yml`)
**The licence of every package a Python service image installs from PyPI, before the change is merged**:
- Builds the `builder` stage of each Dockerfile that installs with uv, so the install is the Dockerfile's own, and reads what is in it with the Trivy the publish uses
- `.github/scripts/check-licenses.mjs` over that bill of materials: the gate `publish-service-images.yml` runs when an image is published, against `.github/licenses/allowlist.txt` and `exceptions.txt`
- The images are found, not listed: a new Python image is judged from its first pull request
- The publish still runs the gate: this one runs earlier, not in its place

### Labels (`labels.yml`)
**The repository's labels, made `labels.yml`'s**:
- On a push to main, creates, updates, renames and deletes labels until they are `labels.yml`'s; a label made by hand is deleted by the next sync
- On a pull request, or a branch dispatched by hand, changes nothing: the log is what that file would do
- `crazy-max/ghaction-github-labeler`

### Path Labels (`path-labels.yml`)
**A pull request's `app:`, `image:`, `sdk:`, `tests:` and `spec:` labels, from the files it changes**:
- `.github/scripts/label-pull-request.mjs` adds the label of the app, image, test suite, SDK or part of the spec each changed file is in, by the rule of `scripts/lint/path-labels.mjs`, which `npm run lint:labels` holds `labels.yml` to; a renamed file gives the labels of both its paths
- It only adds: a label put on by hand or by Dependabot stays, and a label the repository does not have is skipped and named
- Runs as `pull_request_target`, so a pull request from Dependabot or a fork can be labelled: the workflow is main's, and it checks out main, never the pull request
- `kind:`, `verb:`, `stack:` and `media:` are the author's to choose

## 🔧 Configuration Files

### Dependabot (`dependabot.yml`)
**Automated dependency updates**, weekly, each ecosystem with its own entry:
- npm: the workspaces (one entry at the root), `tests/e2e`, `tests/conformance`
- Go modules: `apps/launcher`, `packages/go/sdk`
- Cargo: the Rust workspace at the root, `apps/desktop/src-tauri` (each one grouped PR); the Rust toolchain: `rust-toolchain.toml`
- GitHub Actions, and the Docker base images of the Browser and the seven service images; the desktop builder's is a Rust image, which the toolchain entry moves
- A cooldown before a new release is adopted; security updates are not held by it
- `npm run lint:dependabot` (the Census job of `ci.yml`) fails when a tracked manifest has no entry, or an entry names a directory with none
- `npm run lint:rust-toolchain` (the Census job of `ci.yml`) fails when the Rust version is written anywhere but `rust-toolchain.toml`
- `npm run lint:go-toolchain` (the Census job of `ci.yml`) fails when the Go version is written anywhere but a `go.mod`, or the two `go.mod` files pin different toolchains
- `npm run lint:python-version` (the Census job of `ci.yml`) fails when a restatement of the Python SDK's `requires-python` (mypy, pyright, the classifiers, a workflow, a document) says another version
- `npm run lint:node-version` (the Census job of `ci.yml`) fails when a workflow or a script writes a Node version in place of reading `.node-version`, or a `package.json` states another `engines.node` than the root's
- `npm run lint:nats-version` (the Census job of `ci.yml`) fails when the NATS broker's version is written anywhere but the launcher's `go.mod`, or anything but `scripts/ci/install-nats-server.sh` fetches a `nats-server` release
- Each entry's labels are `kind:dependencies` and, when all its directories are in one app, image, test suite or SDK, that one's label; `npm run lint:labels` holds them to that and to `labels.yml`. The Path Labels workflow adds the labels of the files each pull request changes

### Labels (`labels.yml`)
**Every label the repository has**, each a name, a colour and a description:
- A label is `<dimension>:<value>`: `kind:` (what a change or issue is), `verb:` (the eight verbs), `app:` (one for each directory under `apps/`), `image:` (one for each directory under `images/`), `sdk:` (one for each language), `stack:` (one for each kind of document in a knowledge base's `.semiont/stack/`), `spec:` (the parts of `specs/src/`, by who honours them: `protocol`, `sdk`, `services`, `launcher`), `media:` (kinds of content) and `tests:` (one for each directory under `tests/`)
- Its colour says what it is: each `kind:` its own, bold, as GitHub's are; every other dimension one pale hue of its own, but `verb:`, one shade for each of the three ways the verbs work on the corpus (writing, reading, attention)
- Three are of no dimension: `good first issue` and `help wanted`, which GitHub reads by those names, and `Ontology`
- `from_name` renames a label in place, so what it is on keeps it; it is deleted once the sync has run
- `npm run lint:labels` (Census) fails when an entry is not a label GitHub can hold, a label is of no dimension and not listed, `app:`, `image:`, `tests:`, `verb:` or `stack:` disagrees with the directories, the client surface's namespaces or the stack schemas' kinds, an entry of `specs/src/` is in no `spec:` part or in two, an SDK has no `sdk:`, or a Dependabot entry applies another label than its directories give it

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

## 🛡️ Security Workflow Details

### Environment Setup
- **Browser job**: the Node `.node-version` names, with the npm cache
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
echo "$response" | grep -qE "sk-ant-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{10,}\.eyJ"
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
   cd images/browser && npm run test:security
   (cd packages/rust && cargo build --release -p semiont-gateway) && (cd tests/conformance && npm run test:gateway)
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