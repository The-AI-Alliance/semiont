# Semiont Deployment Guide

This guide provides comprehensive instructions for deploying Semiont to AWS, including when and how building happens.

## Table of Contents
- [Quick Start](#quick-start)
- [Understanding Build & Deploy](#understanding-build--deploy)
- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Deployment Workflow](#deployment-workflow)
- [Monitoring & Maintenance](#monitoring--maintenance)
- [Troubleshooting](#troubleshooting)

## Quick Start

```bash
# First time setup
semiont init --name "my-project"
export SEMIONT_ENV=production

# Deploy to AWS
semiont provision   # One-time: Create infrastructure (~10-15 min)
semiont publish     # Build and push container images (~5-8 min)

# Update after code changes
semiont test        # Run tests (recommended)
semiont publish     # Build and push updated images
```

## Understanding Build & Deploy

### When Building Happens

**Local Development** - No build needed:
- Frontend runs with Next.js dev server (hot reload)
- Backend runs with nodemon (auto-restart)
- Changes reflect immediately without building
- Use `npm run dev` in each app directory

**Production Deployment** - Automatic building:
- `semiont publish` handles container image management:
  1. Builds optimized Docker/Podman images
  2. Tags images appropriately  
  3. Pushes to AWS ECR
  4. ECS automatically pulls new images
  5. Rolling deployment with health checks

**Manual Building** (rarely needed):
```bash
# If you need to build locally for testing
cd apps/frontend && npm run build
cd apps/backend && npm run build
```

### Build Process Details

The `semiont publish` command orchestrates the entire build and deployment:

1. **Test Phase** (~1-3 minutes)
   - Runs unit tests for frontend and backend
   - Runs integration tests
   - Runs security validation tests
   - Deployment stops if any test fails

2. **Build Phase** (~2-4 minutes)
   - Creates optimized production builds
   - Frontend: Next.js static optimization, tree shaking, minification
   - Backend: TypeScript compilation, dependency bundling
   - Docker images built with multi-stage builds for minimal size

3. **Push Phase** (~1-2 minutes)
   - Tags images with timestamp and git commit
   - Pushes to AWS ECR (Elastic Container Registry)
   - Maintains last 5 versions for rollback

4. **Deploy Phase** (~2-3 minutes)
   - Updates ECS task definitions
   - Performs rolling update with zero downtime
   - Health checks ensure new version is healthy
   - Automatic rollback if health checks fail

## Prerequisites

### Required Tools
- Node.js 18+ and npm 9+
- Docker or Podman (for container builds)
- AWS CLI configured with credentials
- Semiont CLI installed (`cd apps/cli && npm run build && npm link`)

### AWS Account Setup
- AWS account with appropriate IAM permissions
- Services needed: VPC, ECS, RDS, ECR, ALB, CloudFront, WAF, Secrets Manager
- Estimated cost: ~$120/month for small deployments

### AWS Credentials

The CLI uses standard AWS credential chain:
```bash
# Option 1: AWS CLI configuration
aws configure

# Option 2: AWS SSO
aws sso login

# Option 3: Environment variables
export AWS_ACCESS_KEY_ID=xxx
export AWS_SECRET_ACCESS_KEY=xxx
export AWS_REGION=us-east-1
```

## Initial Setup

### 1. Initialize Project

```bash
# Clone and setup
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont
npm install

# Initialize configuration
semiont init --name "my-project" --environments "local,staging,production"

# Install CLI globally
cd apps/cli && npm run build && npm link
```

### 2. Configure Environments

Edit configuration files in `config/environments/`:

```json
// config/environments/production.json
{
  "name": "production",
  "site": {
    "domain": "yourdomain.com",
    "siteName": "Your Site Name",
    "adminEmail": "admin@yourdomain.com"
  },
  "aws": {
    "region": "us-east-1",
    "accountId": "123456789012"
  }
}
```

### 3. Set Environment

```bash
# Set default environment
export SEMIONT_ENV=production

# Or specify per command
semiont publish --environment production
```

## Deployment Workflow

### First-Time Deployment

#### Step 1: Provision Infrastructure
```bash
semiont provision
```

Creates all AWS resources (~10-15 minutes):
- VPC with public/private subnets
- RDS PostgreSQL database
- ECS Fargate cluster
- Application Load Balancer
- CloudFront CDN
- WAF firewall rules
- ECR repositories
- Secrets Manager entries

#### Step 2: Configure Secrets
```bash
# Set OAuth credentials (interactive)
semiont configure set oauth/google

# Set JWT secret
semiont configure set jwt-secret

# Verify configuration
semiont configure show
```

#### Step 3: Deploy Application
```bash
semiont publish
```

This command:
- Runs all tests (stops if tests fail)
- Builds Docker images for frontend and backend
- Pushes images to ECR
- Updates ECS services
- Performs health checks
- Shows deployment progress

### Updating After Code Changes

For subsequent deployments after code changes:

```bash
# Make your code changes
git add .
git commit -m "Your changes"

# Test locally
semiont test

# Deploy to production
semiont publish  # Automatically builds and deploys
```

The deploy process is intelligent:
- Only rebuilds changed components
- Uses Docker layer caching for faster builds
- Performs zero-downtime rolling updates
- Automatic rollback on failures

### Environment-Specific Deployments

```bash
# Deploy to different environments
semiont publish --environment staging
semiont publish --environment production

# Or use SEMIONT_ENV
export SEMIONT_ENV=staging
semiont publish
```

## Monitoring & Maintenance

### Real-Time Monitoring

```bash
# Interactive dashboard
semiont watch

# Stream logs
semiont watch logs

# View metrics
semiont watch metrics

# Check service health
semiont check
```

### Service Management

```bash
# Restart services
semiont restart --service backend
semiont restart --service all

# Stop services (cost savings)
semiont stop --service all

# Start services
semiont start --service all
```

### Backup and Recovery

```bash
# Create backup
semiont backup

# List backups
semiont backup list

# Restore from backup
semiont restore --backup-id xxx
```

## Troubleshooting

### Common Issues

#### Build Failures

If `semiont publish` fails during build:
```bash
# Check test results
semiont test --verbose

# Try building manually to see detailed errors
cd apps/frontend && npm run build
cd apps/backend && npm run build

# Check Docker daemon
docker ps
```

#### Deployment Failures

If deployment fails after successful build:
```bash
# Check AWS credentials
aws sts get-caller-identity

# Check ECS service status
semiont check --verbose

# View deployment logs
semiont watch logs --service backend

# Force a fresh deployment
semiont publish --force
```

#### Health Check Failures

If services fail health checks:
```bash
# Check application logs
semiont watch logs

# Verify database connectivity
semiont check --service database

# Check environment configuration
semiont configure validate
```

### Manual Rollback

If automatic rollback fails:
```bash
# List previous deployments
aws ecs list-task-definitions --family semiont-backend

# Manually update to previous version
aws ecs update-service \
  --cluster semiont-production \
  --service semiont-backend \
  --task-definition semiont-backend:previous-version
```

## Production Best Practices

### Pre-Deployment Checklist

- [ ] All tests passing locally
- [ ] Configuration validated
- [ ] Secrets properly set
- [ ] Database schema validated
- [ ] Performance benchmarks met
- [ ] Security scan completed

### Deployment Windows

- Deploy during low-traffic periods
- Have rollback plan ready
- Monitor metrics during deployment
- Keep team informed via Slack/email

### Post-Deployment Verification

```bash
# Verify all services healthy
semiont check

# Run smoke tests
semiont test --suite smoke

# Monitor for 15 minutes
semiont watch --duration 15m

# Check error rates
semiont metrics --window 1h
```

## Cost Optimization

### Development Environments

Stop services when not in use:
```bash
# Stop all services (keeps infrastructure)
semiont stop --environment staging

# Start when needed
semiont start --environment staging
```

### Production Optimization

- Use auto-scaling policies
- Right-size RDS instances
- Enable CloudFront caching
- Review CloudWatch metrics regularly
- Set up budget alerts

## Security Considerations

### Secrets Management

- Never commit secrets to git
- Use `semiont configure` for all secrets
- Rotate secrets regularly
- Use IAM roles, not access keys

### Access Control

- Enable MFA for AWS accounts
- Use least-privilege IAM policies
- Restrict deployment to CI/CD pipeline
- Regular security audits

## Advanced Topics

### Custom Docker Images

If you need custom Docker configurations:
```dockerfile
# apps/frontend/Dockerfile.custom
FROM node:18-alpine AS builder
# Your custom build steps...
```

```bash
# Use custom Dockerfile
semiont publish --dockerfile Dockerfile.custom
```

### Blue-Green Deployments

For zero-risk deployments:
```bash
# Deploy to green environment
semiont publish --strategy blue-green

# Switch traffic
semiont switch-traffic --to green

# Rollback if needed
semiont switch-traffic --to blue
```

### CI/CD Integration

Example GitHub Actions workflow:
```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm ci
      - run: npm test
      - run: semiont publish --environment production
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

## Support

For issues or questions:
- Check [Troubleshooting Guide](TROUBLESHOOTING.md)
- Review [Architecture Documentation](ARCHITECTURE.md)
- Open an issue on GitHub
- Contact support@semiont.com

## Next Steps

- [CONFIGURATION.md](CONFIGURATION.md) - Detailed configuration options
- [SCALING.md](SCALING.md) - Performance and scaling guide
- [SECURITY.md](SECURITY.md) - Security best practices
- [MAINTENANCE.md](MAINTENANCE.md) - Operational procedures