# Published Artifacts

This document describes all published artifacts from the Semiont project, including npm packages and container images.

## Overview

Semiont publishes **6 artifacts** across two registries:

- **3 npm packages** on npmjs.org
- **3 container images** on GitHub Container Registry (ghcr.io)

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

**Workflow:** [.github/workflows/publish-api-client.yml](../.github/workflows/publish-api-client.yml)

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

**Workflow:** [.github/workflows/publish-core.yml](../.github/workflows/publish-core.yml)

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

**Workflow:** [.github/workflows/publish-cli.yml](../.github/workflows/publish-cli.yml)

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
  -e NEXT_PUBLIC_API_URL=http://localhost:4000 \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_SECRET=your-secret-min-32-chars \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

**Required Environment Variables:**
- `NEXT_PUBLIC_API_URL` - Backend API URL
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
      NEXT_PUBLIC_API_URL: http://localhost:4000
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

This command syncs all `package.json` files to match `version.json`, and automatically updates peer dependencies in `@semiont/cli` to prevent version conflicts during publishing.

### Release Workflow

#### Stable Releases (Automated)

**Three-step release process** (recommended for long-running workflows):

```bash
# Step 1: Verify version sync and trigger stable release workflows
npm run release:step1 patch   # or minor/major

# Output: Command to run step 2 with workflow run IDs

# Step 2: Monitor workflows until completion
npm run release:step2 <runIds> patch

# Output: Command to run step 3

# Step 3: Bump version and commit
npm run release:step3 patch
```

**Each step is resumable** - if you close your laptop or lose connection during step 2, you can re-run it with the same parameters. Each step outputs the exact command needed for the next step.

**Single-command release** (for short workflows or when you can monitor):

```bash
# Interactive mode (prompts for version bump type)
npm run release:stable

# Specify version bump type
npm run release:stable patch   # 0.2.1 → 0.2.2
npm run release:stable minor   # 0.2.1 → 0.3.0
npm run release:stable major   # 0.2.1 → 1.0.0

# Dry run to preview
npm run release:stable -- --dry-run
```

**The release process:**
1. Verifies all versions are in sync
2. Publishes current version as stable release (all 5 artifacts)
3. Waits for all workflows to complete (10-20 minutes for container builds)
4. Bumps version for next development cycle
5. Commits and pushes changes to main

**Manual workflow triggers** (if needed):
```bash
# Publish individual artifacts as stable releases
gh workflow run publish-api-client.yml --field stable_release=true
gh workflow run publish-core.yml --field stable_release=true
gh workflow run publish-cli.yml --field stable_release=true
gh workflow run publish-backend.yml --field stable_release=true
gh workflow run publish-frontend.yml --field stable_release=true
```

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
gh workflow run publish-api-client.yml
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
