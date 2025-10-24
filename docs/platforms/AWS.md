# AWS Deployment Architecture

This document describes the AWS-specific deployment architecture for Semiont, including infrastructure components, networking, security, and operational procedures.

For the platform-agnostic application architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Overview

Semiont's AWS deployment uses Infrastructure as Code (CDK) with a two-stack model that separates long-lived data infrastructure from frequently updated application code.

**Key AWS Services:**
- **Compute**: ECS Fargate (serverless containers)
- **Networking**: VPC, ALB, CloudFront, Route 53
- **Data**: RDS PostgreSQL, EFS
- **Security**: WAF, Secrets Manager, IAM
- **Monitoring**: CloudWatch, SNS

## AWS Infrastructure Diagram

```mermaid
graph TB
    subgraph "Internet"
        Users[Users/Browsers]
    end

    subgraph "AWS Edge"
        CF[CloudFront CDN]
        WAF[AWS WAF]
    end

    subgraph "Public Subnet"
        ALB[Application Load Balancer]
    end

    subgraph "Private Subnet"
        subgraph "ECS Fargate Cluster"
            Frontend[Frontend Service<br/>Next.js 14]
            Backend[Backend Service<br/>Hono API]
        end
    end

    subgraph "Database Subnet"
        RDS[(PostgreSQL RDS)]
        EFS[EFS Storage]
    end

    subgraph "AWS Services"
        SM[Secrets Manager]
        CW[CloudWatch]
        SNS[SNS Alerts]
    end

    Users --> CF
    CF --> WAF
    WAF --> ALB
    ALB -->|/auth/*| Frontend
    ALB -->|/api/*| Backend
    ALB -->|/*| Frontend
    Backend --> RDS
    Backend --> EFS
    Backend --> SM
    Frontend --> SM
    Backend --> CW
    Frontend --> CW
    CW --> SNS
```

## Two-Stack Architecture

The deployment uses a **two-stack model** that separates infrastructure lifecycle:

```mermaid
graph LR
    subgraph "Data Stack"
        VPC[VPC & Networking]
        RDS2[(RDS Database)]
        EFS2[EFS Storage]
        SEC[Security Groups]
        IAM[IAM Roles]
        SM2[Secrets Manager]
    end

    subgraph "Application Stack"
        ECS[ECS Cluster]
        SVCS[ECS Services]
        ALB2[Load Balancer]
        WAF2[WAF Rules]
        CF2[CloudFront]
        R53[Route 53]
        CW2[CloudWatch]
    end

    VPC --> ECS
    RDS2 --> SVCS
    EFS2 --> SVCS
    SEC --> SVCS
    IAM --> SVCS
    SM2 --> SVCS
```

### Data Stack (`SemiontDataStack`)

**Purpose**: Provisions foundational AWS data resources that rarely change

**Components**:
- **VPC with 3-tier networking**:
  - Public subnets (ALB, NAT gateways)
  - Private subnets (ECS tasks)
  - Database subnets (RDS, isolated)
- **PostgreSQL RDS Database**:
  - PostgreSQL 15 on t3.micro instance
  - Encrypted storage with 7-day backup retention
  - Multi-AZ disabled for cost optimization
  - Isolated in database subnets
- **EFS File System**: Encrypted persistent storage for uploads
- **AWS Secrets Manager**: All credentials and secrets
- **Security Groups**: Network access control
- **IAM Roles**: Service permissions

**CDK Code Location**: `infrastructure/lib/data-stack.ts`

### Application Stack (`SemiontAppStack`)

**Purpose**: Deploys containerized applications and associated resources

**Components**:
- **ECS Fargate Cluster**: Container orchestration
- **Dual ECS Services**: Frontend and backend containers
- **Application Load Balancer**: Traffic routing and SSL termination
- **WAF**: Web application firewall with rate limiting
- **CloudFront**: CDN for static assets
- **Route 53**: DNS management
- **CloudWatch**: Logging and monitoring
- **SNS/Budgets**: Alerting and cost management

**CDK Code Location**: `infrastructure/lib/app-stack.ts`

### Benefits of Two-Stack Model

1. **Faster Deployments**: App stack deploys in ~5 minutes vs full data infrastructure
2. **Lower Risk**: Database and core data infrastructure remain stable
3. **Cost Control**: Avoid accidental deletion of expensive resources
4. **Easier Rollbacks**: Application rollbacks don't affect data infrastructure
5. **Environment Isolation**: Different app stacks can share data infrastructure

## AWS Services Used

### Compute & Containers

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **ECS Fargate** | Serverless container platform | 256 CPU / 512MB RAM per task |
| **ECR** | Container image registry | Automatic via CDK |
| **ECS Exec** | Container debugging | Enabled for both services |

### Networking

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **VPC** | Virtual private cloud | Multi-AZ with 3-tier subnet design |
| **ALB** | Application Load Balancer | SSL termination, path-based routing |
| **Route 53** | DNS management | Hosted zone with A records |
| **CloudFront** | CDN | Global edge caching for static assets |
| **Certificate Manager** | SSL/TLS certificates | Auto-renewal |

### Data & Storage

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **RDS PostgreSQL** | Relational database | t3.micro, single-AZ |
| **EFS** | File system | Encrypted, lifecycle policies |
| **Secrets Manager** | Credential storage | Automatic rotation supported |

### Security

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **WAF** | Web Application Firewall | Rate limiting, geo-blocking |
| **Security Groups** | Network firewall | Principle of least privilege |
| **IAM** | Access management | Task execution roles |
| **VPC Flow Logs** | Network monitoring | Optional (not enabled by default) |

### Monitoring & Management

| Service | Purpose | Configuration |
|---------|---------|---------------|
| **CloudWatch** | Logging and metrics | 1-month retention |
| **CloudWatch Alarms** | Automated alerting | CPU, memory, error thresholds |
| **SNS** | Notification service | Email/SMS alerts |
| **AWS Budgets** | Cost monitoring | Monthly budget alerts |

## ALB Routing Configuration

We use a clean 3-rule routing pattern:

```typescript
// Priority 10: OAuth flows handled by frontend
ListenerCondition.pathPatterns(['/auth/*'])

// Priority 20: All API calls go to backend
ListenerCondition.pathPatterns(['/api', '/api/*'])

// Default: Everything else to frontend
```

**Benefits**:
- **No path conflicts**: NextAuth at `/auth/*` doesn't intercept backend `/api/auth/*` routes
- **Clear separation**: Frontend handles OAuth, backend handles all API logic
- **Simple mental model**: Easy to understand routing rules
- **Independent scaling**: Frontend and backend scale separately

## Security Architecture

### Network Security

- **3-Tier VPC**: Public, private, and database subnets
- **Security Groups**: Principle of least privilege
- **Private Database**: No internet access, ECS-only connections
- **NAT Gateways**: Outbound internet for private subnets

### WAF Protection

Web Application Firewall with multiple security rules:
- AWS Managed Core Rule Set (common vulnerabilities)
- AWS Managed Known Bad Inputs protection
- Rate limiting (100 requests per 5-minute window per IP)
- Geo-blocking for high-risk countries
- IP reputation filtering
- Enhanced exclusions for file uploads to prevent false positives

### Application Security

- **HTTPS Everywhere**: SSL termination at ALB
- **Secret Management**: All credentials in AWS Secrets Manager
- **IAM Roles**: Task-level permissions, no hardcoded credentials
- **VPC Isolation**: Backend and database in private subnets

### Data Security

- **Encryption at Rest**: RDS and EFS encrypted with AWS KMS
- **Encryption in Transit**: HTTPS/TLS for all connections
- **Database Isolation**: Private subnets with no internet access
- **Backup Encryption**: Automated encrypted backups

## Scalability Design

```mermaid
graph TB
    subgraph "Auto Scaling"
        ASG[Auto Scaling Group]
        CPU[CPU Metric > 70%]
        MEM[Memory Metric > 80%]
    end

    subgraph "ECS Services"
        F1[Frontend Task 1]
        F2[Frontend Task 2]
        F3[Frontend Task N]
        B1[Backend Task 1]
        B2[Backend Task 2]
        B3[Backend Task N]
    end

    subgraph "Load Distribution"
        ALB3[Application Load Balancer]
        TG_F[Frontend Target Group]
        TG_B[Backend Target Group]
    end

    CPU --> ASG
    MEM --> ASG
    ASG --> F1
    ASG --> F2
    ASG --> F3
    ASG --> B1
    ASG --> B2
    ASG --> B3

    ALB3 --> TG_F
    ALB3 --> TG_B
    TG_F --> F1
    TG_F --> F2
    TG_F --> F3
    TG_B --> B1
    TG_B --> B2
    TG_B --> B3
```

### Horizontal Scaling

- **ECS Auto Scaling**: CPU/memory-based task scaling
  - Backend: 1-10 tasks, scales at 70% CPU or 80% memory
  - Frontend: 1-10 tasks, scales at 70% CPU or 80% memory
- **ALB Distribution**: Traffic spread across healthy instances
- **Multi-AZ Database**: High availability (optional, disabled for cost)
- **CloudFront Caching**: Reduced origin load

### Deployment Resilience

- **Circuit Breaker**: Both services configured with automatic rollback on failed deployments
- **Rolling Deployments**: 100% minimum healthy, 200% maximum during deployments
- **Health Check Grace Period**: 2-minute grace period for service startup
- **ECS Exec**: Enabled for debugging and maintenance access

### Vertical Scaling

- **Fargate**: Easy CPU/memory adjustments without downtime
- **RDS Instance Types**: Seamless database instance upgrades
- **EFS Performance**: Automatic throughput scaling

## Monitoring & Observability

### CloudWatch Logging

- **Log Group**: Single log group (`SemiontLogGroup`) with 1-month retention
- **Service-Specific Streams**:
  - Frontend: `semiont-frontend` prefix
  - Backend: `semiont-backend` prefix
- **Log Drivers**: AWS Logs driver for automatic CloudWatch integration
- **Structured Logging**: JSON-formatted log entries with service-specific prefixes

### Metrics & Dashboards

- **ECS Service Metrics**: CPU, memory, task count
- **ALB Metrics**: Request count, latency, error rates
- **RDS Metrics**: Database performance and connections
- **WAF Metrics**: Request filtering and security events
- **Custom Dashboards**: Operational visibility

### Alerting

- **CloudWatch Alarms**: Automated threshold monitoring
- **SNS Notifications**: Email/SMS alerts
- **Cost Budgets**: Spending limit notifications
- **Health Check Failures**: Service availability alerts

## Deployment Pipeline

### Infrastructure as Code (CDK)

All infrastructure defined in TypeScript using AWS CDK:

**Advantages**:
- **Type Safety**: Compile-time validation
- **Reusability**: Shared constructs and patterns
- **Version Control**: All changes tracked in Git
- **Automated Rollbacks**: CloudFormation change sets

**CDK Structure**:
```
infrastructure/
├── lib/
│   ├── data-stack.ts       # Data Stack (VPC, RDS, EFS)
│   ├── app-stack.ts        # Application Stack (ECS, ALB, CloudFront)
│   └── constructs/         # Reusable CDK constructs
├── bin/
│   └── infrastructure.ts   # CDK app entry point
└── cdk.json                # CDK configuration
```

### Deployment Commands

For complete deployment procedures, see [DEPLOYMENT.md](../DEPLOYMENT.md).

```bash
# Set default environment
export SEMIONT_ENV=production

# Deploy infrastructure (rare)
semiont provision

# Deploy application (frequent)
semiont publish

# Service management
semiont restart  # All services
semiont restart --service frontend  # Specific service
semiont watch logs  # Monitor logs
```

### Management Scripts

TypeScript-based management scripts provide:
- **Dynamic Resource Discovery**: No hardcoded ARNs
- **Service-Specific Operations**: Frontend/backend command targeting
- **OAuth Management**: Interactive credential setup
- **Database Operations**: Backup and maintenance utilities

**Script Location**: `scripts/aws/`

## Cost Optimization

### Resource Sizing

- **t3.micro RDS**: Minimal database instance for development ($15/month)
- **256 CPU / 512MB ECS**: Right-sized containers ($0.01/hour per task)
- **Single AZ**: Reduced NAT gateway and data transfer costs
- **EFS Lifecycle**: Automatic transition to cheaper storage tiers

### Operational Efficiency

- **Fargate Spot**: Cost savings for non-critical workloads (future)
- **CloudFront Caching**: Reduced ALB/ECS load
- **Reserved Capacity**: Long-term cost reduction (future)
- **Budget Alerts**: Proactive cost monitoring

### Cost Breakdown (Estimated Monthly)

| Service | Configuration | Est. Cost |
|---------|---------------|-----------|
| RDS (t3.micro) | Single-AZ, 20GB storage | $15 |
| ECS Fargate | 2 tasks, 24/7 | $15 |
| ALB | Standard load balancer | $20 |
| NAT Gateway | Single-AZ | $35 |
| EFS | 10GB standard | $3 |
| CloudFront | Low traffic | $1 |
| Route 53 | 1 hosted zone | $0.50 |
| **Total** | | **~$90/month** |

*Costs may vary based on actual usage and region*

## Environment Configuration

### Secrets Management

All secrets stored in AWS Secrets Manager:

- `semiont/${env}/database` - PostgreSQL credentials
- `semiont/${env}/jwt-secret` - JWT signing key
- `semiont/${env}/oauth` - OAuth client credentials

**Access Pattern**:
```typescript
// Backend service retrieves secrets on startup
const secrets = await secretsManager.getSecretValue({
  SecretId: `semiont/${process.env.NODE_ENV}/database`
}).promise();
```

### Environment Variables

Set via ECS task definitions:

- `NODE_ENV` - Environment (development, staging, production)
- `DATABASE_URL` - PostgreSQL connection string (from Secrets Manager)
- `JWT_SECRET` - JWT signing key (from Secrets Manager)
- `DATA_DIR` - EFS mount point for file storage

## Health Checks

### ALB Health Checks

- **Endpoint**: `GET /api/health`
- **Interval**: 30 seconds
- **Timeout**: 5 seconds
- **Healthy threshold**: 2 consecutive successes
- **Unhealthy threshold**: 3 consecutive failures

### ECS Health Checks

- **Container health check**: Docker HEALTHCHECK instruction
- **Grace period**: 120 seconds for service startup
- **Failure action**: Automatic task replacement

## Disaster Recovery

### Backup Strategy

- **RDS Automated Backups**: Daily snapshots, 7-day retention
- **EFS**: Automatic replication within region
- **CloudFormation Stacks**: Version controlled in Git
- **Container Images**: Stored in ECR with versioning

### Recovery Procedures

1. **Database Restoration**:
   ```bash
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier semiont-restored \
     --db-snapshot-identifier semiont-snapshot-2025-10-23
   ```

2. **Infrastructure Redeployment**:
   ```bash
   cd infrastructure
   cdk deploy SemiontDataStack --profile production
   cdk deploy SemiontAppStack --profile production
   ```

3. **Application Rollback**:
   ```bash
   semiont publish --image-tag previous-version
   ```

## Future Enhancements

### Scalability

- **Multi-AZ RDS**: High availability for production
- **ElastiCache**: Redis caching layer
- **CloudFront Edge Functions**: Global compute distribution
- **S3 for static assets**: Reduce ECS/ALB load

### Security

- **AWS Config**: Compliance and configuration drift detection
- **GuardDuty**: Threat detection and monitoring
- **Secrets Rotation**: Automatic credential rotation
- **VPC Flow Logs**: Network traffic analysis

### Operational

- **CI/CD Pipeline**: GitHub Actions → ECR → ECS
- **Blue/Green Deployments**: Zero-downtime updates
- **Canary Releases**: Gradual rollout strategies
- **X-Ray**: Distributed tracing

## Troubleshooting

### Common Issues

**ECS Task Fails to Start**:
- Check CloudWatch logs: `semiont watch logs`
- Verify secrets are accessible
- Check security group rules

**ALB Health Checks Failing**:
- Verify `/api/health` endpoint responds
- Check ECS task is running
- Review security group ingress rules

**RDS Connection Timeout**:
- Verify security group allows ECS → RDS
- Check RDS is in correct subnet
- Confirm connection string is correct

**High Costs**:
- Review CloudWatch metrics for over-provisioning
- Check NAT Gateway data transfer
- Consider single-AZ for non-production

## Related Documentation

- [Architecture Overview](../ARCHITECTURE.md) - Platform-agnostic application architecture
- [Deployment Guide](../DEPLOYMENT.md) - Step-by-step deployment instructions
- [Configuration Guide](../CONFIGURATION.md) - Environment and secret management
- [Database Management](../DATABASE.md) - PostgreSQL management on RDS
- [Troubleshooting](../TROUBLESHOOTING.md) - Common issues and solutions

---

**Document Version**: 1.0
**Last Updated**: 2025-10-23
**Target Platform**: AWS (ECS Fargate, RDS, EFS)
