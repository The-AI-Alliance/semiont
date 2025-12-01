# Development Environment Configuration

## Switching Between Development and Production Modes

The Semiont CLI uses the `SEMIONT_ENV` environment variable to determine which configuration to use. Two environments are pre-configured:

### 1. `local` (Development Mode - Default)
- **File**: `.devcontainer/environments-local.json`
- **devMode**: `true`
- **Behavior**:
  - `semiont publish` → Skips builds (fast)
  - `semiont start` → Runs `npm run dev` (hot-reload)
- **Best for**: Fast iteration during development

### 2. `local-production` (Production Mode)
- **File**: `.devcontainer/environments-local-production.json`
- **devMode**: `false`
- **Behavior**:
  - `semiont publish` → Runs `npm run build` (validates production builds)
  - `semiont start` → Runs `npm start` (optimized builds)
- **Best for**: Testing production builds locally, catching build errors early

## How to Switch Environments

### Option 1: Change devcontainer.json (Persistent)

Edit `.devcontainer/devcontainer.json`:

```json
{
  "containerEnv": {
    "SEMIONT_ENV": "local-production"  // Change from "local" to "local-production"
  }
}
```

Then rebuild the devcontainer.

### Option 2: Set Environment Variable (Temporary)

In your terminal:

```bash
export SEMIONT_ENV=local-production
./devcontainer/make-meaning.sh
```

### Option 3: Add to .bashrc (Session-based)

Add to `/home/node/.bashrc`:

```bash
export SEMIONT_ENV=local-production
```

## Manual Workflow Examples

### Development Workflow (Fast)
```bash
export SEMIONT_ENV=local
semiont provision --service backend
semiont provision --service frontend
semiont publish --service backend    # Returns immediately
semiont publish --service frontend   # Returns immediately
semiont start --service backend      # npm run dev
semiont start --service frontend     # npm run dev
```

### Production Workflow (Validates Builds)
```bash
export SEMIONT_ENV=local-production
semiont provision --service backend
semiont provision --service frontend
semiont publish --service backend    # npm run build
semiont publish --service frontend   # npm run build
semiont start --service backend      # npm start
semiont start --service frontend     # npm start
```

## Current Environment

Check your current environment:

```bash
echo $SEMIONT_ENV
```

View the active configuration:

```bash
cat $SEMIONT_ROOT/environments/$SEMIONT_ENV.json
```
