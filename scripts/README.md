# Semiont Scripts

This directory contains utility scripts for the Semiont project.

## Container Image Management

The scripts automatically detect and use the available container runtime (Docker or Podman).

### Automatic Runtime Detection

```bash
# Build all container images (auto-detects Docker or Podman)
npm run container:build

# Build specific services
npm run container:build:backend
npm run container:build:frontend

# List all Semiont container images
npm run container:images

# Remove all Semiont container images
npm run container:clean
```

### Docker-Specific Commands

```bash
# Force Docker usage
npm run docker:build
npm run docker:build:backend
npm run docker:build:frontend
npm run docker:images
npm run docker:clean
```

### Podman-Specific Commands

```bash
# Force Podman usage
npm run podman:build
npm run podman:build:backend
npm run podman:build:frontend
npm run podman:images
npm run podman:clean
```

### Building with Custom Variables

```bash
# Works with all runtime variants
NEXT_PUBLIC_API_URL=https://api.example.com npm run container:build:frontend
```

## Environment Variables

### Container Runtime Selection

- `CONTAINER_RUNTIME` - Force specific runtime ('docker' or 'podman')
  ```bash
  CONTAINER_RUNTIME=podman npm run container:build
  ```

### Frontend Build Variables

- `NEXT_PUBLIC_API_URL` - API endpoint URL (default: http://localhost:4000)
- `NEXT_PUBLIC_APP_NAME` - Application name (default: Semiont)
- `NEXT_PUBLIC_APP_VERSION` - Application version (default: 1.0.0)

## Runtime Detection Logic

1. If `CONTAINER_RUNTIME` env var is set, use that runtime
2. If npm script name contains 'podman', use Podman
3. If npm script name contains 'docker', use Docker
4. Otherwise, auto-detect: try Docker first, then Podman
5. If neither is available, show error message