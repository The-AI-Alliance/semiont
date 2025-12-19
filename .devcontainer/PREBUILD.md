# Devcontainer Pre-build Optimization Plan

## Problem Statement

Creating a new Codespace currently takes ~10 minutes:
- **3-5 minutes**: Installing devcontainer features (Node, Git, Docker-in-Docker, GitHub CLI)
- **2-3 minutes**: Building/pulling base image
- **X minutes**: Running `.devcontainer/make-meaning.sh` script

**Goal**: Reduce the first 5-8 minutes by pre-building an image with all features and dependencies installed.

## Current Architecture Issues

### What We Have Now
- `docker-compose.yml`: Runs PostgreSQL in a separate container
- `devcontainer.json`: References docker-compose, installs features on every start
- Features are installed fresh on each Codespace creation (slow)

### Problems
1. **docker-compose complexity**: Two containers (app + db) makes pre-building difficult
2. **Features not pre-installed**: Node, Git, Docker-in-Docker, GitHub CLI install on every start
3. **devcontainers/ci action conflicts**: Struggles with docker-compose + image override pattern

## Proposed Solution

### 1. Single Container with PostgreSQL Inside

**Replace docker-compose with PostgreSQL installed directly** in the devcontainer:

```dockerfile
# Install PostgreSQL inside the devcontainer
RUN apt-get update && apt-get install -y postgresql-16 \
    && rm -rf /var/lib/apt/lists/*

# Configure PostgreSQL to start automatically
RUN echo "#!/bin/bash\nservice postgresql start" > /usr/local/bin/start-postgres.sh \
    && chmod +x /usr/local/bin/start-postgres.sh
```

**Benefits**:
- ✅ Simpler architecture (one container instead of two)
- ✅ Easier to pre-build and distribute
- ✅ No docker-compose networking complexity
- ✅ Faster startup (no container orchestration overhead)
- ✅ PostgreSQL still available at `localhost:5432` (no environment config changes needed)

**Important**: The database platform in `environments-local.json` remains `"type": "external"` so `semiont provision --service database` is NOT run. PostgreSQL is installed and started by the devcontainer, but managed externally to the `semiont` CLI workflow.

### 2. Pre-built Image with Features

Create a **Dockerfile** that includes:

- Base: `mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm`
- PostgreSQL 16 installed and configured
- All devcontainer features pre-installed via the build process
- **NOT included**: `npm install`, `semiont` commands, or any workspace-specific setup (these depend on mounted repo code)

**Workflow** (`.github/workflows/devcontainer-prebuild.yml`):
- Builds the Dockerfile with all features
- Pushes to `ghcr.io/The-AI-Alliance/semiont/devcontainer:latest`
- Triggers on:
  - Push to main (when devcontainer config changes)
  - Weekly schedule (to keep base image fresh)
  - Manual workflow dispatch

### 3. Use Pre-built Image in Codespaces

Update **devcontainer.json** to:
```json
{
  "image": "ghcr.io/The-AI-Alliance/semiont/devcontainer:latest",
  "postCreateCommand": "sudo service postgresql start && bash .devcontainer/make-meaning.sh"
}
```

No docker-compose, no feature installation on startup - just pull the pre-built image and go.

## Expected Time Savings

### Before (Current)
```
Start Codespace
  → Pull base image (1 min)
  → Start docker-compose (1 min)
  → Install Node feature (1 min)
  → Install Git feature (30 sec)
  → Install Docker-in-Docker (2 min)
  → Install GitHub CLI (30 sec)
  → Run make-meaning.sh (X min)
Total: ~6 min + make-meaning.sh time
```

### After (With Pre-build)
```
Start Codespace
  → Pull pre-built image (~1 min, features already installed)
  → Start PostgreSQL (10 sec)
  → Run make-meaning.sh (X min)
Total: ~1 min + make-meaning.sh time
```

**Savings: ~5 minutes per Codespace creation**

## Why NOT Pre-run npm install or semiont commands?

These operations depend on the workspace repository being mounted, which doesn't happen until the container starts:

- **`npm install`**: Requires `/workspace` to be mounted with `package.json` and lockfile
- **`semiont` commands**: Require the repository code to be present and built
- **Environment-specific config**: The `semiont` CLI uses environment files that may be modified per-user

The pre-built image is the **container environment only**, not the workspace. Time savings come from pre-installing system packages and features, not from pre-running project setup.

## Implementation Status

✅ **COMPLETED** - Pre-build optimization has been implemented.

### Changes Made

#### 1. New Dockerfile with PostgreSQL
**File**: `.devcontainer/Dockerfile`

- Based on `mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm`
- Installs PostgreSQL 16 and configures it
- Creates `semiont` database and user with credentials `semiont/semiont`
- Includes startup script at `/usr/local/bin/start-postgres.sh`
- Pre-installs build tools (build-essential, python3)

#### 2. Updated devcontainer.json
**File**: `.devcontainer/devcontainer.json`

**Removed**:
- `dockerComposeFile` reference
- `service` property

**Added**:
- `image`: Points to pre-built image `ghcr.io/The-AI-Alliance/semiont/devcontainer:latest`
- `build`: Fallback to build from Dockerfile if image not available
- `onCreateCommand`: Starts PostgreSQL automatically

**Result**: No more docker-compose - single container with PostgreSQL inside

#### 3. Updated Build Configuration
**File**: `.devcontainer/devcontainer.build.json`

- Updated for workflow builds
- Features (Node, Docker-in-Docker, Git, GitHub CLI) baked into image
- Added `containerEnv` with DATABASE_URL

#### 4. Updated Workflow
**File**: `.github/workflows/devcontainer-prebuild.yml`

- Builds using `devcontainer.build.json`
- Pushes to `ghcr.io/The-AI-Alliance/semiont/devcontainer:latest`
- Runs validation checks (node, npm, postgres, git, gh, docker)

#### 5. docker-compose.yml Status
**File**: `.devcontainer/docker-compose.yml`

- Still exists but **no longer used** by devcontainer.json
- Can be safely deleted
- PostgreSQL now runs inside the main container

## Trade-offs

### Pros
- ✅ 5+ minute faster startup
- ✅ Simpler architecture
- ✅ More reliable (fewer moving parts)
- ✅ Better developer experience

### Cons
- ❌ Weekly rebuilds needed to keep image fresh
- ❌ Image stored in GHCR (uses package storage quota)
- ❌ Initial workflow build takes ~10 minutes
- ❌ Changes to devcontainer config require waiting for rebuild

## How It Works

### First-Time Setup (Workflow Build)

```text
GitHub Actions workflow triggers
  → Reads .devcontainer/devcontainer.build.json
  → Builds Dockerfile with PostgreSQL + features
  → Pushes image to ghcr.io/The-AI-Alliance/semiont/devcontainer:latest
  → Takes ~10 minutes (one-time cost)
```

### Every Codespace Creation

```text
User creates new Codespace
  → Pulls ghcr.io/The-AI-Alliance/semiont/devcontainer:latest (~1 min)
  → onCreateCommand starts PostgreSQL (~10 sec)
  → postAttachCommand runs prompt-setup.sh
  → User runs make-meaning.sh
Total startup: ~1 min + make-meaning time
```

### Fallback Behavior

If pre-built image doesn't exist or pull fails:

```text
  → Falls back to building from .devcontainer/Dockerfile
  → Features are installed during build
  → Same end result, just slower (like before)
```

## Testing

1. **Merge to main** to trigger the workflow
2. **Wait for workflow** to complete (~10 minutes first time)
3. **Create new Codespace** from main branch
4. **Verify**:
   - Codespace starts in ~1 minute (not ~6 minutes)
   - PostgreSQL is running: `psql -h localhost -U semiont -d semiont`
   - All tools available: `node --version`, `docker --version`, `gh --version`
   - `make-meaning.sh` runs successfully

## Environment Configuration

No changes needed to `environments-local.json` or `environments-local-production.json`:

- Database remains `"type": "external"`
- PostgreSQL available at `localhost:5432`
- Connection string unchanged: `postgresql://semiont:semiont@localhost:5432/semiont`
- `semiont provision --service database` still NOT run (as intended)

## Maintenance

The pre-built image will be rebuilt:

- On every push to main that changes devcontainer config
- Weekly (every Sunday at midnight UTC)
- Manually via workflow dispatch

This keeps the base image and features up-to-date.

## Rollback Plan

If issues arise, revert by:

1. Restore old devcontainer.json with docker-compose reference
2. Delete or disable the workflow
3. Remove the pre-built image from GHCR

The repository will work exactly as before.
