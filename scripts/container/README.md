# scripts/container — Container Image Management

Build and manage Semiont container images. Auto-detects Apple Container, Docker,
or Podman (in that order). Override with `CONTAINER_RUNTIME=docker` (or `podman`).

## Scripts

| Script | Purpose |
|--------|---------|
| `build-images.js` | Build container images for backend/frontend |
| `container-utils.js` | List and clean semiont container images |

## Usage

```bash
npm run container:build           # Build all images
npm run container:build:backend   # Build backend only
npm run container:build:frontend  # Build frontend only
npm run container:images          # List semiont images
npm run container:clean           # Remove semiont images
```

Prefix with `docker:` or `podman:` to force a specific runtime:

```bash
npm run docker:build
npm run podman:build
```
