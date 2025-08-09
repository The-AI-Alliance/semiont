# Semiont Deployment Guide

This guide provides comprehensive step-by-step instructions for deploying the Semiont semantic knowledge platform on AWS.

## Quick Reference

**Local Development:**
```bash
./bin/semiont start local                 # Start all services locally with Docker
```

**Cloud Deployment (First-time setup):**
```bash
./bin/semiont provision production        # Create AWS infrastructure (10-15 min)
./bin/semiont deploy production           # Deploy applications (8-12 min)
```

**Code changes:**
```bash
./bin/semiont test                        # Run tests (1-3 min) - REQUIRED
./bin/semiont deploy production           # Deploy changes (2-5 min)
```

**Real-time monitoring:**
```bash
./bin/semiont watch                       # Interactive dashboard with services, logs, and metrics
./bin/semiont watch logs                  # Focus on log streaming
```

## Pre-Deployment Checklist

### AWS Prerequisites

- [ ] AWS CLI installed and configured with appropriate credentials
- [ ] AWS account with sufficient permissions for:
  - VPC, EC2, RDS, ECS, ALB, CloudFront, WAF, EFS
  - Secrets Manager, CloudWatch, SNS, Budgets, IAM
- [ ] CDK bootstrapped in target region: `npx cdk bootstrap`
- [ ] Docker installed and running (for container builds)

### Development Environment

- [ ] Node.js 18+ installed
- [ ] npm or yarn package manager
- [ ] AWS CDK CLI: `npm install -g aws-cdk`
- [ ] Git for version control

### Cost Considerations

- [ ] Understand estimated monthly costs (starting ~$120/month for 10 users)
- [ ] Budget alerts configured with appropriate spending limits
- [ ] Consider using AWS Free Tier resources if available
- [ ] Review [SCALING.md](SCALING.md) for cost projections at different user scales

## Step-by-Step Deployment

### 1. Project Setup

```bash
# Clone the repository
git clone https://github.com/The-AI-Alliance/semiont.git
cd semiont

# Install root dependencies
npm install

# Install application dependencies
cd apps/frontend && npm install
cd ../backend && npm install

# Install CDK dependencies
cd ../../cdk && npm install
```

**Validation Test:**

```bash
# Verify CDK can synthesize the stacks
npx cdk synth SemiontInfraStack
npx cdk synth SemiontAppStack
```

### 2. Environment Configuration

Set environment variables (optional):

```bash
export CDK_DEFAULT_ACCOUNT="123456789012"
export CDK_DEFAULT_REGION="us-east-1"
```

**Validation Test:**

```bash
# Verify AWS credentials
aws sts get-caller-identity
aws configure list
```

### 3. Secrets Management

Semiont uses AWS Secrets Manager to store sensitive credentials. Before deployment, you'll need to configure secrets for OAuth, JWT, and other sensitive data.

#### Understanding Configuration vs Secrets

- **Configuration**: Public settings stored in `/config/environments/` (checked into git)
- **Secrets**: Private credentials stored in AWS Secrets Manager (never in git)

#### Managing Secrets

```bash
# List all available secrets
./bin/semiont secrets list

# Set OAuth credentials (interactive)
./bin/semiont secrets set oauth/google

# Set JWT signing secret
./bin/semiont secrets set jwt-secret "your-32-character-secret-key"

# View secret status (values are masked)
./bin/semiont secrets get oauth/google
```

#### Required Secrets

Before first deployment, ensure these secrets are configured:

1. **OAuth Credentials**: `oauth/google` (clientId and clientSecret)
2. **JWT Secret**: `jwt-secret` (for API authentication)
3. **App Secrets**: `app-secrets` (session and NextAuth secrets)

**Note**: Secrets are created automatically during infrastructure deployment, but you need to populate them with actual values.

### 4. Pre-Deployment Verification

```bash
# Check for any security issues or policy violations
npx cdk diff SemiontAppStack

# Validate Docker can build the application images
docker build -t semiont-frontend-test apps/frontend
docker build -t semiont-backend-test apps/backend
docker rmi semiont-frontend-test semiont-backend-test
```

### 5. Deployment Workflow

Semiont uses a simple two-step deployment model:

#### **Step 5a: Provision Infrastructure** (One-time setup)

```bash
# Create all AWS infrastructure for the specified environment
./bin/semiont provision production
```

**Expected Deployment Time:** 10-15 minutes

**Resources Created:**
- VPC with 3-tier subnet architecture  
- RDS PostgreSQL database
- EFS file system for persistent storage
- Secrets Manager secrets
- Security groups and IAM roles
- ECS Fargate cluster
- Application Load Balancer with intelligent routing
- WAF Web ACL with security rules
- CloudWatch monitoring and SNS alerts
- Cost budgets and alarms

## Ongoing Development Workflow

After the initial deployment, code changes only require testing and deployment:

```bash
# For code changes after initial setup:
./bin/semiont test           # Run tests - REQUIRED before deployment
./bin/semiont deploy production  # Deploy changes (builds and pushes automatically)
```

**Expected Time:** 3-8 minutes total (includes mandatory testing)

This workflow:
1. Runs comprehensive tests (frontend, backend, security)
2. Builds new Docker images with your code changes (only if tests pass)
3. Pushes images to ECR with timestamped tags
4. Updates ECS task definitions to use new images
5. Deploys new ECS tasks with zero-downtime rolling updates

The `provision` command is only needed for:
- Initial deployment
- Infrastructure changes (modifying CDK stacks)
- Recovery from stack deletion

## Testing Requirements

**Testing is mandatory before any deployment.** The `deploy` command will not proceed without successful test completion.

### Test Suite Overview

```bash
# Run all tests (required before deployment)
./bin/semiont test

# Run specific test suites
./bin/semiont test frontend    # Frontend tests only
./bin/semiont test backend     # Backend tests only
./bin/semiont test security    # Security-focused tests

# Advanced testing options
./bin/semiont test --coverage  # Generate coverage reports
./bin/semiont test --watch     # Development mode with file watching
```

### Test Types

The test suite includes:

- **🎨 Frontend Tests**: Jest with React Testing Library
  - Component rendering and behavior
  - User interaction flows
  - Authentication state management
  - API integration tests

- **🚀 Backend Tests**: Jest with Supertest for API testing
  - API endpoint validation
  - Database operations
  - Authentication middleware
  - Error handling

- **🔒 Security Tests**: Cross-application security validation
  - Input validation and sanitization
  - Authentication and authorization flows
  - CSRF and XSS protection
  - OAuth security compliance

### Test Failure Handling

If tests fail:

1. **Fix the issues** - Review test output for specific failures
2. **Re-run tests** - `./bin/semiont test`
3. **Only then deploy** - `./bin/semiont deploy production`

**Deployment will be blocked until all tests pass.**

### 6. Post-Deployment Validation

#### Infrastructure Validation

**Using Management Scripts (Recommended):**

```bash
# Check overall deployment status
./bin/semiont status

# View application logs
./bin/semiont logs follow

# Test application health
./bin/semiont health-check
```

**Manual AWS CLI Verification:**

```bash
# Verify both stacks deployed successfully
aws cloudformation describe-stacks --stack-name SemiontInfraStack
aws cloudformation describe-stacks --stack-name SemiontAppStack

# Check ECS services are running
aws ecs describe-services --cluster SemiontCluster --services semiont-frontend semiont-backend

# Verify RDS instance is available
aws rds describe-db-instances --db-instance-identifier semiont-db

# Test ALB health
ALB_DNS=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' --output text)
curl -I http://$ALB_DNS/api/health
```

#### Application Setup and Verification

1. **Automatic Database Migration:**

   The Semiont backend automatically handles database schema setup:

   ```bash
   # Check backend service logs for migration status
   ./bin/semiont logs backend tail
   
   # Look for migration success messages:
   # "📝 Running database migrations..."
   # "✅ Database migrations completed"
   ```

2. **Monitor Service Health:**

   ```bash
   # Check both services are running
   ./bin/semiont status
   
   # Monitor service startup logs
   ./bin/semiont logs frontend tail
   ./bin/semiont logs backend tail
   
   # Verify health endpoints
   curl http://$ALB_DNS/api/health
   ```

3. **Application Architecture Verification:**

   The Semiont platform consists of two services:
   - **Frontend Service**: Next.js application with OAuth authentication
   - **Backend Service**: Hono API with database access
   - **ALB Routing**: Intelligent path-based routing between services

   **Expected Startup Time:** 3-5 minutes for both services
   **Healthy Status:** Both services show "RUNNING" status

4. **Access the Application:**

   ```bash
   # Get application URLs from stack outputs
   ALB_DNS=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' --output text)
   echo "Semiont ALB URL: http://$ALB_DNS"
   
   # Get CloudFront DNS name
   CF_DNS=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomainName`].OutputValue' --output text)
   echo "Semiont CloudFront URL: https://$CF_DNS"
   
   # Or use the management script
   ./bin/semiont info
   ```

5. **Verify Installation:**
   - Navigate to the ALB or CloudFront URL
   - Semiont frontend should load with sign-in page
   - Test Google OAuth sign-in (requires OAuth configuration)
   - Verify API connectivity: `curl http://$ALB_DNS/api/health`
   - Check domain restrictions are working (see [OAuth.md](OAuth.md))
   - Test frontend/backend communication

#### Troubleshooting Application Setup

If services fail to start:

```bash
# Check service status and events
./bin/semiont status

# View detailed service logs
./bin/semiont logs backend tail
./bin/semiont logs frontend tail

# Common issues:
# - Database connection failures (check security groups)
# - Environment variable misconfiguration
# - Container startup timeout

# Restart services if needed
./bin/semiont restart

# Or restart individual services
./bin/semiont restart backend
./bin/semiont restart frontend
```

### 7. OAuth Configuration (Required)

Before users can sign in, configure Google OAuth:

#### OAuth Configuration

Set up OAuth credentials using the secrets management system:

```bash
# Set OAuth credentials
./bin/semiont secrets set oauth/google

# Verify OAuth credentials
./bin/semiont secrets get oauth/google

# List all secrets
./bin/semiont secrets list
```

For detailed OAuth setup, see the OAuth Configuration section in [CONFIGURATION.md](CONFIGURATION.md).

### 8. DNS and SSL Configuration

#### Option A: Custom Domain with Route 53

```bash
# Create hosted zone (if needed)
aws route53 create-hosted-zone --name example.com --caller-reference $(date +%s)

# Create CNAME record pointing to CloudFront
aws route53 change-resource-record-sets --hosted-zone-id Z123456789 --change-batch '{
  "Changes": [{
    "Action": "CREATE",
    "ResourceRecordSet": {
      "Name": "wiki.example.com",
      "Type": "CNAME", 
      "TTL": 300,
      "ResourceRecords": [{"Value": "<CloudFrontDomainName>"}]
    }
  }]
}'
```

#### Option B: SSL Certificate (ACM)

```bash
# Request certificate for custom domain
aws acm request-certificate --domain-name wiki.example.com --validation-method DNS
```

### 9. Security Hardening

#### Update Application Configuration

```bash
# Update configuration via CDK (recommended)
# Edit config/environments/production.ts
./bin/semiont deploy production

# Or force service restart to pick up new environment
./bin/semiont restart
```

#### Configure WAF (Optional)

- Review WAF rules in AWS Console
- Add IP allowlist/blocklist if needed
- Adjust rate limiting thresholds

### 10. Monitoring Setup

#### Subscribe to Alerts

```bash
# Subscribe email to SNS topic
SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`SNSTopicArn`].OutputValue' --output text)
aws sns subscribe --topic-arn $SNS_TOPIC_ARN --protocol email --notification-endpoint admin@example.com

# Confirm subscription via email
```

#### Verify CloudWatch Dashboard

- Navigate to CloudWatch Console
- Open "Semiont-Monitoring" dashboard
- Verify metrics are populating for both frontend and backend services

### 10. Backup Verification

#### RDS Automated Backups

```bash
# Verify backup settings
aws rds describe-db-instances --db-instance-identifier <db-identifier> \
  --query 'DBInstances[0].{BackupRetentionPeriod:BackupRetentionPeriod,PreferredBackupWindow:PreferredBackupWindow}'
```

#### EFS Backup

```bash
# Verify EFS backup settings
EFS_ID=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`EFSFileSystemId`].OutputValue' --output text)
aws efs describe-backup-policy --file-system-id $EFS_ID
```

## Troubleshooting Deployment Issues

### Common Deployment Failures

#### 1. ECS Tasks Failing to Start

```bash
# Check service status
./bin/semiont status

# Check ECS task logs for both services
./bin/semiont logs backend tail
./bin/semiont logs frontend tail

# Common causes:
# - Database not ready (check security groups)
# - Missing secrets (verify Secrets Manager)
# - Container image build issues
# - Environment variable misconfiguration
```

#### 2. Database Connection Issues

```bash
# Check database connectivity from backend service
./bin/semiont exec backend 'pg_isready -h $DB_HOST -p $DB_PORT'

# Check security group rules allow 5432 from ECS security group
DB_SG_ID=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseSecurityGroupId`].OutputValue' --output text)
aws ec2 describe-security-groups --group-ids $DB_SG_ID
```

#### 3. ALB Health Check Failures

```bash
# Check target group health for both services
FRONTEND_TG_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`FrontendTargetGroupArn`].OutputValue' --output text)
BACKEND_TG_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`BackendTargetGroupArn`].OutputValue' --output text)

aws elbv2 describe-target-health --target-group-arn $FRONTEND_TG_ARN
aws elbv2 describe-target-health --target-group-arn $BACKEND_TG_ARN

# Common causes:
# - Services not responding on expected ports
# - Health check paths returning non-200 status
# - Container startup time exceeding health check grace period
```

### Rollback Procedure

If deployment fails or issues arise:

```bash
# Quick service rollback using management scripts
./bin/semiont restart

# Rollback application deployment only (preserves infrastructure)
./bin/semiont deploy production

# Full rollback (emergency only - destroys all infrastructure)
cd cdk
npx cdk destroy SemiontAppStack
npx cdk destroy SemiontInfraStack
# Then redeploy from scratch
./bin/semiont provision production
./bin/semiont deploy production
```

**Important:** RDS and EFS resources have deletion protection and retain policies. The two-stack model allows you to rollback application changes without affecting the database.

## Performance Optimization

### Post-Deployment Tuning

1. **ECS Service Scaling:**

   ```bash
   # Adjust service desired count if needed
   aws ecs update-service --cluster SemiontCluster \
     --service semiont-frontend --desired-count 2
   aws ecs update-service --cluster SemiontCluster \
     --service semiont-backend --desired-count 2
   
   # Or use management scripts for easier scaling
   ./bin/semiont scale frontend 2
   ./bin/semiont scale backend 2
   ```

2. **RDS Performance:**
   - Monitor CPU and memory usage via CloudWatch
   - Consider upgrading instance class based on usage patterns
   - Enable Performance Insights for detailed monitoring
   - Review [SCALING.md](SCALING.md) for optimization guidance

3. **CloudFront Optimization:**
   - Review cache hit ratios for static assets
   - Adjust TTL values for better performance
   - API routes automatically bypass cache
   - Consider additional edge locations for global users

## Security Validation

### Security Checklist Post-Deployment

- [ ] All secrets stored in Secrets Manager
- [ ] Database in isolated subnets with no internet access
- [ ] WAF rules active and logging
- [ ] EFS file system encrypted at rest and in transit
- [ ] CloudWatch logging enabled for both services
- [ ] Cost budgets and alerts configured
- [ ] OAuth domain restrictions properly configured
- [ ] HTTPS enforced via CloudFront (when custom domain configured)
- [ ] Security groups follow principle of least privilege

### Security Testing

```bash
# Test WAF rate limiting
ALB_DNS=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' --output text)
for i in {1..10}; do curl -s http://$ALB_DNS & done

# Verify database is not publicly accessible
DB_ENDPOINT=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseEndpoint`].OutputValue' --output text)
nmap -p 5432 $DB_ENDPOINT  # Should timeout

# Test OAuth domain restrictions  
./bin/semiont secrets get oauth/google
```

## Cost Monitoring

### Budget Monitoring

- Budget alerts sent to SNS topic at 80% actual spend
- Forecasted alerts at 100% of budget limit
- Review AWS Billing Dashboard regularly

### Cost Optimization Tips

- Use Spot instances for development environments
- Right-size RDS instance based on actual usage
- Monitor CloudFront data transfer costs
- Consider single-AZ RDS for non-production

## Next Steps

After successful deployment:

1. Complete OAuth configuration for user authentication (see [OAuth.md](OAuth.md))
2. Set up regular maintenance procedures (see [MAINTENANCE.md](MAINTENANCE.md))
3. Configure monitoring and alerting (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md))
4. Review scaling plans and cost optimization (see [SCALING.md](SCALING.md))
5. Configure custom domain and SSL certificates if needed
6. Set up backup validation and disaster recovery testing
