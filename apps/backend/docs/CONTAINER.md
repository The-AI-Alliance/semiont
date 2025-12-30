# Backend Container Image

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend)

Production-ready Docker container images for the Semiont backend, published to GitHub Container Registry with multi-platform support.

## Quick Start

### Pull Image

```bash
# Latest development build (recommended for testing)
docker pull ghcr.io/the-ai-alliance/semiont-backend:dev

# Specific version (recommended for production)
docker pull ghcr.io/the-ai-alliance/semiont-backend:0.1.0-build.123

# Specific commit SHA (for debugging/pinning)
docker pull ghcr.io/the-ai-alliance/semiont-backend:sha-0377abc
```

### Run Container

```bash
docker run -d \
  -p 4000:4000 \
  -v $(pwd):/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

## Configuration

### Required Environment Variables

The backend container requires exactly two environment variables:

- **`SEMIONT_ROOT`** - Path to directory containing configuration files
- **`SEMIONT_ENV`** - Environment name (e.g., `production`, `staging`, `development`)

### Optional Environment Variables

Additional runtime configuration via environment variables:

- **`LOG_LEVEL`** - Logging verbosity: `error`, `warn`, `info` (default), `http`, `debug`
- **`LOG_FORMAT`** - Log output format: `json` (default), `simple`
- **`NODE_ENV`** - Node.js environment: `production`, `development`, `test`

**Example with logging:**

```bash
docker run -d \
  -p 4000:4000 \
  -v $(pwd):/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  -e LOG_LEVEL=info \
  -e LOG_FORMAT=json \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

For complete logging documentation, see [Logging Guide](./LOGGING.md).

### Configuration File Structure

Your `SEMIONT_ROOT` directory must contain:

```
/path/to/config/
├── semiont.json              # Project configuration
└── environments/
    ├── production.json       # Production environment config
    ├── staging.json          # Staging environment config
    └── development.json      # Development environment config
```

### Configuration File Contents

All configuration (database credentials, JWT secrets, AI API keys, etc.) comes from the JSON files in `SEMIONT_ROOT/environments/{SEMIONT_ENV}.json`.

**Example `environments/production.json`:**

```json
{
  "database": {
    "url": "postgresql://user:password@db-host:5432/semiont"
  },
  "auth": {
    "jwtSecret": "your-jwt-secret-min-32-chars",
    "googleClientId": "your-google-oauth-client-id",
    "googleClientSecret": "your-google-oauth-secret"
  },
  "ai": {
    "openaiApiKey": "sk-...",
    "anthropicApiKey": "sk-ant-..."
  },
  "graph": {
    "type": "neptune",
    "endpoint": "your-neptune-cluster.region.amazonaws.com",
    "port": 8182
  }
}
```

**Important:** Do NOT use `DATABASE_URL` or other environment variables for secrets. Everything goes in the JSON files.

## Volume Mount Patterns

### Local Development

Mount your local configuration directory:

```bash
docker run -d \
  -p 4000:4000 \
  -v /Users/me/myproject:/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=development \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

### Docker Volume

Create a named volume for persistent configuration:

```bash
# Create volume
docker volume create semiont-config

# Copy configuration files into volume
docker run --rm \
  -v semiont-config:/config \
  -v $(pwd):/source \
  alpine cp -r /source/. /config

# Run container with volume
docker run -d \
  -p 4000:4000 \
  -v semiont-config:/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

### Read-only Volume

Mount configuration as read-only for security:

```bash
docker run -d \
  -p 4000:4000 \
  -v $(pwd):/app/config:ro \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

## Docker Compose

### Basic Setup

**docker-compose.yml:**

```yaml
services:
  database:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semiont
      POSTGRES_USER: semiont
      POSTGRES_PASSWORD: semiont
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U semiont"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    ports:
      - "4000:4000"
    volumes:
      - ./config:/app/config:ro
    environment:
      SEMIONT_ROOT: /app/config
      SEMIONT_ENV: production
      LOG_LEVEL: info        # error|warn|info|http|debug
      LOG_FORMAT: json       # json|simple
    depends_on:
      database:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

volumes:
  postgres-data:
```

### With Frontend

**docker-compose.yml:**

```yaml
services:
  database:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semiont
      POSTGRES_USER: semiont
      POSTGRES_PASSWORD: semiont
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U semiont"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/the-ai-alliance/semiont-backend:dev
    ports:
      - "4000:4000"
    volumes:
      - ./config:/app/config:ro
    environment:
      SEMIONT_ROOT: /app/config
      SEMIONT_ENV: production
      LOG_LEVEL: info        # error|warn|info|http|debug
      LOG_FORMAT: json       # json|simple
    depends_on:
      database:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

  frontend:
    image: ghcr.io/the-ai-alliance/semiont-frontend:dev
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: http://backend:4000
    depends_on:
      backend:
        condition: service_healthy

volumes:
  postgres-data:
```

### Start Services

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop services
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

## Kubernetes Deployment

### ConfigMap for Configuration

**configmap.yaml:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: semiont-config
  namespace: default
data:
  semiont.json: |
    {
      "projectName": "My Semiont Project",
      "version": "1.0.0"
    }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: semiont-env-production
  namespace: default
data:
  production.json: |
    {
      "database": {
        "url": "postgresql://user:password@postgres-service:5432/semiont"
      },
      "auth": {
        "jwtSecret": "your-jwt-secret-min-32-chars",
        "googleClientId": "your-google-client-id",
        "googleClientSecret": "your-google-secret"
      },
      "ai": {
        "openaiApiKey": "sk-...",
        "anthropicApiKey": "sk-ant-..."
      }
    }
```

### Deployment

**deployment.yaml:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: semiont-backend
  namespace: default
spec:
  replicas: 3
  selector:
    matchLabels:
      app: semiont-backend
  template:
    metadata:
      labels:
        app: semiont-backend
    spec:
      containers:
        - name: backend
          image: ghcr.io/the-ai-alliance/semiont-backend:0.1.0-build.123
          ports:
            - containerPort: 4000
              protocol: TCP
          env:
            - name: SEMIONT_ROOT
              value: /app/config
            - name: SEMIONT_ENV
              value: production
            - name: LOG_LEVEL
              value: info
            - name: LOG_FORMAT
              value: json
          volumeMounts:
            - name: config
              mountPath: /app/config/semiont.json
              subPath: semiont.json
              readOnly: true
            - name: env-config
              mountPath: /app/config/environments/production.json
              subPath: production.json
              readOnly: true
          livenessProbe:
            httpGet:
              path: /api/health
              port: 4000
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/health
              port: 4000
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
      volumes:
        - name: config
          configMap:
            name: semiont-config
        - name: env-config
          configMap:
            name: semiont-env-production
```

### Service

**service.yaml:**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: semiont-backend
  namespace: default
spec:
  selector:
    app: semiont-backend
  ports:
    - protocol: TCP
      port: 4000
      targetPort: 4000
  type: LoadBalancer
```

### Apply Configuration

```bash
# Apply configurations
kubectl apply -f configmap.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# Check deployment status
kubectl get deployments
kubectl get pods
kubectl get services

# View logs
kubectl logs -f deployment/semiont-backend

# Scale deployment
kubectl scale deployment semiont-backend --replicas=5
```

## Image Details

### Multi-Platform Support

The container image supports multiple architectures:

- **linux/amd64** - Intel/AMD processors (x86_64)
- **linux/arm64** - ARM processors (Apple Silicon, ARM servers)

Docker automatically selects the correct architecture for your platform.

### Image Contents

The production image includes:

- **Node.js 22** (Alpine Linux base)
- **Built backend application** (`apps/backend/dist`)
- **Built dependencies** (`@semiont/core`, `@semiont/api-client`)
- **Prisma client** (generated at build time)
- **Runtime tools** (openssl, postgresql-client, curl)

### Security Features

- **Non-root user** - Runs as user `semiont` (UID 1001)
- **Minimal base image** - Alpine Linux for reduced attack surface
- **No secrets in image** - All secrets in mounted configuration
- **Read-only root filesystem compatible** - Uploads directory is configurable

### Health Check

Built-in health check endpoint:

```bash
# Check health
curl http://localhost:4000/api/health

# Expected response
{"status":"ok"}
```

Health check configuration:
- **Interval:** 30 seconds
- **Timeout:** 5 seconds
- **Start period:** 30 seconds
- **Retries:** 3

## Version Tags

### Tag Strategy

Each build publishes three tags:

1. **`:dev`** - Latest development build from main branch
   - Always points to most recent build
   - Use for testing and development
   - Updates on every commit to main

2. **`:0.1.0-build.123`** - Specific version with build number
   - Immutable reference to specific build
   - Use for production deployments
   - Build number increments with each CI run

3. **`:sha-0377abc`** - Specific commit SHA
   - Immutable reference to exact commit
   - Use for debugging or pinning to exact code version
   - Short SHA (7 characters)

### Choosing a Tag

**Development/Testing:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-backend:dev
```

**Production (Recommended):**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-backend:0.1.0-build.123
```

**Debugging/Pinning:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-backend:sha-0377abc
```

### Finding Available Versions

View available versions at:
- GitHub Packages UI: <https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend>
- GitHub Actions: Check workflow run summaries for published versions

## Troubleshooting

### Container Won't Start

**Check logs:**
```bash
docker logs semiont-backend
```

**Common issues:**

1. **Missing configuration files:**
   ```
   Error: ENOENT: no such file or directory, open '/app/config/semiont.json'
   ```
   - Verify volume mount path
   - Ensure `semiont.json` exists in mounted directory

2. **Invalid environment name:**
   ```
   Error: Environment file not found: /app/config/environments/production.json
   ```
   - Check `SEMIONT_ENV` matches filename in `environments/` directory

3. **Database connection failure:**
   ```
   Error: connect ECONNREFUSED postgresql://...
   ```
   - Verify database is running
   - Check database URL in environment JSON file
   - Ensure database accepts connections from container

### Permission Issues

If you see permission errors:

```bash
# Check volume mount permissions
docker exec semiont-backend ls -la /app/config

# Run with specific user (if needed)
docker run -d \
  --user 1001:1001 \
  -p 4000:4000 \
  -v $(pwd):/app/config \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

### Health Check Failures

**Check health endpoint manually:**
```bash
docker exec semiont-backend curl -f http://localhost:4000/api/health
```

**Common issues:**
- Application hasn't finished starting (wait for start period)
- Database connection not established
- Configuration errors preventing startup

### Platform Mismatch

If you see:
```
no matching manifest for linux/arm64/v8 in the manifest list entries
```

This means the image wasn't built for your platform. Ensure you're using a recent build that includes multi-platform support (builds after the platforms parameter was added to the workflow).

### View Build Logs

For build issues, check the GitHub Actions workflow:

1. Go to: <https://github.com/The-AI-Alliance/semiont/actions>
2. Click on "Publish Backend Container Image" workflow
3. View build logs for specific run

## Advanced Usage

### Custom Upload Directory

The backend uses `/app/uploads` for file storage. To persist uploads:

```bash
docker run -d \
  -p 4000:4000 \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/uploads:/app/uploads \
  -e SEMIONT_ROOT=/app/config \
  -e SEMIONT_ENV=production \
  --name semiont-backend \
  ghcr.io/the-ai-alliance/semiont-backend:dev
```

### Database Migrations

Run Prisma migrations:

```bash
# Interactive migration
docker exec -it semiont-backend npx prisma migrate dev

# Production migration
docker exec semiont-backend npx prisma migrate deploy

# View migration status
docker exec semiont-backend npx prisma migrate status
```

### Prisma Studio

Access Prisma Studio for database inspection:

```bash
docker exec -it semiont-backend npx prisma studio
```

Then open <http://localhost:5555> in your browser.

### Shell Access

Access container shell for debugging:

```bash
# Interactive shell
docker exec -it semiont-backend sh

# Run commands
docker exec semiont-backend node --version
docker exec semiont-backend cat /app/config/semiont.json
```

## CI/CD Integration

### Automatic Builds

The backend image is automatically built and published on every commit to the main branch that affects:

- `apps/backend/**`
- `packages/core/**`
- `packages/api-client/**`
- `.github/workflows/publish-backend.yml`

### Manual Workflow Trigger

Trigger a build manually:

1. Go to Actions tab
2. Select "Publish Backend Container Image"
3. Click "Run workflow"
4. Optionally enable "Dry run" to build without publishing

### Integration in Your CI/CD

**GitHub Actions example:**

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: |
          # Pull latest image
          docker pull ghcr.io/the-ai-alliance/semiont-backend:dev

          # Stop old container
          docker stop semiont-backend || true
          docker rm semiont-backend || true

          # Start new container
          docker run -d \
            -p 4000:4000 \
            -v /opt/semiont/config:/app/config:ro \
            -e SEMIONT_ROOT=/app/config \
            -e SEMIONT_ENV=production \
            --name semiont-backend \
            ghcr.io/the-ai-alliance/semiont-backend:dev
```

## Related Documentation

- [Backend README](../README.md) - Backend overview and development setup
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Deployment Guide](./DEPLOYMENT.md) - AWS and production deployment
- [API Reference](../../../specs/docs/API.md) - Complete API documentation
- [Architecture](../../../docs/ARCHITECTURE.md) - System architecture overview

## Support

For issues or questions:

- GitHub Issues: <https://github.com/The-AI-Alliance/semiont/issues>
- Container Registry: <https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-backend>
- Actions Workflows: <https://github.com/The-AI-Alliance/semiont/actions>
