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
  -e SERVER_API_URL=http://backend:4000 \
  -e NEXTAUTH_URL=https://app.example.com \
  -e NEXTAUTH_SECRET=your-secret-min-32-chars \
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
- **Server-side calls**: Use `SERVER_API_URL` for direct backend communication

This eliminates the need for build-time API URL configuration.

### Required Environment Variables

#### Runtime Variables (Set When Starting Container)

All variables are **runtime-only** (set via `-e` flag, not during build):

- **`SERVER_API_URL`** - Backend API URL for server-side requests
  - Example: `http://backend:4000` (Docker/K8s) or `https://api.example.com`
  - Used by NextAuth for server-side authentication
  - **Required** for the application to function

- **`NEXTAUTH_URL`** - Frontend URL for OAuth callbacks
  - Example: `https://app.example.com`
  - Must match OAuth provider configuration
  - **Required**

- **`NEXTAUTH_SECRET`** - Session encryption secret
  - Must be 32+ characters
  - **Security**: Never commit to git, use secrets management
  - **Required**

#### Build-Time Variables (Embedded in JavaScript Bundle)

These are set during `docker build` and cannot be changed after:

- **`NEXT_PUBLIC_SITE_NAME`** - Site name
  - Default: `Semiont`
  - Optional

- **`NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS`** - Comma-separated allowed email domains
  - Example: `example.com,company.com`
  - Optional

#### Optional Runtime Variables

- **`GOOGLE_CLIENT_ID`** - Google OAuth client ID
- **`GOOGLE_CLIENT_SECRET`** - Google OAuth client secret
- **`NODE_ENV`** - Node.js environment (`production`, `development`, `test`)

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
      # Server-side backend URL (internal Docker service name)
      SERVER_API_URL: http://backend:4000

      NEXTAUTH_URL: http://localhost
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}

      # OAuth credentials
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
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
          # Server uses internal k8s service
          - name: SERVER_API_URL
            value: http://semiont-backend-service:4000

          - name: NEXTAUTH_URL
            value: https://app.example.com

          - name: NEXTAUTH_SECRET
            valueFrom:
              secretKeyRef:
                name: semiont-secrets
                key: nextauth-secret

          - name: GOOGLE_CLIENT_ID
            valueFrom:
              secretKeyRef:
                name: oauth-secrets
                key: google-client-id

          - name: GOOGLE_CLIENT_SECRET
            valueFrom:
              secretKeyRef:
                name: oauth-secrets
                key: google-client-secret
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
      # Frontend-specific API routes
      - path: /api/auth
        pathType: Prefix
        backend:
          service:
            name: semiont-frontend-service
            port:
              number: 3000
      - path: /api/cookies
        pathType: Prefix
        backend:
          service:
            name: semiont-frontend-service
            port:
              number: 3000
      - path: /api/resources
        pathType: Prefix
        backend:
          service:
            name: semiont-frontend-service
            port:
              number: 3000

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
  // Internal ECS Service Connect DNS
  SERVER_API_URL: 'http://backend:4000',
  NEXTAUTH_URL: 'https://app.example.com',
  // ... other vars from secrets
}
```

ALB handles path-based routing (similar to Envoy configuration).

## Build-Time Configuration

### Building Custom Images

```bash
# Build with custom site name and allowed domains
docker build \
  --build-arg NEXT_PUBLIC_SITE_NAME="My Company" \
  --build-arg NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=mycompany.com \
  -t semiont-frontend:custom \
  -f apps/frontend/Dockerfile .
```

**Note**: API URL is NOT needed at build time - routing handled by reverse proxy at runtime.

### Multi-Platform Builds

```bash
# Build for multiple architectures
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg NEXT_PUBLIC_SITE_NAME="Semiont" \
  -t semiont-frontend:multiarch \
  -f apps/frontend/Dockerfile .
```

## Environment Variable Reference

| Variable | Type | Required | Example | Description |
|----------|------|----------|---------|-------------|
| `SERVER_API_URL` | Runtime | **Yes** | `http://backend:4000` | Backend API URL for server-side calls |
| `NEXTAUTH_URL` | Runtime | **Yes** | `https://app.example.com` | Frontend URL for OAuth callbacks |
| `NEXTAUTH_SECRET` | Runtime | **Yes** | `32+ char secret` | Session encryption key |
| `NEXT_PUBLIC_SITE_NAME` | Build-time | No | `Semiont` | Site name (embedded in bundle) |
| `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` | Build-time | No | `example.com` | Allowed email domains |
| `GOOGLE_CLIENT_ID` | Runtime | No | `xxx.apps.googleusercontent.com` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Runtime | No | `GOCSPX-xxx` | Google OAuth client secret |
| `NODE_ENV` | Runtime | No | `production` | Node environment |

## Security Best Practices

### Secrets Management

**Never include secrets in the Docker image:**

```bash
# ❌ BAD - Secrets in image
docker build \
  --build-arg NEXTAUTH_SECRET=my-secret \
  -t semiont-frontend .

# ✅ GOOD - Secrets at runtime
docker run -e NEXTAUTH_SECRET=$SECRET semiont-frontend
```

### Secret Rotation

When rotating secrets:

1. Update secret in secrets manager
2. Restart containers (no rebuild needed)
3. Old sessions will be invalidated

```bash
# Update secret
kubectl create secret generic semiont-secrets \
  --from-literal=nextauth-secret=new-secret-32-chars \
  --dry-run=client -o yaml | kubectl apply -f -

# Rolling restart
kubectl rollout restart deployment semiont-frontend
```

## Troubleshooting

### "SERVER_API_URL environment variable is required"

**Problem**: Container fails to start

**Solution**: Set `SERVER_API_URL` at **runtime**:

```bash
docker run -e SERVER_API_URL=http://backend:4000 ...
```

### "Authentication fails with ECONNREFUSED"

**Problem**: Next.js server can't reach backend

**Solutions**:
1. Verify `SERVER_API_URL` points to accessible backend
2. In Docker Compose: Use service name (`http://backend:4000`)
3. In K8s: Use service DNS (`http://semiont-backend-service:4000`)

### "API calls return 404"

**Problem**: Routing not working

**Solution**: Ensure routing layer is configured with correct path-based rules. For container platform, see `apps/cli/templates/envoy.yaml` for Envoy configuration reference.

### "NextAuth callback fails"

**Problem**: OAuth redirect doesn't match

**Solution**: Ensure `NEXTAUTH_URL` matches OAuth provider configuration:

```bash
# Must match exactly
NEXTAUTH_URL=https://app.example.com  # Without trailing slash
```

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

# Filter Next.js server logs
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
- Container (Docker/Podman): Envoy proxy
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

**Container Runtime**: Docker/Podman
**Orchestration**: Compatible with Docker Compose, Kubernetes, ECS
**Routing**: Varies by platform (Envoy for containers, ALB for AWS, etc.)
**Base Image**: node:22-alpine
**Platforms**: linux/amd64, linux/arm64
