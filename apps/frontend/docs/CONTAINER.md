# Frontend Container Image

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)

Production-ready Docker container images for the Semiont frontend, published to GitHub Container Registry with multi-platform support.

## Quick Start

### Pull Image

```bash
# Latest development build (recommended for testing)
docker pull ghcr.io/the-ai-alliance/semiont-frontend:dev

# Specific version (recommended for production)
docker pull ghcr.io/the-ai-alliance/semiont-frontend:0.2.26-build.123

# Specific commit SHA (for debugging/pinning)
docker pull ghcr.io/the-ai-alliance/semiont-frontend:sha-0377abc
```

### Run Container

**With Path-Based Routing (Recommended)**:

```bash
# Use Docker Compose with Envoy proxy
docker-compose up -d

# Routing layer routes /resources/*, /annotations/*, etc. to backend
# Frontend makes relative URL API calls
```

**Standalone (Development Only)**:

```bash
docker run -d \
  -p 3000:3000 \
  -e SEMIONT_BACKEND_URL=http://backend:4000 \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

## Configuration

### Architecture: Path-Based Routing

The Semiont frontend is designed to work with **path-based routing** (implementation varies by platform):

- **Browser API calls**: Use relative URLs (`/resources/*`, `/annotations/*`, etc.)
- **Routing layer**: Routes paths to appropriate service (frontend or backend)
  - **Container platform**: Envoy proxy
  - **AWS platform**: Application Load Balancer (ALB, built on Envoy)
  - **POSIX platform**: TBD (likely nginx or similar)
- **All API calls**: Browser makes direct requests to backend via routing layer

This eliminates the need for build-time API URL configuration.

### Required Environment Variables

#### Environment Variables

All `SEMIONT_*` variables are **build-time** (embedded in the JS bundle). Since the frontend is a static SPA, there are no runtime-only variables.

- **`SEMIONT_BACKEND_URL`** - Backend API URL
  - Example: `http://backend:4000` (internal) or `https://api.example.com`
  - **Required** for the application to function

- **`SEMIONT_SITE_NAME`** - Site name (default: `Semiont`) — Optional

- **`SEMIONT_OAUTH_ALLOWED_DOMAINS`** - Comma-separated allowed email domains — Optional

- **`SEMIONT_GOOGLE_CLIENT_ID`** - Google OAuth client ID — Optional

- **`SEMIONT_ENABLE_LOCAL_AUTH`** - Enable email/password sign-in — Optional

## Deployment Scenarios

### Docker Compose with Routing Proxy (Recommended)

```yaml
version: '3.8'

services:
  envoy:
    image: envoyproxy/envoy:v1.28-latest
    ports:
      - "80:80"
    volumes:
      - ./envoy.yaml:/etc/envoy/envoy.yaml:ro
    depends_on:
      - frontend
      - backend

  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:dev
    environment:
      # Build-time — embedded in JS bundle
      SEMIONT_BACKEND_URL: http://localhost
      SEMIONT_SITE_NAME: Semiont
    depends_on:
      - backend

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    # ... backend config
```

Browser requests go to `http://localhost/resources/123` → Envoy proxy routes to `backend:4000`

### Kubernetes with Ingress Controller

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
        image: ghcr.io/the-ai-alliance/semiont-frontend:0.2.26-build.123
        ports:
        - containerPort: 3000
        env:
          # Build-time — embedded in JS bundle during docker build
          - name: SEMIONT_BACKEND_URL
            value: http://semiont-backend-service:4000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: semiont-ingress
spec:
  rules:
  - host: app.example.com
    http:
      paths:
      # Backend API routes
      - path: /resources
        pathType: Prefix
        backend:
          service:
            name: semiont-backend-service
            port:
              number: 4000
      - path: /annotations
        pathType: Prefix
        backend:
          service:
            name: semiont-backend-service
            port:
              number: 4000
      # ... other backend routes

      # Frontend pages (catch-all)
      - path: /
        pathType: Prefix
        backend:
          service:
            name: semiont-frontend-service
            port:
              number: 3000
```

### AWS ECS with Application Load Balancer

The CDK stack automatically configures ALB routing rules. Frontend container only needs:

```typescript
// In ECS task definition
environment: {
  // Build-time vars embedded in bundle during docker build
  SEMIONT_BACKEND_URL: 'https://api.example.com',
}
```

ALB handles path-based routing (similar to Envoy configuration).

## Build-Time Configuration

### Building Custom Images

```bash
# Build with custom site name and allowed domains
docker build \
  --build-arg SEMIONT_SITE_NAME="My Company" \
  --build-arg SEMIONT_OAUTH_ALLOWED_DOMAINS=mycompany.com \
  -t semiont-frontend:custom \
  -f apps/frontend/Dockerfile .
```

**Note**: API URL is NOT needed at build time - routing handled by reverse proxy at runtime.

### Multi-Platform Builds

```bash
# Build for multiple architectures
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg SEMIONT_SITE_NAME="Semiont" \
  -t semiont-frontend:multiarch \
  -f apps/frontend/Dockerfile .
```

## Environment Variable Reference

| Variable | Type | Required | Example | Description |
|----------|------|----------|---------|-------------|
| `SEMIONT_BACKEND_URL` | Build-time | **Yes** | `http://backend:4000` | Backend API URL |
| `SEMIONT_SITE_NAME` | Build-time | No | `Semiont` | Site name |
| `SEMIONT_OAUTH_ALLOWED_DOMAINS` | Build-time | No | `example.com` | Allowed email domains |
| `SEMIONT_GOOGLE_CLIENT_ID` | Build-time | No | `xxx.apps.googleusercontent.com` | Google OAuth client ID |
| `SEMIONT_ENABLE_LOCAL_AUTH` | Build-time | No | `true` | Enable email/password auth |

## Security Best Practices

### Secrets Management

**Never include secrets in the Docker image:**

```bash
# ✅ Build-time public vars (safe to embed — no secrets)
docker build \
  --build-arg SEMIONT_BACKEND_URL=https://api.example.com \
  --build-arg SEMIONT_SITE_NAME="My Company" \
  -t semiont-frontend .

# Backend secrets (GOOGLE_CLIENT_SECRET, JWT signing key, etc.) stay in the backend container
```

### Secret Rotation

The frontend contains no secrets. All sensitive credentials (OAuth client secrets, JWT signing keys) live in the backend container. Rotate them there.

## Troubleshooting

### "`SEMIONT_BACKEND_URL` not configured"

**Problem**: API calls fail because no backend URL is embedded in the bundle

**Solution**: Set `SEMIONT_BACKEND_URL` at **build time**:

```bash
docker build --build-arg SEMIONT_BACKEND_URL=http://backend:4000 ...
```

### "Authentication fails with ECONNREFUSED"

**Problem**: Browser cannot reach backend

**Solutions**:
1. Verify backend is running and accessible
2. In Docker Compose: Use service name (`http://backend:4000`)
3. In K8s: Use service DNS (`http://semiont-backend-service:4000`)

### "API calls return 404"

**Problem**: Routing not working

**Solution**: Ensure routing layer is configured with correct path-based rules. For container platform, see `apps/cli/templates/envoy.yaml` for Envoy configuration reference.

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

# Filter frontend logs
docker logs semiont-frontend 2>&1 | grep '\[Frontend'
```

## Image Tags

Published images follow this tagging strategy:

- **`dev`** - Latest development build (mutable, updated on every main branch push)
- **`latest`** - Latest stable release (mutable, updated on version releases)
- **`0.2.26-build.123`** - Specific build number (immutable)
- **`sha-0377abc`** - Specific git commit (immutable, for debugging)

**Recommendation**:
- Development/staging: Use `dev` tag
- Production: Use specific version tag (e.g., `0.2.26-build.123`)

## Architecture Notes

### Routing Flow

```
Browser → http://localhost/resources/123
  ↓
Routing Layer (port 80)
  ↓ (matches /resources/* route)
Backend (port 4000) → returns data
  ↓
Routing Layer → Browser
```

**Routing implementations by platform:**
- Container: Envoy proxy
- AWS: Application Load Balancer (ALB)
- Kubernetes: Ingress Controller (nginx, Traefik, etc.)
- POSIX: TBD

## Related Documentation

- [Deployment Guide](./DEPLOYMENT.md) - Deployment workflows and strategies
- [Development Guide](./DEVELOPMENT.md) - Local development setup
- [Envoy Configuration](../../../ENVOY.md) - Envoy proxy setup
- [Backend Container](../../backend/docs/CONTAINER.md) - Backend container configuration
- [System Architecture](../../../docs/ARCHITECTURE.md) - Overall system architecture

## Support

For issues or questions:

- GitHub Issues: <https://github.com/The-AI-Alliance/semiont/issues>
- Container Registry: <https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend>
- Actions Workflows: <https://github.com/The-AI-Alliance/semiont/actions>

---

**Container Runtime**: Apple Container, Docker, or Podman
**Orchestration**: Compatible with Docker Compose, Kubernetes, ECS
**Routing**: Varies by platform (Envoy for containers, ALB for AWS, etc.)
**Base Image**: node:22-alpine
**Platforms**: linux/amd64, linux/arm64
