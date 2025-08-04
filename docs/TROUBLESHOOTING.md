# Semiont Troubleshooting Guide

This guide provides commands to view logs, perform health checks, and resolve common issues with the Semiont semantic knowledge platform infrastructure.

## Quick Health Check Commands

### Overall System Health

```bash
# Quick health check using management scripts
./scripts/semiont status
./scripts/semiont health-check

# Check all stack resources
aws cloudformation describe-stack-resources --stack-name SemiontInfraStack
aws cloudformation describe-stack-resources --stack-name SemiontAppStack

# Get all stack outputs
aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs'
aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs'

# Quick service status check for both services
aws ecs describe-services --cluster SemiontCluster --services semiont-frontend semiont-backend --query 'services[*].{Service:serviceName,Status:status,Running:runningCount,Desired:desiredCount}'
```

## Log Access Commands

### ECS Container Logs

```bash
# Using management scripts (recommended)
./scripts/semiont logs frontend tail
./scripts/semiont logs backend tail
./scripts/semiont logs follow  # Follow both services

# List log streams
LOG_GROUP=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LogGroupName`].OutputValue' --output text)
aws logs describe-log-streams --log-group-name $LOG_GROUP --order-by LastEventTime --descending

# Get recent logs (last 1 hour)
aws logs filter-log-events --log-group-name $LOG_GROUP \
  --start-time $(($(date +%s) - 3600))000

# Get logs with error filter
aws logs filter-log-events --log-group-name $LOG_GROUP \
  --filter-pattern "[timestamp, request_id, level=ERROR || level=CRITICAL]" \
  --start-time $(($(date +%s) - 3600))000

# Follow logs in real-time (requires AWS CLI v2)
aws logs tail $LOG_GROUP --follow
```

### Database Logs

```bash
# Get RDS instance identifier
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)

# List available log files
aws rds describe-db-log-files --db-instance-identifier $DB_IDENTIFIER

# Download recent error log
aws rds download-db-log-file-portion --db-instance-identifier $DB_IDENTIFIER \
  --log-file-name error/postgresql.log --starting-token 0

# Check database connection from backend
./scripts/semiont exec backend 'pg_isready -h $DB_HOST -p $DB_PORT'
```

### Load Balancer Access Logs

```bash
# Get ALB ARN
ALB_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerArn`].OutputValue' --output text)

# Check if access logging is enabled
aws elbv2 describe-load-balancer-attributes --load-balancer-arn $ALB_ARN --query 'Attributes[?Key==`access_logs.s3.enabled`]'

# Check target group health for both services
FRONTEND_TG=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`FrontendTargetGroupArn`].OutputValue' --output text)
BACKEND_TG=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`BackendTargetGroupArn`].OutputValue' --output text)

aws elbv2 describe-target-health --target-group-arn $FRONTEND_TG
aws elbv2 describe-target-health --target-group-arn $BACKEND_TG
```

### CloudTrail Logs (API Activity)

```bash
# Look for recent API calls related to the stacks
aws logs filter-log-events --log-group-name CloudTrail/SemiontEvents \
  --filter-pattern "{ $.sourceIPAddress != \"*.amazonaws.com\" && $.eventName = *Semiont* }" \
  --start-time $(($(date +%s) - 86400))000

# Check for OAuth-related events
aws logs filter-log-events --log-group-name CloudTrail/SemiontEvents \
  --filter-pattern "{ $.eventName = *Secret* || $.eventName = *OAuth* }" \
  --start-time $(($(date +%s) - 86400))000
```

## Manual Health Checks

### ECS Service Health

```bash
# Using management scripts (recommended)
./scripts/semiont status
./scripts/semiont health-check

# Detailed ECS service status for both services
aws ecs describe-services --cluster SemiontCluster --services semiont-frontend semiont-backend

# List running tasks per service
aws ecs list-tasks --cluster SemiontCluster --service-name semiont-frontend
aws ecs list-tasks --cluster SemiontCluster --service-name semiont-backend

# Get task details for frontend
FRONTEND_TASK=$(aws ecs list-tasks --cluster SemiontCluster --service-name semiont-frontend --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster SemiontCluster --tasks $FRONTEND_TASK

# Get task details for backend
BACKEND_TASK=$(aws ecs list-tasks --cluster SemiontCluster --service-name semiont-backend --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster SemiontCluster --tasks $BACKEND_TASK

# Check task definitions
aws ecs describe-task-definition --task-definition semiont-frontend
aws ecs describe-task-definition --task-definition semiont-backend
```

### Database Health

```bash
# Quick database check from backend
./scripts/semiont exec backend 'pg_isready -h $DB_HOST -p $DB_PORT'

# RDS instance status
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)
aws rds describe-db-instances --db-instance-identifier $DB_IDENTIFIER --query 'DBInstances[0].{Status:DBInstanceStatus,Endpoint:Endpoint.Address,Engine:Engine,Version:EngineVersion}'

# Database connection test from backend service
./scripts/semiont exec backend 'npx prisma db pull --print'

# Check database metrics
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=$DB_IDENTIFIER \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

# Check database connections
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=$DB_IDENTIFIER \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Maximum
```

### Load Balancer Health

```bash
# Get ALB DNS and test access
ALB_DNS=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' --output text)

# Test frontend health
curl -I http://$ALB_DNS

# Test backend API health
curl -I http://$ALB_DNS/api/health
curl http://$ALB_DNS/api/health | jq .

# ALB status details
ALB_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerArn`].OutputValue' --output text)
aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN

# Target group health for both services
FRONTEND_TG=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`FrontendTargetGroupArn`].OutputValue' --output text)
BACKEND_TG=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`BackendTargetGroupArn`].OutputValue' --output text)

echo "Frontend Target Health:"
aws elbv2 describe-target-health --target-group-arn $FRONTEND_TG

echo "Backend Target Health:"
aws elbv2 describe-target-health --target-group-arn $BACKEND_TG
```

### CloudFront Distribution Health

```bash
# Get distribution details
DISTRIBUTION_ID=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text)
aws cloudfront get-distribution --id $DISTRIBUTION_ID --query 'Distribution.{Status:Status,DomainName:DomainName,Origins:Origins}'

# Test CloudFront endpoint
CLOUDFRONT_DOMAIN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomainName`].OutputValue' --output text)
curl -I https://$CLOUDFRONT_DOMAIN

# Check cache statistics
aws cloudwatch get-metric-statistics --namespace AWS/CloudFront --metric-name CacheHitRate \
  --dimensions Name=DistributionId,Value=$DISTRIBUTION_ID Name=Global,Value=Global \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average
```

### EFS File System Health

```bash
# Get EFS file system ID
EFS_ID=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`EFSFileSystemId`].OutputValue' --output text)

# Check EFS file system status
aws efs describe-file-systems --file-system-id $EFS_ID

# Check mount targets
aws efs describe-mount-targets --file-system-id $EFS_ID

# Check EFS metrics
aws cloudwatch get-metric-statistics --namespace AWS/EFS --metric-name ClientConnections \
  --dimensions Name=FileSystemId,Value=$EFS_ID \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

# Check file system usage from backend
./scripts/semiont exec backend 'df -h | grep efs'
```

### WAF Status

```bash
# Get Web ACL ARN
WEB_ACL_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`WebACLArn`].OutputValue' --output text)

# Get Web ACL details
aws wafv2 get-web-acl --scope REGIONAL --id ${WEB_ACL_ARN##*/} --name ${WEB_ACL_ARN##*/} --query 'WebACL.{Name:Name,Rules:Rules[].Name}'

# Check recent blocked requests
aws wafv2 get-sampled-requests --web-acl-arn $WEB_ACL_ARN \
  --rule-metric-name RateLimitMetric --scope REGIONAL \
  --time-window StartTime=$(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ"),EndTime=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  --max-items 10

# Check WAF metrics
aws cloudwatch get-metric-statistics --namespace AWS/WAFV2 --metric-name BlockedRequests \
  --dimensions Name=WebACL,Value=${WEB_ACL_ARN##*/} Name=Region,Value=$(aws configure get region) Name=Rule,Value=ALL \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Sum
```

## Common Issues and Solutions

### 1. Application Not Loading

**Symptoms:**

- HTTP 502/503 errors from load balancer
- "Service Unavailable" messages
- No response from frontend or backend
- OAuth sign-in failures

**Diagnostic Commands:**

```bash
# Quick status check
./scripts/semiont status

# Check ECS service health for both services
aws ecs describe-services --cluster SemiontCluster --services semiont-frontend semiont-backend --query 'services[*].{Service:serviceName,Running:runningCount,Pending:pendingCount,Desired:desiredCount}'

# Check task failures
./scripts/semiont logs frontend tail | grep -i error
./scripts/semiont logs backend tail | grep -i error

# Get detailed task information
FRONTEND_TASK=$(aws ecs list-tasks --cluster SemiontCluster --service-name semiont-frontend --query 'taskArns[0]' --output text)
BACKEND_TASK=$(aws ecs list-tasks --cluster SemiontCluster --service-name semiont-backend --query 'taskArns[0]' --output text)

aws ecs describe-tasks --cluster SemiontCluster --tasks $FRONTEND_TASK --query 'tasks[0].containers[0].{Name:name,Status:lastStatus,Reason:reason,Health:healthStatus}'
aws ecs describe-tasks --cluster SemiontCluster --tasks $BACKEND_TASK --query 'tasks[0].containers[0].{Name:name,Status:lastStatus,Reason:reason,Health:healthStatus}'
```

**Common Causes & Solutions:**

- **Database connection failure:** Check security groups, verify database is running
- **Memory/CPU limits exceeded:** Review CloudWatch metrics, adjust task definition
- **Container image build issues:** Check image exists and is accessible
- **Environment variable misconfiguration:** Verify Secrets Manager values
- **OAuth misconfiguration:** Check Google OAuth credentials in Secrets Manager
- **Frontend/Backend communication issues:** Verify ALB routing rules

**Resolution Steps:**

```bash
# Restart all services
./scripts/semiont restart

# Or restart individual services
./scripts/semiont restart frontend
./scripts/semiont restart backend

# Force service deployment to restart tasks
aws ecs update-service --cluster SemiontCluster --service semiont-frontend --force-new-deployment
aws ecs update-service --cluster SemiontCluster --service semiont-backend --force-new-deployment

# Scale services down and up
./scripts/semiont scale frontend 0
./scripts/semiont scale backend 0
# Wait a moment
./scripts/semiont scale frontend 1
./scripts/semiont scale backend 1
```

### 2. Database Connection Issues

**Symptoms:**

- Backend API returning database errors
- "Could not connect to database" in backend logs
- Prisma connection pool exhaustion
- Slow API response times

**Diagnostic Commands:**

```bash
# Test database connectivity from backend
./scripts/semiont exec backend 'pg_isready -h $DB_HOST -p $DB_PORT'

# Check Prisma connection
./scripts/semiont exec backend 'npx prisma db pull --print'

# Check RDS instance status
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)
aws rds describe-db-instances --db-instance-identifier $DB_IDENTIFIER --query 'DBInstances[0].{Status:DBInstanceStatus,MultiAZ:MultiAZ,AvailabilityZone:AvailabilityZone}'

# Check database connections metric
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=$DB_IDENTIFIER \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Maximum

# Verify security groups
DB_SG=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseSecurityGroupId`].OutputValue' --output text)
aws ec2 describe-security-groups --group-ids $DB_SG
```

**Common Causes & Solutions:**

- **Security group misconfiguration:** Verify ECS security group can access database port 5432
- **Database instance stopped/rebooting:** Check RDS console for maintenance events
- **Prisma connection pool exhaustion:** Increase pool size in backend configuration
- **Network connectivity:** Verify VPC subnets and routing
- **Database migrations pending:** Check backend logs for migration errors
- **Transaction deadlocks:** Monitor for long-running queries

### 3. High CPU/Memory Usage

**Symptoms:**

- Slow application response times
- Auto-scaling events triggered frequently
- High CloudWatch metrics for ECS tasks
- Frontend or backend service degradation
- Memory leaks in Node.js processes

**Diagnostic Commands:**

```bash
# Check service metrics using management scripts
./scripts/semiont status

# Check ECS service metrics for both services
aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=semiont-frontend Name=ClusterName,Value=SemiontCluster \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=semiont-backend Name=ClusterName,Value=SemiontCluster \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

# Check auto-scaling activity
aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id service/SemiontCluster/semiont-frontend
aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id service/SemiontCluster/semiont-backend
```

**Resolution Steps:**

- Increase task CPU/memory limits in CDK and redeploy
- Optimize application code (memory leaks, inefficient algorithms)
- Enable API response caching in backend
- Consider horizontal scaling with more tasks
- Review and optimize Prisma queries
- Implement request rate limiting

### 4. CloudFront Caching Issues

**Symptoms:**

- Stale content being served
- Cache hit ratio low
- Frontend assets not updating
- API responses being cached incorrectly

**Diagnostic Commands:**

```bash
# Get CloudFront distribution details
DISTRIBUTION_ID=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text)
CLOUDFRONT_DOMAIN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomainName`].OutputValue' --output text)

# Check cache statistics
aws cloudwatch get-metric-statistics --namespace AWS/CloudFront --metric-name CacheHitRate \
  --dimensions Name=DistributionId,Value=$DISTRIBUTION_ID Name=Global,Value=Global \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

# Test cache headers for frontend
curl -I https://$CLOUDFRONT_DOMAIN/

# Test cache headers for API (should bypass cache)
curl -I https://$CLOUDFRONT_DOMAIN/api/health
```

**Resolution Steps:**

```bash
# Create cache invalidation
aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"

# Check invalidation status
INVALIDATION_ID=$(aws cloudfront list-invalidations --distribution-id $DISTRIBUTION_ID --query 'InvalidationList.Items[0].Id' --output text)
aws cloudfront get-invalidation --distribution-id $DISTRIBUTION_ID --id $INVALIDATION_ID
```

### 5. WAF Blocking Legitimate Traffic

**Symptoms:**

- Users receiving 403 Forbidden errors
- Rate limiting affecting normal usage
- Legitimate API requests being blocked
- OAuth callbacks being blocked

**Diagnostic Commands:**

```bash
# Get WAF ARN
WEB_ACL_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`WebACLArn`].OutputValue' --output text)

# Check WAF blocked requests
aws wafv2 get-sampled-requests --web-acl-arn $WEB_ACL_ARN \
  --rule-metric-name CommonRuleSetMetric --scope REGIONAL \
  --time-window StartTime=$(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ"),EndTime=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  --max-items 100

# Check rate limit metrics
aws cloudwatch get-metric-statistics --namespace AWS/WAFV2 --metric-name BlockedRequests \
  --dimensions Name=WebACL,Value=${WEB_ACL_ARN##*/} Name=Region,Value=$(aws configure get region) Name=Rule,Value=RateLimitRule \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Sum
```

**Resolution Steps:**

- Review and adjust WAF rules in AWS Console
- Add IP allowlist for trusted sources
- Increase rate limiting thresholds if appropriate
- Temporarily disable problematic rules for investigation

### 6. EFS File System Issues

**Symptoms:**

- File upload/download failures
- "Permission denied" errors
- Slow file operations
- Mount point not accessible

**Diagnostic Commands:**

```bash
# Check EFS mount from backend service
./scripts/semiont exec backend 'df -h | grep efs'
./scripts/semiont exec backend 'ls -la /mnt/efs'

# Get EFS file system ID and check status
EFS_ID=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`EFSFileSystemId`].OutputValue' --output text)
aws efs describe-file-systems --file-system-id $EFS_ID

# Check mount targets
aws efs describe-mount-targets --file-system-id $EFS_ID

# Check EFS performance metrics
aws cloudwatch get-metric-statistics --namespace AWS/EFS --metric-name PercentIOLimit \
  --dimensions Name=FileSystemId,Value=$EFS_ID \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average

# Test file operations from backend
./scripts/semiont exec backend 'touch /mnt/efs/test.txt && echo "test" > /mnt/efs/test.txt && cat /mnt/efs/test.txt && rm /mnt/efs/test.txt'
```

### 7. OAuth Authentication Issues

**Symptoms:**

- "Sign in with Google" not working
- "invalid_client" errors
- Domain not allowed errors
- Session not persisting

**Diagnostic Commands:**

```bash
# Check OAuth configuration
./scripts/semiont secrets get oauth/google

# Check OAuth environment variables
./scripts/semiont exec frontend 'env | grep -E "(GOOGLE|NEXTAUTH|OAUTH)"'

# List all secrets (including OAuth)
./scripts/semiont secrets list

# Check NextAuth logs
./scripts/semiont logs frontend tail | grep -i "nextauth\|oauth\|google"
```

**Common Causes & Solutions:**

- **Invalid OAuth credentials:** Verify Google Client ID and Secret are correct
- **Wrong redirect URI:** Ensure redirect URI in Google Console matches your domain
- **Domain restrictions:** Check OAUTH_ALLOWED_DOMAINS environment variable
- **Session secret missing:** Verify NEXTAUTH_SECRET is set
- **HTTPS requirement:** OAuth requires HTTPS in production

### 8. Cost Budget Exceeded

**Symptoms:**

- Budget alert notifications
- Unexpected high AWS costs
- Services consuming more resources than anticipated

**Diagnostic Commands:**

```bash
# Check current month costs
aws ce get-cost-and-usage --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY --metrics BlendedCost

# Get cost breakdown by service
aws ce get-cost-and-usage --time-period Start=$(date -d "7 days ago" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY --metrics BlendedCost --group-by Type=DIMENSION,Key=SERVICE

# Check service scaling
./scripts/semiont status

# Check for runaway auto-scaling
aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id service/SemiontCluster/semiont-frontend
aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id service/SemiontCluster/semiont-backend
```

**Cost Optimization Actions:**

- Scale down ECS services if over-provisioned
- Review RDS instance sizing
- Optimize CloudFront caching to reduce origin requests
- Clean up unused resources
- Consider using Fargate Spot for development
- Review EFS throughput mode (bursting vs provisioned)

## Emergency Procedures

### Complete Service Restart

```bash
# Restart all services using management scripts
./scripts/semiont restart

# Or manually scale services to 0 and back
./scripts/semiont scale frontend 0
./scripts/semiont scale backend 0
# Wait for services to stop
sleep 30
./scripts/semiont scale frontend 2
./scripts/semiont scale backend 2

# Using AWS CLI directly
aws ecs update-service --cluster SemiontCluster --service semiont-frontend --desired-count 0
aws ecs update-service --cluster SemiontCluster --service semiont-backend --desired-count 0
aws ecs wait services-stable --cluster SemiontCluster --services semiont-frontend semiont-backend
aws ecs update-service --cluster SemiontCluster --service semiont-frontend --desired-count 2
aws ecs update-service --cluster SemiontCluster --service semiont-backend --desired-count 2
```

### Database Emergency Procedures

```bash
# Get database identifier
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)

# Create manual database snapshot
aws rds create-db-snapshot --db-instance-identifier $DB_IDENTIFIER --db-snapshot-identifier emergency-snapshot-$(date +%Y%m%d%H%M%S)

# Check for blocking queries
./scripts/semiont exec backend 'psql $DATABASE_URL -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query FROM pg_stat_activity WHERE (now() - pg_stat_activity.query_start) > interval \'5 minutes\';"'

# Reboot database (last resort)
aws rds reboot-db-instance --db-instance-identifier $DB_IDENTIFIER

# Run database migrations manually if needed
./scripts/semiont exec backend 'npx prisma db push'
```

### Enable Enhanced Monitoring (During Incidents)

```bash
# Enable ECS Container Insights (if not already enabled)
aws ecs put-account-setting --name containerInsights --value enabled

# Enable RDS Performance Insights
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)
aws rds modify-db-instance --db-instance-identifier $DB_IDENTIFIER --enable-performance-insights

# Enable execute command for debugging
aws ecs update-service --cluster SemiontCluster --service semiont-frontend --enable-execute-command
aws ecs update-service --cluster SemiontCluster --service semiont-backend --enable-execute-command

# Access containers for live debugging
./scripts/semiont exec frontend /bin/sh
./scripts/semiont exec backend /bin/sh
```

## Monitoring and Alerting Verification

### Test Alert Notifications

```bash
# Get alarm names from CloudFormation
FRONTEND_CPU_ALARM=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`FrontendCPUAlarmName`].OutputValue' --output text)
BACKEND_CPU_ALARM=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`BackendCPUAlarmName`].OutputValue' --output text)

# Trigger test alarms
aws cloudwatch set-alarm-state --alarm-name $FRONTEND_CPU_ALARM --state-value ALARM --state-reason "Testing alert system"
aws cloudwatch set-alarm-state --alarm-name $BACKEND_CPU_ALARM --state-value ALARM --state-reason "Testing alert system"

# Reset alarms
aws cloudwatch set-alarm-state --alarm-name $FRONTEND_CPU_ALARM --state-value OK --state-reason "Test complete"
aws cloudwatch set-alarm-state --alarm-name $BACKEND_CPU_ALARM --state-value OK --state-reason "Test complete"
```

### Verify SNS Subscriptions

```bash
# List SNS topic subscriptions
SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`SNSTopicArn`].OutputValue' --output text)
aws sns list-subscriptions-by-topic --topic-arn $SNS_TOPIC_ARN

# Send test notification
aws sns publish --topic-arn $SNS_TOPIC_ARN --message "Test notification from Semiont troubleshooting" --subject "Test Alert"
```

## Performance Baselines

### Establish Performance Baselines

```bash
# Get ALB ARN for metrics
ALB_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerArn`].OutputValue' --output text)
LB_SUFFIX=$(echo $ALB_ARN | cut -d'/' -f2-)

# Get average response time over last 24 hours
aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name TargetResponseTime \
  --dimensions Name=LoadBalancer,Value=$LB_SUFFIX \
  --start-time $(date -d "24 hours ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 3600 --statistics Average

# Get typical CPU usage for both services
aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=semiont-frontend Name=ClusterName,Value=SemiontCluster \
  --start-time $(date -d "24 hours ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 3600 --statistics Average

aws cloudwatch get-metric-statistics --namespace AWS/ECS --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=semiont-backend Name=ClusterName,Value=SemiontCluster \
  --start-time $(date -d "24 hours ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 3600 --statistics Average

# Check API health endpoint response times
for i in {1..10}; do
  curl -w "Time: %{time_total}s\n" -o /dev/null -s http://$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' --output text)/api/health
done
```

Use these baselines to detect performance degradation and set appropriate alarm thresholds.

## Additional Resources

- **Management Scripts**: Use `./scripts/semiont --help` for all available commands
- **Application Logs**: Both services log to CloudWatch with structured JSON format
- **Health Endpoints**:
  - Frontend: `http://<ALB-DNS>/`
  - Backend API: `http://<ALB-DNS>/api/health`
- **Database**: Prisma-based PostgreSQL with automatic migrations
- **OAuth**: Google OAuth with domain restrictions configured in environment variables

This troubleshooting guide should be updated as new issues are discovered and resolved.
