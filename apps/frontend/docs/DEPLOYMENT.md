# Frontend Deployment Guide

**Last Updated**: 2025-10-25

Complete guide to deploying the Semiont frontend to production and staging environments.

## Table of Contents

- [Overview](#overview)
- [Publishing and Updating](#publishing-and-updating)
- [How It Works](#how-it-works)
- [Environment Configuration](#environment-configuration)
- [Deployment Workflows](#deployment-workflows)
- [Rollback Procedures](#rollback-procedures)
- [Monitoring](#monitoring)
- [Related Documentation](#related-documentation)

## Overview

The frontend is deployed using the `semiont publish` and `semiont update` commands, which handle building, containerization, and deployment to AWS ECS.

**Key Concepts**:
- **Publish**: Builds TypeScript/Next.js locally and creates Docker images
- **Update**: Deploys Docker images to AWS ECS
- **Image Tagging**: Development uses `latest` (mutable), production uses git hash (immutable)
- **Environment-specific configuration**: Managed via `/config/environments/[env].json`

## Publishing and Updating

### Development/Staging Deployment

Uses `latest` tag for rapid iteration:

```bash
# Set environment
export SEMIONT_ENV=dev

# Build and publish Docker image
semiont publish --service frontend --environment dev --semiont-repo /path/to/semiont

# Deploy to ECS
semiont update --service frontend --environment dev --wait

# Monitor deployment
semiont watch logs --service frontend
```

### Production Deployment

Uses git commit hash for immutability:

```bash
# Set environment
export SEMIONT_ENV=production

# Build and publish Docker image (tagged with git hash)
semiont publish --service frontend --environment production --semiont-repo /path/to/semiont

# Deploy to ECS
semiont update --service frontend --environment production --wait

# Verify deployment
semiont check --service frontend --environment production
```

**Note**: The `--semiont-repo` parameter points to where the Semiont platform code is located (containing the Dockerfiles and application source). This is typically a separate repository from your project configuration.

## How It Works

### 1. Build Process

`semiont publish` performs these steps:

1. **TypeScript Compilation**: Runs `npm run build` locally
2. **Environment Validation**: Ensures all required environment variables are set
3. **Next.js Build**: Creates optimized production build
   - Static pages pre-rendered
   - Bundle optimization
   - Image optimization
4. **Docker Image Creation**: Builds Docker image with production build
5. **Image Push**: Pushes to ECR (Elastic Container Registry)

**Why local builds?**: Building locally ensures type checking and linting pass before deployment. The Docker image contains the built artifacts, not source code.

### 2. Image Tagging

Image tagging strategy is controlled by `deployment.imageTagStrategy` in environment config:

**Mutable (`latest`) - Development/Staging**:
```json
{
  "deployment": {
    "imageTagStrategy": "mutable"
  }
}
```
- Images tagged as `latest`
- Each publish overwrites the previous `latest` tag
- Fast iteration, easy rollback
- Used for dev, staging, qa environments

**Immutable (git hash) - Production**:
```json
{
  "deployment": {
    "imageTagStrategy": "immutable"
  }
}
```
- Images tagged with git commit hash (e.g., `abc123def`)
- Each publish creates a new, permanent tag
- Enables precise rollback to any version
- Audit trail of deployed versions
- Used for production

### 3. Deployment

`semiont update` performs these steps:

1. **Task Definition Update**: Updates ECS task definition with new image tag
2. **Service Update**: Forces ECS to redeploy with new task definition
3. **Health Checks**: Monitors deployment progress
4. **Wait for Stable** (with `--wait`): Blocks until deployment completes

**Zero-downtime deployment**: ECS performs rolling updates, starting new tasks before stopping old ones.

## Environment Configuration

### Environment File Structure

```json
{
  "services": {
    "frontend": {
      "platform": {
        "type": "aws",
        "taskDefinition": "semiont-frontend-production",
        "desiredCount": 2
      },
      "url": "https://app.semiont.ai",
      "port": 3000,
      "env": {
        "SERVER_API_URL": "http://backend-internal:4000",
        "NEXTAUTH_URL": "https://app.semiont.ai",
        "NEXTAUTH_SECRET": "{{secrets.NEXTAUTH_SECRET}}"
      }
    }
  },
  "deployment": {
    "imageTagStrategy": "immutable",
    "region": "us-east-1",
    "ecrRepository": "semiont/frontend"
  }
}
```

### Required Environment Variables

**Frontend-specific**:
- `SERVER_API_URL` - Backend API URL for browser (embedded at build time)
- `SERVER_API_URL` - Backend API URL for server-side calls (runtime, optional - not needed - Envoy handles routing)
- `NEXTAUTH_URL` - Frontend URL (for OAuth callbacks)
- `NEXTAUTH_SECRET` - Session encryption secret (32+ characters)

**Important**: See [Container Guide](./CONTAINER.md) for details on build-time vs runtime environment variables.

**Google OAuth** (if using OAuth):
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret

**Optional**:
- `NEXT_PUBLIC_GOOGLE_ANALYTICS_ID` - Google Analytics tracking ID
- `SENTRY_DSN` - Sentry error tracking DSN

### Secrets Management

Sensitive values should use secrets references:

```json
{
  "env": {
    "NEXTAUTH_SECRET": "{{secrets.NEXTAUTH_SECRET}}",
    "GOOGLE_CLIENT_SECRET": "{{secrets.GOOGLE_CLIENT_SECRET}}"
  }
}
```

Secrets are stored in AWS Secrets Manager and injected at runtime.

## Deployment Workflows

### Standard Deployment Workflow

1. **Develop**: Make changes locally, test with `semiont start`
2. **Test**: Run test suite with `npm test`
3. **Type Check**: Verify TypeScript with `npm run type-check`
4. **Build**: Test production build with `npm run build`
5. **Publish**: Create Docker image with `semiont publish`
6. **Deploy**: Update ECS service with `semiont update --wait`
7. **Verify**: Check deployment with `semiont check`
8. **Monitor**: Watch logs with `semiont watch logs`

### Multi-Environment Deployment

Deploy to staging first, then production:

```bash
# Deploy to staging
export SEMIONT_ENV=staging
semiont publish --service frontend --environment staging --semiont-repo /path/to/semiont
semiont update --service frontend --environment staging --wait

# Verify staging
curl https://staging.semiont.ai/api/health

# Deploy to production
export SEMIONT_ENV=production
semiont publish --service frontend --environment production --semiont-repo /path/to/semiont
semiont update --service frontend --environment production --wait

# Verify production
curl https://app.semiont.ai/api/health
```

### Automated CI/CD Deployment

**GitHub Actions example**:
```yaml
name: Deploy Frontend
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
      - name: Publish
        run: semiont publish --service frontend --environment production
        env:
          SEMIONT_ENV: production
      - name: Deploy
        run: semiont update --service frontend --environment production --wait
```

## Rollback Procedures

### Rollback to Previous Version (Immutable Tags)

When using immutable image tags (production), rollback is straightforward:

```bash
# List recent image tags
aws ecr describe-images --repository-name semiont/frontend --query 'imageDetails[*].[imageTags[0],imagePushedAt]' --output table

# Update task definition to use previous git hash
semiont update --service frontend --environment production --image-tag abc123def --wait
```

### Rollback to Latest (Mutable Tags)

When using mutable tags (dev/staging), republish the desired version:

```bash
# Checkout previous commit
git checkout <previous-commit>

# Republish
semiont publish --service frontend --environment dev --semiont-repo /path/to/semiont

# Deploy
semiont update --service frontend --environment dev --wait
```

### Emergency Rollback

If deployment fails health checks, ECS automatically rolls back:

```bash
# Check deployment status
semiont check --service frontend --environment production

# View rollback events
aws ecs describe-services --cluster production --services semiont-frontend --query 'services[0].events[:5]'
```

## Monitoring

### Health Checks

Frontend health is monitored via:
- **ECS Health Checks**: HTTP GET to `/api/health`
- **ALB Target Group Health**: Load balancer health checks
- **CloudWatch Metrics**: CPU, memory, request count

```bash
# Check service health
semiont check --service frontend --environment production

# View CloudWatch logs
semiont watch logs --service frontend --environment production

# View metrics
aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization --dimensions Name=ServiceName,Value=semiont-frontend
```

### Logs

Access logs via CloudWatch:

```bash
# Tail logs in real-time
semiont watch logs --service frontend --environment production

# View logs for specific time range
aws logs filter-log-events --log-group-name /ecs/semiont-frontend --start-time 1609459200000 --end-time 1609545600000
```

### Performance Monitoring

**Lighthouse CI**: Automated performance testing on each deployment

**Bundle Size Monitoring**: Track bundle size over time

```bash
# Run Lighthouse CI
npm run lighthouse

# Analyze bundle size
npm run analyze-bundle
```

## Related Documentation

### Deployment Guides
- [System Deployment Guide](../../../docs/DEPLOYMENT.md) - Overall deployment strategy
- [Backend Deployment](../../backend/docs/DEPLOYMENT.md) - Backend deployment
- [CLI Deployment Commands](../../cli/README.md) - CLI usage reference

### Development Guides
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Testing Guide](./TESTING.md) - Pre-deployment testing
- [Performance Guide](./PERFORMANCE.md) - Performance optimization

### AWS Documentation
- [ECS Service Deployment](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_update.html)
- [ECR Repository Management](https://docs.aws.amazon.com/AmazonECR/latest/userguide/Repositories.html)
- [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/)

---

**Deployment Tool**: Semiont CLI
**Container Orchestration**: AWS ECS
**Image Registry**: AWS ECR
**Load Balancer**: AWS ALB
**Last Updated**: 2025-10-25
