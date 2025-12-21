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

### Version Bump Workflow

#### For Development Builds (automatic)

1. **Bump version in version.json:**
   ```bash
   npm run version:bump minor
   ```

2. **Sync all package.json files:**
   ```bash
   npm run version:sync
   ```

3. **Commit and push:**
   ```bash
   git add version.json packages/*/package.json apps/*/package.json
   git commit -m "bump version to 0.3.0"
   git push
   ```

4. **CI automatically publishes** new versions with `-build.N` suffix

#### For Stable Releases (manual)

1. **Ensure version.json has the desired version** (e.g., `0.2.0`)

2. **Manually trigger workflows** with `stable_release` option:
   ```bash
   # Publish npm packages as stable releases
   gh workflow run publish-api-client.yml --field stable_release=true
   gh workflow run publish-core.yml --field stable_release=true
   gh workflow run publish-cli.yml --field stable_release=true

   # Publish container images as stable releases
   gh workflow run publish-backend.yml --field stable_release=true
   gh workflow run publish-frontend.yml --field stable_release=true

   # Or via GitHub Actions UI:
   # Actions → Select workflow → Run workflow → Check "Stable release"
   ```

3. **Artifacts will be published** as:
   - **NPM packages:**
     - Version: `0.2.0` (no `-build.N` suffix)
     - npm tag: `latest` (instead of `dev`)
   - **Container images:**
     - Version: `0.2.0` (no `-build.N` suffix)
     - Tag: `latest` (instead of `dev`)
     - Also tagged: `sha-{commit}` (commit-specific tag)

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
