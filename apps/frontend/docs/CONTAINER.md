# Frontend Container Image

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)

Production-ready Docker container images for the Semiont frontend, published to GitHub Container Registry with multi-platform support.

## Quick Start

### Pull Image

```bash
# Latest release
docker pull ghcr.io/the-ai-alliance/semiont-frontend:latest

# Specific @semiont/frontend package version (recommended for production)
docker pull ghcr.io/the-ai-alliance/semiont-frontend:0.5.12

# Specific git commit of the image build (for debugging/pinning)
docker pull ghcr.io/the-ai-alliance/semiont-frontend:sha-0377abc
```

### Run Container

```bash
docker run -d \
  -p 3000:3000 \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:latest
```

Open <http://localhost:3000> and add your knowledge base (protocol, host,
port, then sign in) from the app's connection panel. The container itself
takes no backend configuration — see [Configuration](#configuration).

## Configuration

### Architecture: The Browser Connects, Not the Container

The frontend image is a static file server (`server.js`) for the prebuilt
Vite SPA. It has no backend URL — at build time or at runtime — and it never
proxies API traffic.

Knowledge-base connections are made **in the running app, by the user**:

1. Open the frontend in a browser and add a knowledge base (protocol, host,
   port) from the connection panel.
2. Sign in with email/password for that KB. The SDK (`@semiont/sdk`)
   authenticates against the KB and stores a per-KB access + refresh token
   pair in the browser's `localStorage`.
3. The SPA then talks to that KB origin **directly from the browser** —
   auth, admin, and content over HTTP routes; domain traffic over the event
   bus (`POST /bus/emit`, `GET /bus/subscribe` SSE). Access tokens refresh
   automatically before they expire.

Multiple knowledge bases can be configured side by side, and connections
persist across page reloads. The backend allows cross-origin requests from
any origin, so the only network requirement is that each KB backend is
reachable **from the user's browser** — reachability from the frontend
container is irrelevant. No reverse proxy or path-based routing layer is
needed.

### Environment Variables

The image consumes exactly one runtime variable:

- **`PORT`** — port the static server listens on (default: `3000`)

There are no `SEMIONT_*` runtime variables: the JS bundle is prebuilt when
the `@semiont/frontend` npm package is published, and the static server does
no templating. Backend locations are chosen by users in the app, not by
container configuration.

## Deployment Scenarios

### Docker Compose

```yaml
services:
  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:0.5.12
    ports:
      - "3000:3000"

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:0.5.12
    ports:
      - "4000:4000"   # must be reachable from the user's browser
    # ... backend config (see the backend image docs)
```

The two containers never talk to each other, so no proxy sits between them
and no `depends_on` is needed. The user's browser loads the SPA from
`http://localhost:3000` and connects to the knowledge base by adding
`http` / `localhost` / `4000` in the app's connection panel. Publishing the
backend port to the host is what matters — a browser cannot resolve Compose
service names like `backend`.

### Kubernetes with Ingress Controller

Give the frontend and each knowledge-base backend their own
browser-reachable origins. No path-based API routing is required:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: semiont-frontend
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: frontend
        image: ghcr.io/the-ai-alliance/semiont-frontend:0.5.12
        ports:
        - containerPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: semiont-ingress
spec:
  rules:
  # The SPA — all paths serve static assets
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: semiont-frontend-service
            port:
              number: 3000
  # Each knowledge-base backend gets its own origin
  - host: kb.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: semiont-backend-service
            port:
              number: 4000
```

Users add `https` / `kb.example.com` / `443` in the connection panel; the
browser then calls the backend origin directly (the backend allows
cross-origin requests). Serve backends over HTTPS — a browser will refuse to
call an `http://` knowledge base from an `https://` page (mixed content).

### AWS ECS

Run the frontend and backend as separate services, each with its own
browser-reachable HTTPS endpoint (for example, hostname-based listener rules
on an ALB). The frontend task definition needs **no environment variables**
— there is no backend URL to inject. Users connect to the backend origin
from the app's connection panel, exactly as in the other scenarios.

## Building Custom Images

The image is built from [`apps/frontend/Dockerfile`](../Dockerfile) in the Semiont
repo. It installs the **published `@semiont/frontend` npm package** — it does not
build from source — so the only build arguments are the package version and the
npm registry. The image takes no site-specific configuration: the bundle is
built when the npm package is published, and users pick their knowledge bases
in the app.

```bash
# From the semiont repo root: image pinned to a published package version
docker build \
  --build-arg SEMIONT_FRONTEND_VERSION=0.5.12 \
  -t semiont-frontend:custom \
  -f apps/frontend/Dockerfile .
```

Official images are published (multi-arch, Trivy-scanned, SBOM + provenance
attested) by the `publish-frontend.yml` workflow — prefer
`ghcr.io/the-ai-alliance/semiont-frontend` over local builds unless you are
testing unpublished changes.

### Multi-Platform Builds

```bash
# Build for multiple architectures
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg SEMIONT_FRONTEND_VERSION=0.5.12 \
  -t semiont-frontend:multiarch \
  -f apps/frontend/Dockerfile .
```

## Environment Variable Reference

| Variable | Type | Required | Example | Description |
|----------|------|----------|---------|-------------|
| `SEMIONT_FRONTEND_VERSION` | Build-time | No | `0.5.12` | `@semiont/frontend` npm version to install (default `latest`) |
| `NPM_REGISTRY` | Build-time | No | `https://registry.npmjs.org` | Registry to install from |
| `PORT` | Runtime | No | `3000` | Port the static server listens on (default `3000`) |

## Security Best Practices

### Secrets Management

**Never include secrets in the Docker image** — the frontend needs none. It
takes no configuration beyond `PORT`:

```bash
docker run -d -p 3000:3000 ghcr.io/the-ai-alliance/semiont-frontend:latest

# Backend secrets (GOOGLE_CLIENT_SECRET, JWT signing key, etc.) stay in the backend container
```

Users' knowledge-base tokens exist only in their own browsers' `localStorage`
— they never pass through the frontend container.

### Secret Rotation

The frontend contains no secrets. All sensitive credentials (OAuth client secrets, JWT signing keys) live in the backend container. Rotate them there.

## Troubleshooting

### Cannot connect to a knowledge base

**Problem**: Adding a KB in the connection panel fails with a network error.

**Cause**: The KB backend must be reachable from the **user's browser**, not
from the frontend container.

**Solutions**:
1. Verify the backend is running and exposed on a browser-reachable address.
2. Docker Compose: connect to `localhost:4000` (the host-published port).
   Compose service names like `backend` do not resolve in a browser.
3. Kubernetes/cloud: give the backend its own browser-reachable origin
   (Ingress host or load-balancer endpoint), and connect to that.

### Requests blocked as "mixed content"

**Problem**: The frontend is served over `https://`, but the knowledge base
was added with the `http` protocol — the browser silently blocks the calls.

**Solution**: Serve knowledge-base backends over HTTPS in production and
select `https` when adding the KB.

### Signed out of a knowledge base unexpectedly

**Problem**: A previously connected KB drops to signed-out.

**Cause**: The refresh token expired, or the backend's JWT signing secret
changed (for example, a backend restart that regenerated `JWT_SECRET`),
which invalidates every issued token.

**Solution**: Sign in to that KB again from the connection panel.

## Health Checks

The container includes a built-in health check:

```bash
# Check container health
docker inspect semiont-frontend | jq '.[0].State.Health'

# Manual health check
curl http://localhost:3000/
```

## Logs

```bash
# View container logs
docker logs semiont-frontend

# Follow logs in real-time
docker logs -f semiont-frontend
```

The static server logs a single startup line (`Semiont frontend listening on
port 3000`) plus any server errors; it does not log individual requests.

## Image Tags

Published images follow this tagging strategy:

- **`0.5.12`** - The `@semiont/frontend` npm package version baked into the image (immutable)
- **`sha-0377abc`** - Git commit of the repo at image-publish time (immutable, for debugging)
- **`latest`** - Most recent release (mutable, applied when a publish is marked as latest)

**Recommendation**:
- Development/staging: `latest` is fine
- Production: Pin a specific version tag (e.g., `0.5.12`)

## Architecture Notes

### Connection Flow

```
Browser ── GET https://app.example.com/ ─────────────▶ Frontend container (static SPA)
Browser ── POST https://kb.example.com/api/tokens/… ─▶ KB backend (sign-in, token refresh)
Browser ── POST /bus/emit, GET /bus/subscribe (SSE) ─▶ KB backend (domain traffic)
```

The frontend container serves static assets and is otherwise out of the data
path. Every API call originates in the user's browser and goes straight to
the knowledge-base origin the user configured in the app — across as many
knowledge bases as the user has added.

## Related Documentation

- [Deployment Guide](./DEPLOYMENT.md) - Deployment workflows and strategies
- [Development Guide](./DEVELOPMENT.md) - Local development setup
- [Container Topology](../../../docs/system/CONTAINER-TOPOLOGY.md) - Multi-container deployment architecture
- [Container Images](../../../docs/system/administration/IMAGES.md) - All published images and the backend npm-distribution model

## Support

For issues or questions:

- GitHub Issues: <https://github.com/The-AI-Alliance/semiont/issues>
- Container Registry: <https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend>
- Actions Workflows: <https://github.com/The-AI-Alliance/semiont/actions>

---

**Container Runtime**: Apple Container, Docker, or Podman
**Orchestration**: Compatible with Docker Compose, Kubernetes, ECS
**Base Image**: node:26-alpine
**Platforms**: linux/amd64, linux/arm64
