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

```bash
docker run -d \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=https://api.example.com \
  -e SERVER_API_URL=http://backend:4000 \
  -e NEXTAUTH_URL=https://app.example.com \
  -e NEXTAUTH_SECRET=your-secret-min-32-chars \
  --name semiont-frontend \
  ghcr.io/the-ai-alliance/semiont-frontend:dev
```

## Configuration

### Required Environment Variables

The frontend container requires these runtime environment variables:

#### Build-Time vs Runtime Variables

**IMPORTANT**: Next.js has two types of environment variables:

1. **`NEXT_PUBLIC_*`** - Embedded in JavaScript bundle at **build time**
   - Used by browser (client-side code)
   - Cannot be changed after container is built
   - Safe to expose publicly (visible in browser)

2. **Regular variables** (no `NEXT_PUBLIC_` prefix) - Read at **runtime**
   - Used by Next.js server (server-side code)
   - Can be changed when starting container
   - Should not be exposed to browser

#### Required Variables

- **`NEXT_PUBLIC_API_URL`** - Public API URL for browser requests
  - Build-time variable (embedded in bundle)
  - Example: `https://api.example.com` or `https://codespace-xxx.app.github.dev`
  - Used by browser to make API calls

- **`SERVER_API_URL`** - Internal API URL for server-side requests
  - **Runtime variable** (can be set after build)
  - Example: `http://backend:4000` (Docker internal) or public URL
  - Used by NextAuth for server-side authentication
  - Falls back to `NEXT_PUBLIC_API_URL` if not set

- **`NEXTAUTH_URL`** - Frontend URL for OAuth callbacks
  - Runtime variable
  - Example: `https://app.example.com`
  - Must match OAuth provider configuration

- **`NEXTAUTH_SECRET`** - Session encryption secret
  - Runtime variable
  - Must be 32+ characters
  - **Security**: Never commit to git, use secrets management

### Optional Environment Variables

- **`NEXT_PUBLIC_SITE_NAME`** - Site name (build-time)
  - Default: `Semiont`

- **`NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS`** - Comma-separated allowed email domains (build-time)
  - Example: `example.com,company.com`

- **`GOOGLE_CLIENT_ID`** - Google OAuth client ID (runtime)
- **`GOOGLE_CLIENT_SECRET`** - Google OAuth client secret (runtime)

- **`NODE_ENV`** - Node.js environment (runtime)
  - `production`, `development`, `test`

## Deployment Scenarios

### Local Development

```bash
docker run -d \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=http://localhost:4000 \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_SECRET=local-dev-secret-min-32-chars \
  semiont-frontend:dev
```

**Note**: `SERVER_API_URL` not needed (defaults to `NEXT_PUBLIC_API_URL`)

### GitHub Codespaces

**Problem**: Codespace URL is unknown at build time

**Solution**: Use `SERVER_API_URL` runtime variable

```bash
# Build once with generic placeholder
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://placeholder.com \
  -t semiont-frontend .

# Run with actual Codespace URLs (set at runtime)
docker run -d \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_URL=https://studious-sniffle-xxx.app.github.dev \
  -e SERVER_API_URL=https://studious-sniffle-xxx.app.github.dev \
  -e NEXTAUTH_URL=https://studious-sniffle-yyy.app.github.dev \
  -e NEXTAUTH_SECRET=$CODESPACE_SECRET \
  semiont-frontend:dev
```

The `SERVER_API_URL` (runtime) allows the container to connect to the backend even though `NEXT_PUBLIC_API_URL` was set at build time.

### Docker Compose (Internal Service Mesh)

```yaml
version: '3.8'

services:
  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:dev
    ports:
      - "3000:3000"
    environment:
      # Browser uses public URL
      NEXT_PUBLIC_API_URL: https://api.example.com

      # Server uses internal Docker service name (faster, more reliable)
      SERVER_API_URL: http://backend:4000

      NEXTAUTH_URL: https://app.example.com
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}  # From .env file

      # OAuth credentials
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
    depends_on:
      - backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/"]
      interval: 30s
      timeout: 5s
      retries: 3

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    # ... backend config
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: semiont-frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: semiont-frontend
  template:
    metadata:
      labels:
        app: semiont-frontend
    spec:
      containers:
      - name: frontend
        image: ghcr.io/the-ai-alliance/semiont-frontend:0.2.26-build.123
        ports:
        - containerPort: 3000
          protocol: TCP
        env:
          # Browser uses public URL (from build time)
          - name: NEXT_PUBLIC_API_URL
            value: https://api.example.com

          # Server uses internal k8s service (runtime)
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
        livenessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
```

## Build-Time Configuration

### Building Custom Images

```bash
# Build with custom API URL (for browser)
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.mycompany.com \
  --build-arg NEXT_PUBLIC_SITE_NAME="My Company" \
  --build-arg NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS=mycompany.com \
  -t semiont-frontend:custom \
  -f apps/frontend/Dockerfile .
```

### Multi-Platform Builds

```bash
# Build for multiple architectures
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  -t semiont-frontend:multiarch \
  -f apps/frontend/Dockerfile .
```

## Environment Variable Reference

| Variable | Type | Required | Example | Description |
|----------|------|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | Build-time | Yes | `https://api.example.com` | Public API URL for browser |
| `SERVER_API_URL` | Runtime | No* | `http://backend:4000` | Internal API URL for server |
| `NEXTAUTH_URL` | Runtime | Yes | `https://app.example.com` | Frontend URL for OAuth |
| `NEXTAUTH_SECRET` | Runtime | Yes | `32+ char secret` | Session encryption key |
| `NEXT_PUBLIC_SITE_NAME` | Build-time | No | `Semiont` | Site name |
| `NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS` | Build-time | No | `example.com` | Allowed email domains |
| `GOOGLE_CLIENT_ID` | Runtime | No | `xxx.apps.googleusercontent.com` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Runtime | No | `GOCSPX-xxx` | Google OAuth secret |
| `NODE_ENV` | Runtime | No | `production` | Node environment |

\* *Falls back to `NEXT_PUBLIC_API_URL` if not set*

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

### "Cannot read NEXT_PUBLIC_API_URL"

**Problem**: Browser can't find API URL

**Solution**: This variable is embedded at **build time**. Rebuild the image with correct value:

```bash
docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com ...
```

### "Authentication fails with ECONNREFUSED"

**Problem**: Next.js server can't reach backend

**Solution**: Set `SERVER_API_URL` at **runtime**:

```bash
docker run -e SERVER_API_URL=http://backend:4000 ...
```

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

## Related Documentation

- [Deployment Guide](./DEPLOYMENT.md) - Deployment workflows and strategies
- [Development Guide](./DEVELOPMENT.md) - Local development setup
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
**Base Image**: node:22-alpine
**Platforms**: linux/amd64, linux/arm64
