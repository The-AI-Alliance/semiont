# Published Artifacts

This document describes all published artifacts from the Semiont project, including npm packages and container images.

## Overview

Semiont publishes **5 artifacts** across two registries:

- **3 npm packages** on npmjs.org
- **2 container images** on GitHub Container Registry (ghcr.io)

All artifacts follow a unified versioning scheme managed through [`version.json`](../version.json).

---

## NPM Packages

Published to the public npm registry at [npmjs.org](https://www.npmjs.com/settings/semiont/packages).

### 1. @semiont/api-client

[![npm](https://img.shields.io/npm/v/@semiont/api-client)](https://www.npmjs.com/package/@semiont/api-client)

**Description:** TypeScript client SDK with types generated from OpenAPI spec

**Installation:**
```bash
npm install @semiont/api-client
```

**Install latest development build:**
```bash
npm install @semiont/api-client@dev
```

**Documentation:** [packages/api-client/README.md](../packages/api-client/README.md)

**Source:** [packages/api-client/](../packages/api-client/)

**Workflow:** [.github/workflows/publish-npm-packages.yml](../.github/workflows/publish-npm-packages.yml)

---

### 2. @semiont/core

[![npm](https://img.shields.io/npm/v/@semiont/core)](https://www.npmjs.com/package/@semiont/core)

**Description:** Core domain types and utilities for Semiont - Document, Annotation, and Graph models

**Installation:**
```bash
npm install @semiont/core
```

**Install latest development build:**
```bash
npm install @semiont/core@dev
```

**Documentation:** [packages/core/README.md](../packages/core/README.md)

**Source:** [packages/core/](../packages/core/)

**Workflow:** [.github/workflows/publish-npm-packages.yml](../.github/workflows/publish-npm-packages.yml)

---

### 3. @semiont/cli

[![npm](https://img.shields.io/npm/v/@semiont/cli)](https://www.npmjs.com/package/@semiont/cli)

**Description:** Command-line interface for managing Semiont environments and deployments

**Installation:**
```bash
npm install -g @semiont/cli
```

**Install latest development build:**
```bash
npm install -g @semiont/cli@dev
```

**Documentation:** [apps/cli/README.md](../apps/cli/README.md)

**Source:** [apps/cli/](../apps/cli/)

**Workflow:** [.github/workflows/publish-npm-packages.yml](../.github/workflows/publish-npm-packages.yml)

---

## Container Images

Published to GitHub Container Registry at [ghcr.io](https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont).

### 1. semiont-backend

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend)

**Description:** Backend API server with multi-platform support (amd64, arm64)

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Run container:**
```bash
docker run -d \
  -p 4000:4000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db \
  -e JWT_SECRET=your-secret-key-min-32-chars \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Required Environment Variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret for JWT token signing (min 32 characters)

**Optional Environment Variables:**
- `PORT` - Server port (default: 4000)
- `NODE_ENV` - Environment mode (default: production)
- `CORS_ORIGIN` - CORS allowed origins

**Documentation:** [apps/backend/README.md](../apps/backend/README.md)

**Source:** [apps/backend/](../apps/backend/)

**Dockerfile:** [apps/backend/Dockerfile](../apps/backend/Dockerfile)

**Workflow:** [.github/workflows/publish-backend.yml](../.github/workflows/publish-backend.yml)

---

### 2. semiont-frontend

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)

**Description:** Next.js frontend application with multi-platform support (amd64, arm64)

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Run container:**
```bash
docker run -d \
  -p 3000:3000 \
  -e SERVER_API_URL=http://localhost:4000 \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_SECRET=your-secret-min-32-chars \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Required Environment Variables:**
- `SERVER_API_URL` - Backend API URL
- `NEXTAUTH_URL` - Frontend URL for NextAuth callbacks
- `NEXTAUTH_SECRET` - Secret for NextAuth session encryption (min 32 characters)

**Optional Environment Variables:**
- `NEXT_PUBLIC_SITE_NAME` - Site name displayed in UI (default: "Semiont")
- `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` - Comma-separated list of allowed OAuth domains

**Documentation:** [apps/frontend/README.md](../apps/frontend/README.md)

**Source:** [apps/frontend/](../apps/frontend/)

**Dockerfile:** [apps/frontend/Dockerfile](../apps/frontend/Dockerfile)

**Workflow:** [.github/workflows/publish-frontend.yml](../.github/workflows/publish-frontend.yml)

---

### 3. Docker Compose Example

Run both backend and frontend together:

```yaml
version: '3.8'
services:
  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    ports:
      - "4000:4000"
    environment:
      DATABASE_URL: postgresql://postgres:password@db:5432/semiont
      JWT_SECRET: your-secret-key-minimum-32-characters-long
      CORS_ORIGIN: http://localhost:3000
    depends_on:
      - db

  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:dev
    ports:
      - "3000:3000"
    environment:
      SERVER_API_URL: http://localhost:4000
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: your-secret-minimum-32-characters-long
      NEXT_PUBLIC_SITE_NAME: Semiont
    depends_on:
      - backend

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semiont
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

---

## Versioning

All Semiont artifacts use a **unified versioning system** managed through [`version.json`](../version.json).

### Version Format

**Development builds** (published on every push to main):
- Format: `{VERSION}-build.{RUN_NUMBER}`
- Example: `0.2.0-build.123`
- Tag: `dev` (always points to latest build)

**Stable releases** (manually triggered):
- Format: `{VERSION}`
- Example: `0.2.0`
- Tag: `latest`

**Container-specific tags:**
- `sha-{commit}` - Points to specific git commit
- Examples: `sha-9d532bf`, `sha-8b53d8b`

### Managing Versions

All version management is done through the [`scripts/version.mjs`](../scripts/version.mjs) script.

**Show current versions:**
```bash
npm run version:show
```

**Bump version (patch/minor/major):**
```bash
# Patch: 0.2.0 → 0.2.1
npm run version:bump patch

# Minor: 0.2.0 → 0.3.0
npm run version:bump minor

# Major: 0.2.0 → 1.0.0
npm run version:bump major
```

**Set all packages to same version:**
```bash
npm run version:set all 0.3.0
```

**Set specific package version:**
```bash
npm run version:set semiont-backend 0.2.1
```

**Sync package.json files:**
```bash
npm run version:sync
```

This command syncs all `package.json` files to match `version.json`, and automatically updates `@semiont/api-client` and `@semiont/core` dependency versions in `@semiont/cli` to prevent version conflicts during publishing.

## Development Workflow

This section describes the typical development workflow from feature branch to deployment.

### Happy Path: Feature Development

#### 1. Create Feature Branch

```bash
# Pull latest main
git checkout main
git pull origin main

# Create feature branch
git checkout -b feature/my-feature
```

#### 2. Development

Make changes to code, tests, and documentation:

```bash
# Run tests locally
npm test

# Run type checking
npm run typecheck

# Build packages
npm run build:packages
```

#### 3. Commit Changes

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git add .
git commit -m "feat: add new annotation filter"
# or
git commit -m "fix: resolve memory leak in resource loader"
# or
git commit -m "docs: update deployment guide"
```

#### 4. Push and Create PR

```bash
# Push feature branch
git push origin feature/my-feature

# Create pull request
gh pr create --title "Add new annotation filter" --body "Description of changes"
```

#### 5. CI Checks

GitHub Actions automatically runs:

- **Type checking** - TypeScript compilation
- **Linting** - ESLint validation
- **Tests** - Unit and integration tests
- **Security scans** - CodeQL analysis
- **Build verification** - Ensures all packages build

#### 6. Review and Merge

Once CI passes and reviewers approve:

```bash
# Merge via GitHub UI (squash and merge recommended)
# OR via CLI:
gh pr merge --squash
```

#### 7. Automatic Development Builds

After merge to `main`, GitHub Actions automatically:

- Publishes npm packages with `dev` tag: `{VERSION}-build.{RUN_NUMBER}`
- Builds and publishes container images with `dev` tag
- Updates package registries

#### 8. Verify Deployment

Check that development builds were published:

```bash
# Check npm packages
npm view @semiont/api-client dist-tags

# Check container images
gh run list --workflow=publish-frontend.yml --limit 1
```

#### 9. Bump Version (When Needed)

When you want to change the base version for future development builds:

```bash
# Bump version (choose one: patch, minor, major)
npm run version:bump patch   # 0.2.26 → 0.2.27
# or
npm run version:bump minor   # 0.2.26 → 0.3.0
# or
npm run version:bump major   # 0.2.26 → 1.0.0

# This updates version.json and syncs all package.json files
# Commit and push the version bump
git add version.json packages/*/package.json apps/*/package.json
git commit -m "chore: bump version to X.Y.Z"
git push
```

**When to bump:**

- After a significant feature merge or milestone
- Before starting work on a new major version
- As part of the release process (see below)

Future development builds will use the new version: `X.Y.Z-build.N`

### Release Workflow

#### When to Cut a Stable Release

Cut a stable release when:

- Current development builds (`X.Y.Z-build.N`) are stable and tested
- You want to publish version `X.Y.Z` as a production-ready release
- Example: You've been publishing `0.2.26-build.123`, `0.2.26-build.124`, etc., and want to release `0.2.26` as stable

#### Stable Release Timeline

```text
Before release:  0.2.26-build.123 → 0.2.26-build.124 → ... (dev builds)
                                                           ↓
Release publish: 0.2.26 (stable, latest tag) ← RELEASE IS CUT HERE
                                                           ↓
After bump:      0.2.27-build.1 → 0.2.27-build.2 → ... (next dev cycle)
```

**The stable release is cut when you run `npm run release:publish`** - this publishes the current version (e.g., `0.2.26`) as stable with the `latest` tag.

**The bump happens AFTER the release** to prepare for the next development cycle (e.g., `0.2.27-build.N`).

#### Three-Step Release Process

**Each step is resumable** - if you close your laptop or lose connection, you can re-run with the same parameters:

```bash
# Step 1: Publish - Verify version sync and trigger stable release workflows
npm run release:publish

# Output: Command to await workflows with run IDs
# This publishes X.Y.Z as stable (THE RELEASE IS CUT HERE)

# Step 2: Await - Monitor workflows until completion
npm run release:await <runIds>

# Output: Command to bump version
# Waits for all 5 artifacts to publish (10-20 minutes for containers)

# Step 3: Bump - Bump version for next development cycle
npm run release:bump patch   # or minor/major

# This prepares for the NEXT release cycle
# Future dev builds will be X.Y.(Z+1)-build.N
```

**What each step does:**

1. **Publish** - Publishes current version as stable release
   - Example: Publishes `0.2.26` (without `-build.N`) as stable
   - Tags with `latest` on npm and container registries
   - Triggers GitHub Actions workflows

2. **Await** - Waits for all workflows to complete
   - Monitors 3 workflows (npm packages, backend, frontend)
   - Can be resumed if interrupted
   - Verifies all artifacts published successfully

3. **Bump** - Prepares for next development cycle
   - Example: Bumps `0.2.26` → `0.2.27`
   - Future development builds become `0.2.27-build.1`, `0.2.27-build.2`, etc.
   - Commits and pushes version change to main

**Manual workflow triggers** (if needed):
```bash
# Publish artifacts as stable releases
gh workflow run publish-npm-packages.yml --field stable_release=true
gh workflow run publish-backend.yml --field stable_release=true
gh workflow run publish-frontend.yml --field stable_release=true
```

### Unhappy Paths: Common Issues

#### CI Failures

**Problem:** Tests fail in CI but pass locally

**Common causes:**

- Environment variable differences
- Stale local build cache
- Missing dependencies in CI config

**Resolution:**
```bash
# Clean and rebuild locally
npm run clean
npm install
npm run build:packages
npm test

# If tests pass locally, check CI logs:
gh run view --log-failed

# Fix issues and push:
git add .
git commit -m "fix: resolve CI test failures"
git push
```

#### Type Errors After Dependency Updates

**Problem:** TypeScript errors after updating `@semiont/api-client` or `@semiont/core`

**Resolution:**
```bash
# Regenerate types from OpenAPI spec
npm run openapi:bundle
cd packages/api-client && npm run generate

# Rebuild all packages
npm run build:packages

# Update calling code to match new types
# Then commit changes
```

#### Version Sync Issues

**Problem:** CI fails with "Version mismatch" error

**Resolution:**
```bash
# Check version status
npm run version:show

# Sync all package.json files to version.json
npm run version:sync

# Commit synchronized versions
git add version.json packages/*/package.json apps/*/package.json
git commit -m "chore: sync package versions"
git push
```

#### Failed Container Builds

**Problem:** Container image build fails in CI

**Common causes:**

- Missing environment variables in Dockerfile
- Build context issues
- Dependency conflicts

**Resolution:**
```bash
# Test build locally
npm run build:images

# Check build logs:
gh run view --log-failed

# Common fixes:
# 1. Update Dockerfile dependencies
# 2. Clear Docker build cache
# 3. Fix package.json scripts

# Push fix:
git add .
git commit -m "fix: resolve container build failure"
git push
```

#### Merge Conflicts

**Problem:** PR has conflicts with main branch

**Resolution:**
```bash
# Update feature branch with latest main
git checkout main
git pull origin main
git checkout feature/my-feature
git merge main

# Resolve conflicts in your editor
# Then:
git add .
git commit -m "chore: resolve merge conflicts with main"
git push
```

#### Failed Stable Release

**Problem:** `npm run release:publish` fails or workflows fail during release

**Resolution:**

**If publish step fails:**
```bash
# Check what went wrong
npm run release:publish

# Common issues:
# 1. Version not synced - run: npm run version:sync
# 2. Uncommitted changes - commit or stash them
# 3. Not on main branch - checkout main first
```

**If workflows fail during await:**
```bash
# Check workflow status
gh run list --workflow=publish-npm-packages.yml --limit 1
gh run list --workflow=publish-backend.yml --limit 1
gh run list --workflow=publish-frontend.yml --limit 1

# View failed logs
gh run view <run-id> --log-failed

# Fix the issue, then manually re-trigger failed workflow:
gh workflow run publish-backend.yml --field stable_release=true

# Resume await with new run ID:
npm run release:await <npm-run-id>,<new-backend-run-id>,<frontend-run-id>
```

**If version bump fails:**
```bash
# Bump was interrupted - check current state
npm run version:show

# If version was bumped but not committed:
git status
git add version.json packages/*/package.json apps/*/package.json
git commit -m "chore: bump version to X.Y.Z"
git push

# If version was not bumped, retry:
npm run release:bump patch
```

#### Forgot to Bump After Release

**Problem:** Published stable release but forgot to run `npm run release:bump`

**What happens:**

Development builds continue with same base version:
```text
Before release: 0.2.26-build.123 → 0.2.26-build.124
Release:        0.2.26 (stable, latest)
Forgot bump:    0.2.26-build.125 → 0.2.26-build.126 (wrong!)
Should be:      0.2.27-build.1 → 0.2.27-build.2
```

**Impact:**

- **Technical**: No conflicts, builds publish successfully
- **Semantic**: Confusing version numbers - `0.2.26-build.125` appears to lead up to `0.2.26`, but `0.2.26` stable already exists
- **User confusion**: Development builds look older than stable release

**Resolution:**

Simply run the bump when you notice:

```bash
npm run version:bump patch
# Updates version.json to 0.2.27
# Commits and pushes

# Future dev builds become 0.2.27-build.N
```

**Note:** This can be done at any time - there's no harm in running it late, you'll just have some confusingly numbered development builds in the registry.

#### Reverting a Release

**Problem:** Need to revert a published stable release

**NPM packages - use deprecation:**
```bash
# Deprecate broken version
npm deprecate @semiont/api-client@0.2.5 "Broken release, use 0.2.4 or 0.2.6"
npm deprecate @semiont/core@0.2.5 "Broken release, use 0.2.4 or 0.2.6"
npm deprecate @semiont/cli@0.2.5 "Broken release, use 0.2.4 or 0.2.6"

# Release fixed version
npm run version:bump patch
npm run release:publish
```

**Container images - retag:**
```bash
# Cannot delete published images from ghcr.io
# Instead, update 'latest' tag to point to previous good version:
# (This requires manual intervention via GitHub Packages UI or API)

# Then publish new fixed version
npm run release:publish
```

### Best Practices

**Before creating a PR:**

- Run `npm test` locally
- Run `npm run typecheck` to catch type errors
- Run `npm run build:packages` to verify builds
- Review your own changes first

**During PR review:**

- Respond to review comments promptly
- Keep PR scope focused (one feature/fix per PR)
- Ensure CI passes before requesting review

**Before merging:**

- Squash commits into logical units
- Write clear commit messages following Conventional Commits
- Ensure all CI checks pass
- Get at least one approval (if team size permits)

**After merging:**

- Verify development builds published successfully
- Delete feature branch: `git branch -d feature/my-feature`
- Pull latest main: `git checkout main && git pull`

#### Development Builds (Automatic)

Development builds are published automatically on every push to `main`:
- Format: `{VERSION}-build.{RUN_NUMBER}`
- Tags: `dev` (npm), `dev` (containers)
- No manual action required

To change the base version for development builds:
```bash
npm run version:bump minor  # or patch/major
npm run version:sync
git add version.json packages/*/package.json apps/*/package.json
git commit -m "bump version to 0.3.0"
git push
```

### Current Versions

See [`version.json`](../version.json) for the current version of all packages.

To check if package.json files are in sync:
```bash
npm run version:show
```

---

## Publishing

All artifacts are published automatically via GitHub Actions when changes are pushed to the `main` branch.

### NPM Package Publishing

**Triggers:**
- Push to `main` with changes to package source
- Manual workflow dispatch

**Process:**
1. Build package
2. Generate version: `{BASE_VERSION}-build.{RUN_NUMBER}`
3. Publish to npmjs.org with `dev` tag
4. Update latest `dev` tag to point to new version

### Container Image Publishing

**Triggers:**
- Push to `main` with changes to app source
- Manual workflow dispatch

**Process:**
1. Build multi-platform image (amd64, arm64)
2. Generate version: `{BASE_VERSION}-build.{RUN_NUMBER}`
3. Tag with:
   - `dev` (latest development build)
   - `{VERSION}-build.{RUN_NUMBER}` (specific build)
   - `sha-{COMMIT}` (git commit)
4. Push to ghcr.io

### Manual Publishing

All workflows support manual triggering via workflow dispatch with optional dry-run mode:

```bash
# Trigger via GitHub CLI
gh workflow run publish-npm-packages.yml
gh workflow run publish-backend.yml --field dry_run=true
```

---

## Registry Links

- **npm packages:** https://www.npmjs.com/settings/semiont/packages
- **Container images:** https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont
- **GitHub Releases:** https://github.com/The-AI-Alliance/semiont/releases

---

## Support

For issues related to published artifacts:
- **Bug reports:** https://github.com/The-AI-Alliance/semiont/issues
- **Security issues:** See [SECURITY.md](../SECURITY.md)
- **General questions:** https://github.com/The-AI-Alliance/semiont/discussions
