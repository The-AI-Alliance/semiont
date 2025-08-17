# Semiont Maintenance Guide

This document outlines all maintenance procedures and schedules for the Semiont semantic knowledge platform infrastructure on AWS.

## Authentication System Notes

### API Authentication Model

The backend implements secure-by-default authentication:
- All API routes require JWT authentication automatically
- Public endpoints must be explicitly whitelisted in `PUBLIC_ENDPOINTS` array
- Authentication middleware is applied globally to `/api/*` routes

### Required Authentication Configuration

For proper authentication operation, ensure:

1. **JWT Secret**: Configured in AWS Secrets Manager (minimum 32 characters)
   ```bash
   semiont configure production set jwt-secret
   ```

2. **OAuth Credentials**: Google OAuth client ID and secret configured
   ```bash
   semiont configure production set oauth/google
   ```

3. **Domain Whitelist**: Email domains allowed to authenticate configured in environment JSON
   ```json
   {
     "site": {
       "oauthAllowedDomains": ["example.com"]
     }
   }
   ```

### Authentication Monitoring

Check authentication system health:
- Monitor failed authentication attempts in CloudWatch logs
- Review JWT expiration patterns and refresh rates
- Verify OAuth callback success rates
- Check for unauthorized API access attempts

## Daily Maintenance

### Automated Daily Tasks

These tasks are handled automatically by AWS services:

- **ECS Health Checks:** Continuous monitoring and replacement of unhealthy tasks
- **RDS Automated Backups:** Daily backups during maintenance window
- **CloudWatch Metrics Collection:** Continuous monitoring of all services
- **Auto Scaling:** Automatic scaling based on CPU/memory thresholds

### Daily Monitoring Checklist (5 minutes)

**CloudWatch Dashboard Review:**

- [ ] Check Semiont-Monitoring dashboard for any anomalies
- [ ] Verify both ECS services (frontend/backend) are running desired number of tasks
- [ ] Review ALB request count and response times for both target groups
- [ ] Check database CPU and connection metrics
- [ ] Monitor dual-service health endpoints (`/api/health`)

**Log Review:**

```bash
# Check recent ECS logs for errors (both services)
semiont watch logs --service backend | grep -i error
semiont watch logs --service frontend | grep -i error

# Or use AWS CLI directly
aws logs filter-log-events --log-group-name SemiontLogGroup \
  --start-time $(date -d "1 day ago" +%s)000 \
  --filter-pattern "ERROR"

# Check overall service status
semiont check
```

## Weekly Maintenance

### Every Monday (15 minutes)

**Security Review:**

- [ ] Review WAF blocked requests and rule effectiveness
- [ ] Check CloudTrail logs for unusual API activity  
- [ ] Verify all secrets are still properly configured in Secrets Manager
- [ ] Review SNS alert history for any missed notifications
- [ ] Verify OAuth domain restrictions are working correctly
- [ ] Check for any unauthorized access attempts in application logs

**Performance Review:**

- [ ] Analyze ECS auto-scaling events for both services from past week
- [ ] Review RDS performance insights (if enabled)
- [ ] Check CloudFront cache hit ratio and optimization opportunities
- [ ] Verify EFS usage patterns and storage growth
- [ ] Monitor frontend/backend API communication performance
- [ ] Review database query performance and connection pooling

**Commands for Weekly Review:**

```bash
# Check WAF blocked requests
WEB_ACL_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`WebACLArn`].OutputValue' --output text)
aws wafv2 get-sampled-requests --web-acl-arn $WEB_ACL_ARN \
  --rule-metric-name RateLimitMetric --scope REGIONAL \
  --time-window StartTime=$(date -d "7 days ago" -u +"%Y-%m-%dT%H:%M:%SZ"),EndTime=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
  --max-items 100

# Review auto-scaling events for both services
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --resource-id service/SemiontCluster/semiont-frontend
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --resource-id service/SemiontCluster/semiont-backend

# Check EFS file system usage
EFS_ID=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`EFSFileSystemId`].OutputValue' --output text)
aws efs describe-file-systems --file-system-id $EFS_ID --query 'FileSystems[0].SizeInBytes'
```

## Monthly Maintenance

### First Monday of Every Month (30 minutes)

**Security Updates:**

- [ ] Review and update WAF managed rule sets if new versions available
- [ ] Rotate database passwords in Secrets Manager
- [ ] Review IAM permissions and remove unused policies
- [ ] Update application dependencies (npm audit and updates)
- [ ] Review and update OAuth client credentials if needed
- [ ] Update Next.js and Hono frameworks to latest stable versions

**Infrastructure Review:**

- [ ] Review cost trends and optimize resource allocation
- [ ] Check for AWS service updates or deprecation notices  
- [ ] Review backup retention and test restore procedures
- [ ] Update CDK dependencies and redeploy if needed
- [ ] Review EFS backup policies and test file restoration
- [ ] Validate two-stack deployment model is working efficiently

**Update Procedures:**

```bash
# Rotate database password
DB_SECRET_NAME=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseSecretName`].OutputValue' --output text)
aws secretsmanager rotate-secret --secret-id $DB_SECRET_NAME

# Update application dependencies
cd apps/frontend && npm update && npm audit fix
cd ../backend && npm update && npm audit fix

# Update CDK dependencies
cd ../../packages/cloud
npm update
npm audit fix

# Deploy updates (two-stack model)
npx cdk diff SemiontInfraStack
npx cdk diff SemiontAppStack
npx cdk deploy SemiontAppStack  # Deploy app stack first for most updates

# Restart services to pick up changes
semiont restart
```

## Quarterly Maintenance

### Every 3 Months (2 hours)

**Comprehensive Security Audit:**

- [ ] Full penetration testing of public endpoints (frontend and API)
- [ ] Review all security groups and NACLs
- [ ] Audit CloudTrail logs for the quarter
- [ ] Update SSL certificates if using custom domains
- [ ] Review and update backup/disaster recovery procedures
- [ ] Audit OAuth configuration and domain restrictions
- [ ] Review EFS access patterns and file permissions
- [ ] Test WAF rules against current threat landscape

**Performance Optimization:**

- [ ] Right-size ECS tasks for both services based on 3-month usage patterns
- [ ] Optimize RDS instance class based on performance metrics
- [ ] Review CloudFront distributions and caching strategies
- [ ] Analyze and optimize EFS performance mode and throughput
- [ ] Review frontend/backend service communication efficiency
- [ ] Optimize database connection pooling and query performance

**Infrastructure Updates:**

- [ ] Update to latest PostgreSQL minor version
- [ ] Update ECS platform version if available
- [ ] Review and update CDK to latest version
- [ ] Test disaster recovery procedures for both stacks
- [ ] Update Node.js runtime versions for ECS tasks
- [ ] Review and update EFS backup and restore procedures

**Cost Optimization Review:**

- [ ] Analyze 3-month cost trends
- [ ] Identify opportunities for Reserved Instance purchases
- [ ] Review S3 storage costs and lifecycle policies
- [ ] Adjust budget alerts based on actual usage patterns

## Annual Maintenance

### Once Per Year (4 hours)

**Major Version Updates:**

- [ ] Plan Next.js major version upgrade for frontend
- [ ] Plan Node.js major version upgrade for both services
- [ ] PostgreSQL major version upgrade planning
- [ ] Review architecture for new AWS service opportunities
- [ ] Complete security compliance audit
- [ ] Evaluate framework performance and compatibility

**Disaster Recovery Testing:**

- [ ] Full backup and restore testing
- [ ] Multi-region failover testing (if implemented)
- [ ] Document recovery time objectives (RTO) and recovery point objectives (RPO)

**Business Continuity:**

- [ ] Update emergency contact procedures
- [ ] Review and update incident response playbooks
- [ ] Train team on new features and procedures
- [ ] Update documentation and runbooks

## Emergency Procedures

### High Priority Alerts (Immediate Response)

**Application Down:**

```bash
# Quick status check for both services
semiont check

# Check ECS service status for both services
aws ecs describe-services --cluster SemiontCluster \
  --services semiont-frontend semiont-backend

# Check ALB target health for both target groups
FRONTEND_TG_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`FrontendTargetGroupArn`].OutputValue' --output text)
BACKEND_TG_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`BackendTargetGroupArn`].OutputValue' --output text)
aws elbv2 describe-target-health --target-group-arn $FRONTEND_TG_ARN
aws elbv2 describe-target-health --target-group-arn $BACKEND_TG_ARN

# Restart services if needed
semiont restart
# Or restart individual services
semiont restart --service frontend
semiont restart --service backend
```

**Database Connection Issues:**

```bash
# Check database connectivity from backend service
semiont exec --service backend 'pg_isready -h $DB_HOST -p $DB_PORT'

# Check RDS instance status
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)
aws rds describe-db-instances --db-instance-identifier $DB_IDENTIFIER

# Check database connections
aws cloudwatch get-metric-statistics --namespace AWS/RDS \
  --metric-name DatabaseConnections --dimensions Name=DBInstanceIdentifier,Value=$DB_IDENTIFIER \
  --start-time $(date -d "1 hour ago" -u +"%Y-%m-%dT%H:%M:%SZ") \
  --end-time $(date -u +"%Y-%m-%dT%H:%M:%SZ") --period 300 --statistics Average
```

**High Cost Alert:**

```bash
# Check current month costs
aws ce get-cost-and-usage --time-period Start=$(date -d "$(date +%Y-%m-01)" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY --metrics BlendedCost

# Identify high-cost services
aws ce get-cost-and-usage --time-period Start=$(date -d "7 days ago" +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY --metrics BlendedCost --group-by Type=DIMENSION,Key=SERVICE

# Check for unexpected ECS scaling
semiont check

# Review service scaling history
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --resource-id service/SemiontCluster/semiont-frontend
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --resource-id service/SemiontCluster/semiont-backend
```

## Maintenance Windows

### Preferred Maintenance Times

- **Daily automated tasks:** 02:00-04:00 UTC (low traffic period)
- **Weekly manual tasks:** Monday 09:00-10:00 UTC  
- **Monthly updates:** First Monday 09:00-11:00 UTC
- **Emergency maintenance:** Any time with 15-minute notification

### Maintenance Notifications

```bash
# Send maintenance notification via SNS
SNS_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`SNSTopicArn`].OutputValue' --output text)
aws sns publish --topic-arn $SNS_TOPIC_ARN \
  --message "Scheduled maintenance starting at $(date)" \
  --subject "Semiont Platform Maintenance Notification"
```

## Monitoring Maintenance Tasks

### CloudWatch Alarms Review

- [ ] Verify all alarms are properly configured and responding for both services
- [ ] Test alarm notifications end-to-end
- [ ] Review alarm thresholds based on historical data
- [ ] Clean up obsolete or redundant alarms
- [ ] Ensure frontend and backend services have separate monitoring
- [ ] Verify database connection and performance alarms

### Log Management

```bash
# Check log group retention settings
aws logs describe-log-groups --log-group-name-prefix Semiont

# Archive old logs if needed
LOG_GROUP_NAME=$(aws cloudformation describe-stacks --stack-name SemiontAppStack --query 'Stacks[0].Outputs[?OutputKey==`LogGroupName`].OutputValue' --output text)
aws logs create-export-task --log-group-name $LOG_GROUP_NAME \
  --from-time $(date -d "30 days ago" +%s)000 --to-time $(date -d "7 days ago" +%s)000 \
  --destination semiont-log-archive-bucket

# Clean up old log streams
# Note: This would be a manual AWS CLI operation
aws logs delete-log-stream --log-group-name $LOG_GROUP_NAME --log-stream-name <stream-name>
```

## Compliance and Auditing

### Security Compliance

- [ ] Review access patterns and user permissions quarterly
- [ ] Maintain audit trail of all administrative changes
- [ ] Document all maintenance activities with timestamps
- [ ] Regular review of AWS Config compliance rules

### Change Management

- [ ] All infrastructure changes via CDK version control (two-stack model)
- [ ] Pre-production testing for all changes
- [ ] Rollback procedures documented and tested for both stacks
- [ ] Approval process for production changes
- [ ] Separate deployment procedures for infrastructure vs application changes
- [ ] Database migration testing and rollback procedures

## Automation Opportunities

Consider implementing these automations to reduce manual maintenance:

1. **Automated Security Updates:** Lambda function to check for and apply npm security updates
2. **Cost Optimization:** Automated right-sizing based on CloudWatch metrics for both services
3. **Health Check Automation:** Self-healing infrastructure with auto-restart capabilities
4. **Backup Verification:** Automated EFS backup testing and validation
5. **OAuth Token Refresh:** Automated OAuth credential rotation and validation
6. **Database Migration Testing:** Automated Prisma schema validation and testing

## Documentation Updates

This maintenance guide should be reviewed and updated:

- [ ] After any significant infrastructure changes
- [ ] Following incident response activities
- [ ] When new AWS services are adopted
- [ ] At minimum annually during the annual maintenance cycle

## Contact Information

**Primary:** Platform team - <platform@company.com>  
**Secondary:** On-call engineer - <oncall@company.com>
**Emergency:** 24/7 support line - +1-555-SUPPORT
**OAuth Issues:** <authentication@company.com>
**Database Issues:** <dba@company.com>
