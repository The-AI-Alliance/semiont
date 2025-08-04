# Semiont Security Guide

This document outlines the comprehensive security architecture, measures, and best practices implemented in the Semiont semantic knowledge platform.

## Security Architecture Overview

Semiont implements a defense-in-depth security model with multiple layers of protection across all components of the infrastructure and application stack.

### Core Security Principles

- **Zero Trust Architecture**: No implicit trust, verify every request
- **Least Privilege Access**: Minimal necessary permissions by default
- **Defense in Depth**: Multiple security layers with redundant controls
- **Data Encryption**: Encryption at rest and in transit for all sensitive data
- **Continuous Monitoring**: Real-time security monitoring and alerting
- **Compliance Ready**: Built to meet enterprise compliance requirements

## Infrastructure Security

### Network Security

#### VPC Architecture
- **Private Subnets**: Database and application servers in private subnets with no direct internet access
- **Public Subnets**: Only load balancers and NAT gateways in public subnets
- **Network Segmentation**: Separate subnets for different tiers (web, app, database)
- **Availability Zones**: Multi-AZ deployment for redundancy and fault tolerance

#### Security Groups
```bash
# Database Security Group (restrictive)
- Inbound: Port 5432 from ECS Security Group only
- Outbound: None (default deny)

# ECS Security Group (application tier)
- Inbound: Port 3000/8000 from ALB Security Group only
- Outbound: HTTPS (443) to internet, PostgreSQL (5432) to database

# ALB Security Group (public-facing)
- Inbound: HTTP (80), HTTPS (443) from 0.0.0.0/0
- Outbound: Port 3000/8000 to ECS Security Group
```

#### Network Access Control
- **NACLs**: Additional subnet-level filtering as backup to security groups
- **NAT Gateways**: Controlled outbound internet access for private resources
- **VPC Flow Logs**: Network traffic monitoring and analysis
- **DNS Security**: Route 53 Resolver DNS Firewall for malicious domain blocking

### Compute Security

#### ECS Fargate Security
- **Container Isolation**: Each task runs in isolated execution environment
- **Read-Only Root Filesystem**: Containers run with read-only root filesystem where possible
- **Non-Root User**: Application processes run as non-privileged users
- **Resource Limits**: CPU and memory limits to prevent resource exhaustion
- **Image Scanning**: Automated vulnerability scanning of container images
- **Secrets Management**: No secrets in container images or environment variables

#### Container Security Best Practices
```dockerfile
# Example security-hardened Dockerfile patterns
FROM node:18-alpine AS base
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Security updates
RUN apk update && apk upgrade && apk add --no-cache dumb-init

# Switch to non-root user
USER nextjs
WORKDIR /app

# Read-only filesystem where possible
VOLUME ["/tmp"]
```

### Data Security

#### Database Security (RDS PostgreSQL)
- **Encryption at Rest**: AES-256 encryption using AWS KMS
- **Encryption in Transit**: TLS 1.2+ for all database connections
- **Private Subnets**: Database not accessible from internet
- **Automated Backups**: Encrypted backups with point-in-time recovery
- **Parameter Groups**: Hardened PostgreSQL configuration
- **Connection Pooling**: Prisma connection pooling to prevent connection exhaustion

#### File Storage Security (EFS)
- **Encryption at Rest**: AES-256 encryption using AWS KMS
- **Encryption in Transit**: TLS encryption for NFS traffic
- **Access Points**: Controlled access with POSIX permissions
- **Backup Enabled**: Automated daily backups with 30-day retention
- **Mount Targets**: Private subnet mounting only

#### Secrets Management
```typescript
// All sensitive configuration stored in AWS Secrets Manager
interface SecretConfiguration {
  database: {
    host: string;
    username: string;
    password: string; // Stored in Secrets Manager
  };
  oauth: {
    google_client_id: string;
    google_client_secret: string; // Stored in Secrets Manager
  };
  application: {
    nextauth_secret: string; // Stored in Secrets Manager
    jwt_secret: string; // Stored in Secrets Manager
  };
}
```

## Application Security

### Authentication & Authorization

#### OAuth 2.0 / OpenID Connect
- **Google OAuth Integration**: Secure authentication via Google Identity Platform
- **Domain Restrictions**: Configurable allowed domains for user registration
- **Session Management**: Secure session handling with NextAuth.js
- **Token Security**: JWT tokens with short expiration and refresh capabilities
- **JWT Payload Validation**: Runtime validation of JWT payload structure and content
- **Multi-Factor Authentication**: Support for MFA through OAuth provider

#### Role-Based Access Control (RBAC)
- **Granular Permissions**: Individual asset-level access control
- **Role Hierarchy**: Structured role inheritance system
- **Dynamic Rules**: Context-aware permission evaluation
- **Audit Trail**: Complete logging of all permission changes
- **Delegation**: Temporary permission delegation capabilities

See [RBAC.md](RBAC.md) for detailed RBAC architecture and implementation.

#### Session Security
```typescript
// NextAuth.js security configuration
export const authOptions: NextAuthOptions = {
  providers: [GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  })],
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60, // 8 hours
  },
  jwt: {
    maxAge: 8 * 60 * 60, // 8 hours
  },
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
}
```

### API Security

#### Input Validation & Sanitization
- **Schema Validation**: Zod-based request/response validation
- **SQL Injection Prevention**: Prisma ORM with parameterized queries
- **XSS Prevention**: Input sanitization and output encoding
- **CSRF Protection**: Built-in CSRF token validation
- **Request Size Limits**: Protection against oversized payloads

#### Rate Limiting
```typescript
// API rate limiting configuration
const rateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP",
  standardHeaders: true,
  legacyHeaders: false,
};

// Different limits for different endpoints
const strictRateLimit = rateLimit({
  ...rateLimitConfig,
  max: 10, // Stricter limit for sensitive endpoints
});
```

#### API Authentication
- **Bearer Token Authentication**: JWT tokens for API access with runtime payload validation
- **JWT Payload Validation**: Zod-based validation of token structure and content (see `src/validation/schemas.ts`)
- **API Key Management**: Secure API key generation and rotation
- **Request Signing**: HMAC-based request authentication for sensitive operations
- **Scope-Based Access**: Fine-grained API permission scopes

### Frontend Security

#### Content Security Policy (CSP)
```typescript
// Next.js security headers
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' https://accounts.google.com",
      "frame-src 'self' https://accounts.google.com",
    ].join('; '),
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
];
```

#### Secure Client-Side Practices
- **Environment Variable Security**: No sensitive data in client-side environment variables
- **Dependency Security**: Regular npm audit and dependency updates
- **Bundle Analysis**: Monitoring for suspicious packages and vulnerabilities
- **Source Map Protection**: Source maps not exposed in production

## Web Application Firewall (WAF)

### AWS WAF Configuration

#### Managed Rule Sets
- **AWS Core Rule Set**: Protection against OWASP Top 10 vulnerabilities
- **AWS Known Bad Inputs**: Protection against malicious request patterns
- **AWS IP Reputation**: Blocking requests from known malicious IP addresses
- **AWS Anonymous IP List**: Blocking requests from anonymizing services

#### Custom Rules
```typescript
// Rate limiting rule
{
  name: "RateLimitRule",
  priority: 100,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit: 2000, // requests per 5-minute window
      aggregateKeyType: "IP",
    },
  },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "RateLimitRule",
  },
}

// Geographic blocking (if required)
{
  name: "GeoBlockRule",
  priority: 200,
  action: { block: {} },
  statement: {
    geoMatchStatement: {
      countryCodes: ["CN", "RU"], // Block specific countries if needed
    },
  },
}
```

#### WAF Monitoring
- **Real-time Metrics**: CloudWatch metrics for blocked/allowed requests
- **Sampled Requests**: Detailed analysis of blocked requests
- **Custom Dashboards**: WAF-specific monitoring dashboards
- **Alerting**: Automated alerts for unusual traffic patterns

## CloudFront Security

### Distribution Security
- **HTTPS Enforcement**: Redirect HTTP to HTTPS
- **TLS Configuration**: TLS 1.2 minimum, prefer TLS 1.3
- **HSTS Headers**: HTTP Strict Transport Security headers
- **Origin Access Control (OAC)**: Secure communication with ALB origin
- **Geographic Restrictions**: Country-level blocking if required

### Caching Security
```typescript
// Secure caching configuration
const cloudFrontBehaviors = [
  {
    pathPattern: "/api/*",
    cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", // CachingDisabled
    originRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf", // CORS-S3Origin
    responseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03", // SecurityHeadersPolicy
  },
  {
    pathPattern: "/*",
    cachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // CachingOptimized
    compress: true,
  },
];
```

## Monitoring & Logging

### Security Monitoring

#### CloudWatch Integration
- **Security Metrics**: Failed authentication attempts, suspicious API calls
- **Custom Dashboards**: Real-time security posture monitoring
- **Automated Alerting**: SNS notifications for security events
- **Log Analysis**: CloudWatch Insights for security log analysis

#### CloudTrail Auditing
```bash
# CloudTrail configuration for comprehensive auditing
aws cloudtrail create-trail \
  --name SemiontSecurityAudit \
  --s3-bucket-name semiont-security-logs \
  --include-global-service-events \
  --is-multi-region-trail \
  --enable-log-file-validation
```

#### Application Logging
```typescript
// Security-focused logging
const securityLogger = {
  logFailedAuth: (userId: string, reason: string, ip: string) => {
    logger.warn('Authentication failed', {
      userId,
      reason,
      ip,
      timestamp: new Date().toISOString(),
      event: 'auth_failure',
    });
  },
  
  logPermissionDenied: (userId: string, resource: string, action: string) => {
    logger.warn('Permission denied', {
      userId,
      resource,
      action,
      timestamp: new Date().toISOString(),
      event: 'permission_denied',
    });
  },
  
  logSensitiveOperation: (userId: string, operation: string, resourceId: string) => {
    logger.info('Sensitive operation performed', {
      userId,
      operation,
      resourceId,
      timestamp: new Date().toISOString(),
      event: 'sensitive_operation',
    });
  },
};
```

### Incident Response

#### Automated Response
- **Lambda Functions**: Automated response to security events
- **SNS Integration**: Real-time notification to security team
- **Auto-scaling**: Automatic scaling response to DDoS attacks
- **IP Blocking**: Dynamic IP blocking based on threat intelligence

#### Manual Response Procedures
```bash
# Emergency procedures for security incidents

# 1. Isolate affected resources
aws ecs update-service --cluster SemiontCluster \
  --service semiont-frontend --desired-count 0
aws ecs update-service --cluster SemiontCluster \
  --service semiont-backend --desired-count 0

# 2. Enable enhanced logging
aws logs put-retention-policy --log-group-name SemiontLogGroup --retention-in-days 90
aws wafv2 put-logging-configuration --resource-arn $WEB_ACL_ARN \
  --log-destination-configs $CLOUDWATCH_LOG_GROUP

# 3. Create security snapshot
DB_IDENTIFIER=$(aws cloudformation describe-stacks --stack-name SemiontInfraStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DatabaseIdentifier`].OutputValue' --output text)
aws rds create-db-snapshot --db-instance-identifier $DB_IDENTIFIER \
  --db-snapshot-identifier security-incident-$(date +%Y%m%d%H%M%S)

# 4. Review and analyze logs
aws logs filter-log-events --log-group-name SemiontLogGroup \
  --start-time $(date -d "1 hour ago" +%s)000 \
  --filter-pattern "[timestamp, request_id, level=ERROR || level=WARN]"
```

## Compliance & Governance

### Regulatory Compliance

#### SOC 2 Type II
- **Security Controls**: Access controls, logical security, system operations
- **Availability Controls**: System availability and processing integrity
- **Confidentiality Controls**: Data classification and handling procedures
- **Privacy Controls**: Personal data protection and processing controls

#### GDPR Compliance
- **Data Minimization**: Collect only necessary personal data
- **Consent Management**: Clear consent mechanisms for data processing
- **Right to Access**: Users can access their personal data
- **Right to Erasure**: Users can request deletion of their data
- **Data Portability**: Export user data in machine-readable format
- **Privacy by Design**: Built-in privacy controls and data protection

#### Additional Frameworks
- **ISO 27001**: Information security management system
- **NIST Cybersecurity Framework**: Comprehensive security controls
- **HIPAA**: Healthcare data protection (if applicable)
- **PCI DSS**: Payment card data security (if applicable)

### Data Governance

#### Data Classification
```typescript
// Data classification schema
enum DataClassification {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted',
}

interface DataAsset {
  id: string;
  classification: DataClassification;
  owner: string;
  retention_period: number; // days
  encryption_required: boolean;
  access_controls: AccessControl[];
}
```

#### Data Retention
- **Automated Cleanup**: Scheduled deletion of expired data
- **Backup Retention**: 30-day backup retention with encrypted storage
- **Log Retention**: Security logs retained for 1 year minimum
- **Audit Trail Retention**: Compliance-driven retention periods

## Vulnerability Management

### Security Scanning

#### Infrastructure Scanning
```bash
# Regular security scans using AWS services
# Config Rules for compliance monitoring
aws configservice put-config-rule --config-rule '{
  "ConfigRuleName": "rds-encryption-enabled",
  "Source": {
    "Owner": "AWS",
    "SourceIdentifier": "RDS_STORAGE_ENCRYPTED"
  }
}'

# Inspector for EC2/container vulnerability assessment
aws inspector2 enable --resource-types ECR,ECS
```

#### Application Scanning
- **Static Code Analysis**: SonarQube integration in CI/CD pipeline
- **Dependency Scanning**: npm audit and Snyk for dependency vulnerabilities
- **Container Scanning**: AWS ECR vulnerability scanning
- **Dynamic Application Security Testing (DAST)**: OWASP ZAP integration

#### Penetration Testing
- **Regular Testing Schedule**: Quarterly penetration testing
- **Scope Definition**: Clear scope including infrastructure and applications
- **Remediation Tracking**: Systematic tracking and fixing of identified vulnerabilities
- **Re-testing**: Verification testing after vulnerability fixes

### Patch Management

#### Infrastructure Patching
- **Automated Updates**: AWS-managed services automatically updated
- **ECS Platform Updates**: Fargate platform version management
- **Database Patching**: RDS automatic minor version updates
- **OS Updates**: Container base image updates in CI/CD pipeline

#### Application Updates
```bash
# Automated security updates in CI/CD
npm audit --audit-level moderate
npm audit fix --force

# Container image scanning before deployment
docker scout cves local://semiont-frontend:latest
docker scout cves local://semiont-backend:latest
```

## Disaster Recovery & Business Continuity

### Backup Strategy

#### Database Backups
- **Automated Backups**: Daily automated RDS backups with 7-day retention
- **Point-in-Time Recovery**: Continuous backup with 5-minute recovery granularity
- **Cross-Region Replication**: Backup replication to disaster recovery region
- **Backup Testing**: Monthly backup restoration testing

#### Application Data Backups
- **EFS Backups**: Daily automated EFS backups with AWS Backup
- **Configuration Backups**: Infrastructure as Code in version control
- **Secrets Backup**: Secrets Manager automatic replication across regions

### Disaster Recovery Plan

#### Recovery Time Objectives (RTO)
- **Critical Systems**: 4 hours maximum downtime
- **Non-Critical Systems**: 24 hours maximum downtime
- **Data Recovery**: 1 hour maximum data loss (RPO)

#### Recovery Procedures
```bash
# Disaster recovery stack deployment
npx cdk deploy SemiontInfraStack --region us-west-2
npx cdk deploy SemiontAppStack --region us-west-2

# Database restore from backup
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier semiont-db-dr \
  --db-snapshot-identifier semiont-db-snapshot-latest \
  --region us-west-2
```

## Security Testing

### Automated Security Testing

#### CI/CD Security Pipeline
```yaml
# GitHub Actions security workflow
name: Security Scan
on: [push, pull_request]

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Run SAST scan
        uses: github/super-linter@v4
        env:
          DEFAULT_BRANCH: main
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          
      - name: Run dependency scan
        run: |
          npm audit --audit-level moderate
          npx snyk test --severity-threshold=medium
          
      - name: Run container scan
        run: |
          docker build -t semiont-test .
          docker scout cves semiont-test
```

#### Security Test Suite
- **Unit Tests**: Security-focused unit tests for authentication and authorization
- **Integration Tests**: End-to-end security testing of API endpoints
- **Load Testing**: Security under load with rate limiting validation
- **Chaos Engineering**: Security resilience testing under failure conditions

### Manual Security Testing

#### Security Review Checklist
- [ ] Authentication mechanisms tested and verified
- [ ] Authorization controls properly implemented
- [ ] Input validation comprehensive and effective
- [ ] Error handling doesn't leak sensitive information
- [ ] Logging captures security events appropriately
- [ ] Encryption properly implemented for data at rest and in transit
- [ ] Session management secure and appropriate
- [ ] API security controls effective
- [ ] Infrastructure security controls properly configured
- [ ] Monitoring and alerting functional and comprehensive

## Security Training & Awareness

### Development Team Security Training
- **Secure Coding Practices**: OWASP guidelines and secure development lifecycle
- **Threat Modeling**: Regular threat modeling sessions for new features
- **Security Code Review**: Peer review process with security focus
- **Incident Response**: Regular drills and tabletop exercises

### Security Champions Program
- **Security Advocates**: Designated security champions in each team
- **Knowledge Sharing**: Regular security knowledge sharing sessions
- **Security Updates**: Communication of new threats and vulnerabilities
- **Best Practices**: Documentation and enforcement of security best practices

## Contact Information

### Security Team Contacts
- **Security Officer**: <security@company.com>
- **Incident Response**: <security-incident@company.com> (24/7)
- **Compliance Team**: <compliance@company.com>
- **Emergency Hotline**: +1-555-SECURITY

### External Security Resources
- **AWS Security**: AWS Security Hub and AWS Support
- **Vulnerability Disclosure**: <security-disclosure@company.com>
- **Bug Bounty Program**: [Company Bug Bounty Portal]
- **Security Advisories**: Subscribe to security mailing list

---

This security guide should be reviewed and updated quarterly or after any significant changes to the infrastructure or application architecture. All security measures should be tested regularly and updated based on emerging threats and best practices.