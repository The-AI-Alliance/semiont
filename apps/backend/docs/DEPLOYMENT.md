# Backend Deployment Guide

Backend-specific deployment guide focused on build process, database migrations, and backend monitoring.

**Related Documentation:**
- **[System Deployment Guide](../../../docs/DEPLOYMENT.md)** - **Read this first!** Complete multi-service deployment, AWS provisioning, and deployment workflows
- [AWS Platform Docs](../../../docs/platforms/AWS.md) - AWS infrastructure details
- [Main README](../README.md) - Backend overview
- [Development Guide](./DEVELOPMENT.md) - Local development setup

**Scope**: This document covers backend-specific deployment concerns: TypeScript build process, Prisma migrations, backend monitoring, and troubleshooting. For complete system deployment including frontend and infrastructure provisioning, see the [System Deployment Guide](../../../docs/DEPLOYMENT.md).

## Backend Build Process

### TypeScript Compilation

The `semiont publish` command builds the backend TypeScript locally before creating Docker images:

**Build Steps**:

1. **Compile TypeScript to JavaScript**
   ```bash
   npm run build
   # Compiles src/ to dist/
   ```

2. **Generate Prisma Client**
   ```bash
   npx prisma generate
   # Creates type-safe database client
   ```

3. **Create Optimized Build**
   - Tree shaking for smaller bundles
   - Source maps for debugging
   - Environment-specific optimizations

### Build Command

```bash
# Development/staging (uses 'latest' tag)
semiont publish --service backend --environment dev

# Production (uses git hash for immutability)
semiont publish --service backend --environment production
```

## Database Migrations

### Automatic Migration on Deployment

Migrations run automatically during container startup:

**Container Startup Sequence** (`start.sh`):

```bash
#!/bin/bash
# 1. Run migrations
npx prisma migrate deploy

# 2. Start application
node dist/index.js
```

**Benefits**:
- Schema always up-to-date
- Safe for rolling deployments
- Idempotent migrations

### Migration Safety

**Safe Migrations** (can run during deployment):
- Adding new tables
- Adding nullable columns
- Creating indexes (with `CONCURRENTLY` in PostgreSQL)
- Adding new constraints (as nullable first)

**Unsafe Migrations** (require downtime):
- Dropping columns
- Renaming columns
- Changing column types
- Adding non-nullable columns without defaults

**Best Practice**:

```prisma
// Phase 1: Add nullable column
model User {
  newField String?
}

// Phase 2: Backfill data, then make required
model User {
  newField String @default("")
}
```

### Manual Migration Control

For complex migrations, SSH into the running container:

```bash
# Get running task ID
aws ecs list-tasks \
  --cluster semiont-production \
  --service-name backend

# SSH into task
aws ecs execute-command \
  --cluster semiont-production \
  --task <task-id> \
  --container backend \
  --interactive \
  --command "/bin/bash"

# Manually run migrations
npx prisma migrate deploy

# Check migration status
npx prisma migrate status
```

## Backend Health Checks

### Application Health Endpoint

The backend provides `/api/health` for load balancer monitoring:

**Endpoint**:

```bash
GET /api/health
```

**Response**:

```json
{
  "status": "healthy",
  "timestamp": "2025-10-23T12:00:00Z"
}
```

**Implementation** (`src/routes/health.ts`):

```typescript
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});
```

### ECS Health Check Configuration

Health check configured in CDK:

```typescript
healthCheck: {
  command: ["CMD-SHELL", "curl -f http://localhost:4000/api/health || exit 1"],
  interval: 30,        // Check every 30 seconds
  timeout: 5,          // 5 second timeout
  retries: 3,          // 3 failures = unhealthy
  startPeriod: 60      // 60 second grace period
}
```

## Backend Monitoring

### CloudWatch Logs

Backend logs are automatically sent to CloudWatch:

**Log Stream**: `semiont-backend`

**View Logs**:

```bash
# Watch real-time logs
semiont watch logs --service backend --follow

# View last 10 minutes
semiont watch logs --service backend --since 10m

# Filter by pattern
semiont watch logs --service backend --filter "ERROR"
```

### Application Metrics

Key backend metrics to monitor:

- **Request Rate**: Number of API requests per minute
- **Error Rate**: 4xx/5xx responses
- **Response Time**: p50, p95, p99 latencies
- **Database Connections**: Active Prisma connections
- **Memory Usage**: Container memory utilization
- **CPU Usage**: Container CPU utilization

### Custom CloudWatch Metrics

Log custom metrics from the backend:

```typescript
// Example: Track API endpoint usage
await cloudwatch.putMetricData({
  Namespace: 'Semiont/Backend',
  MetricData: [{
    MetricName: 'DocumentCreated',
    Value: 1,
    Unit: 'Count',
    Timestamp: new Date()
  }]
});
```

## Backend-Specific Deployment Workflow

### 1. Pre-Deployment Checks

```bash
# Run tests
npm test

# Type check
npm run type-check

# Build locally to verify
npm run build
```

### 2. Build and Publish

```bash
# Set environment
export SEMIONT_ENV=production

# Build and push Docker image
semiont publish --service backend
```

### 3. Deploy to ECS

```bash
# Deploy with monitoring
semiont update --service backend --wait

# Watch deployment
semiont watch logs --service backend --follow
```

### 4. Verify Backend Health

```bash
# Check service health
semiont check --service backend

# Test health endpoint
curl https://api.semiont.com/api/health

# Verify database connectivity
curl -H "Authorization: Bearer $TOKEN" \
  https://api.semiont.com/api/status
```

## Troubleshooting Backend Deployments

### Build Failures

**TypeScript Compilation Errors**:

```bash
# Check locally
npm run type-check

# Fix type errors before deploying
```

**Prisma Generation Fails**:

```bash
# Regenerate Prisma client
npx prisma generate

# Check schema syntax
npx prisma validate
```

### Migration Failures

**Migration Won't Run**:

```bash
# Check migration history
npx prisma migrate status

# Reset and reapply (development only!)
npx prisma migrate reset
```

**Conflicting Migrations**:

```bash
# Resolve conflicts in schema.prisma
# Generate new migration
npx prisma migrate dev --name fix_conflict
```

### Runtime Failures

**Container Won't Start**:

```bash
# View container logs
semiont watch logs --service backend --since 5m

# Common issues:
# - Missing environment variables
# - Database connection failure
# - Port already in use
```

**Database Connection Issues**:

```bash
# Check RDS is accessible from ECS
aws rds describe-db-instances \
  --db-instance-identifier semiont-production

# Verify security group rules
# Backend security group must allow traffic to RDS security group
```

**High Memory Usage**:

```bash
# Check current memory
semiont check --service backend

# Increase memory in environment config:
{
  "resources": {
    "cpu": 512,
    "memory": 1024  // Increase from 512
  }
}
```

### Performance Issues

**Slow API Responses**:

1. Check database query performance
   ```typescript
   // Enable query logging
   const prisma = new PrismaClient({
     log: ['query'],
   });
   ```

2. Add database indexes
   ```prisma
   model Document {
     id String @id
     userId String
     @@index([userId])  // Add index
   }
   ```

3. Monitor CloudWatch metrics for bottlenecks

**Database Connection Pool Exhausted**:

```typescript
// Increase pool size (default: 10)
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `${process.env.DATABASE_URL}?connection_limit=20`
    }
  }
});
```

## Rollback Procedures

### Quick Rollback

```bash
# Deploy previous version (if using git hash tagging)
semiont publish --service backend --image-tag <previous-git-hash>
semiont update --service backend --wait
```

### ECS Task Definition Rollback

```bash
# Revert to previous task definition
aws ecs update-service \
  --cluster semiont-production \
  --service backend \
  --task-definition backend-production:<previous-revision>
```

### Database Rollback

**Warning**: Database rollbacks are complex. Plan migrations carefully.

```bash
# For emergency rollback, restore from snapshot
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier semiont-restored \
  --db-snapshot-identifier semiont-snapshot-<timestamp>
```

## Environment-Specific Configuration

### Development/Staging

```json
{
  "deployment": {
    "imageTagStrategy": "mutable",
    "autoScale": false
  },
  "resources": {
    "cpu": 256,
    "memory": 512
  }
}
```

### Production

```json
{
  "deployment": {
    "imageTagStrategy": "immutable",
    "autoScale": true,
    "minTasks": 2,
    "maxTasks": 10
  },
  "resources": {
    "cpu": 512,
    "memory": 1024
  }
}
```

## Related Documentation

- **[System Deployment Guide](../../../docs/DEPLOYMENT.md)** - Complete deployment procedures for all services
- [AWS Platform Docs](../../../docs/platforms/AWS.md) - AWS infrastructure and networking
- [Development Guide](./DEVELOPMENT.md) - Local development and testing before deployment
- [Testing Guide](./TESTING.md) - Running tests before deployment

---

**Last Updated**: 2025-10-23
**Scope**: Backend build, deployment, and monitoring
