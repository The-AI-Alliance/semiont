# Semiont Configuration Guide

This document describes how configuration is managed in the Semiont application using the environment-based configuration system.

## Overview

Semiont uses an **environment-based configuration system** located in `/config/environments/` with **configuration-as-code** deployment through AWS CDK. Each environment is completely self-contained with all required configuration.

## Configuration Architecture

### 1. **Environment Configuration System**

All configuration is defined in environment-specific JSON files:

```
/config/
├── environments/           # Environment configurations (JSON)
│   ├── development.json    # Development environment
│   ├── production.json     # Production environment
│   ├── test.json          # Test environment base
│   ├── unit.json          # Unit test configuration
│   ├── integration.json   # Integration test configuration
│   └── local.json         # Local development
└── index.ts              # Environment exports
```

### 2. **Environment Structure**

Each environment configuration contains:

```json
{
  "_comment": "Environment description",
  "deployment": {
    "default": "aws"
  },
  "site": {
    "domain": "wiki.example.com",
    "adminEmail": "admin@example.com",
    "oauthAllowedDomains": ["example.com"]
  },
  "app": {
    "features": {
      "enableAnalytics": true,
      "enableDebugLogging": false
    }
  },
  "services": {
    "backend": {
      "deployment": { "type": "aws" },
      "port": 3001
    }
  },
  "cloud": {
    "aws": {
      "stacks": {
        "infra": "SemiontInfraStack", 
        "app": "SemiontAppStack"
      }
    }
  },
  "aws": {
    "region": "us-east-2",
    "accountId": "123456789012",
    "certificateArn": "arn:aws:acm:...",
    "hostedZoneId": "Z1234567890ABC"
  }
}
```

### 3. **Configuration Inheritance**

Environments can extend other environments using `_extends`:

```json
{
  "_extends": "test",
  "_comment": "Integration tests extend base test config",
  "services": {
    "database": {
      "deployment": { "type": "container" },
      "name": "semiont_integration_test"
    }
  }
}
```

## Quick Start

### For Development

1. **Initialize project configuration**:
   ```bash
   semiont init --name "my-project" --environments "local,staging,production"
   ```

2. **Start local development**:
   ```bash
   export SEMIONT_ENV=local
   semiont start
   ```

### For Production

1. **Customize production.json** with your values:
   ```json
   {
     "site": {
       "domain": "your-wiki.yourdomain.com",
       "adminEmail": "admin@yourdomain.com"
     },
     "aws": {
       "region": "us-east-2",
       "accountId": "your-aws-account-id",
       "certificateArn": "your-certificate-arn"
     }
   }
   ```

2. **Deploy**:
   ```bash
   export SEMIONT_ENV=production
   semiont provision  # First time only
   semiont publish
   ```

## Environment Variables

### Setting Default Environment

Use `SEMIONT_ENV` to avoid repeating `--environment`:

```bash
export SEMIONT_ENV=production

semiont start       # Uses production.json
semiont publish      # Uses production.json
semiont test        # Uses production.json
```

### Overriding Environment

You can always override the environment:

```bash
# With SEMIONT_ENV=production set
semiont start --environment staging  # Uses staging.json
```

### Environment-Specific Properties

Each environment specifies its deployment configuration:

- **Local environments**: Use Docker containers
- **Cloud environments**: Use AWS ECS with required AWS config
- **Test environments**: Use containers or mock services

## Managing Secrets

Configuration files contain public settings. Secrets are managed separately:

```bash
# Set OAuth credentials (interactive)
semiont configure set oauth/google

# Set specific secret
semiont configure set jwt-secret "your-secret-value"

# View configuration (secrets are masked)
semiont configure show

# Validate configuration
semiont configure validate
```

## Environment Requirements

### Cloud Environments (AWS)

Must include complete AWS configuration:

```json
{
  "aws": {
    "region": "us-east-2",              // Required - no defaults
    "accountId": "123456789012",        // Required
    "certificateArn": "arn:aws:acm:...", // Required for HTTPS
    "hostedZoneId": "Z1234567890ABC",    // Required for DNS
    "rootDomain": "example.com"          // Required for SSL
  }
}
```

### Local Environments

No AWS configuration needed:

```json
{
  "site": {
    "domain": "localhost",
    "adminEmail": "admin@localhost.dev"
  },
  "services": {
    "backend": { "port": 3001 },
    "frontend": { "port": 3000 }
  }
}
```

## Creating New Environments

1. **Create JSON file**:
   ```bash
   touch config/environments/staging.json
   ```

2. **Define configuration**:
   ```json
   {
     "_extends": "production",
     "_comment": "Staging environment",
     "site": {
       "domain": "staging.example.com"
     }
   }
   ```

3. **Deploy**:
   ```bash
   semiont publish --environment staging
   ```

## Configuration Hierarchy

1. **Base configuration**: Default values
2. **Environment file**: Environment-specific overrides
3. **Secrets**: Runtime secrets from AWS Secrets Manager
4. **Environment variables**: Runtime overrides (if applicable)

## Best Practices

### 1. Use Environment Inheritance

```json
// staging.json
{
  "_extends": "production",
  "_comment": "Staging uses production config with different domain",
  "site": {
    "domain": "staging.example.com"
  }
}
```

### 2. Keep Secrets Out of Config Files

Never put secrets in JSON files. Use:
```bash
semiont configure set jwt-secret
semiont configure set oauth/google
```

## Authentication Configuration

### OAuth Setup

The application uses Google OAuth 2.0 for user authentication. Configure OAuth settings in your environment file:

```json
{
  "site": {
    "oauthAllowedDomains": ["example.com", "company.org"]
  }
}
```

### JWT Configuration

JWT tokens are used for API authentication. The JWT secret must be configured as a secure secret:

```bash
# Set JWT secret for local development
semiont configure local set jwt-secret

# For production (stored in AWS Secrets Manager)
semiont configure production set jwt-secret
```

### Authentication Requirements

1. **JWT Secret**: Minimum 32 characters, stored securely
2. **OAuth Credentials**: Google Client ID and Secret
3. **Allowed Domains**: Email domains permitted to authenticate
4. **Token Expiration**: Default 7 days (configurable)

### Security Configuration

All API routes require authentication by default. Only these endpoints are public:
- `/api/health` - Health check for load balancers
- `/api` - API documentation  
- `/api/auth/google` - OAuth login endpoint

### 3. Validate Before Deployment

```bash
semiont configure validate
semiont publish --dry-run
```

### 4. Use Consistent Naming

- Environment names: `local`, `development`, `staging`, `production`
- Service names: `frontend`, `backend`, `database`
- Stack names: Follow AWS CDK conventions

## Troubleshooting

### Configuration Not Loading

```bash
# Check current environment
echo $SEMIONT_ENV

# Validate configuration file
semiont configure validate

# Check file exists
ls -la config/environments/
```

### Secrets Not Available

```bash
# Check secrets are set
semiont configure show

# Re-set secrets if needed
semiont configure set oauth/google
```

### Wrong Environment Used

```bash
# Explicitly specify environment
semiont publish --environment production

# Or set default
export SEMIONT_ENV=production
```

## Configuration Reference

### Site Configuration

| Property | Description | Required | Example |
|----------|-------------|----------|---------|
| `domain` | Primary domain | Yes | `wiki.example.com` |
| `adminEmail` | Administrator email | Yes | `admin@example.com` |
| `supportEmail` | Support email | No | `support@example.com` |
| `oauthAllowedDomains` | OAuth domain allowed list | Yes | `["example.com"]` |

### AWS Configuration

| Property | Description | Required | Example |
|----------|-------------|----------|---------|
| `region` | AWS region | Yes | `us-east-2` |
| `accountId` | AWS account ID | Yes | `123456789012` |
| `certificateArn` | ACM certificate | For HTTPS | `arn:aws:acm:...` |
| `hostedZoneId` | Route53 zone | For DNS | `Z1234567890ABC` |

### Service Configuration

| Property | Description | Default | Example |
|----------|-------------|---------|---------|
| `deployment.type` | Deployment type | `process` | `aws`, `container`, `process` |
| `port` | Service port | Service-specific | `3001` |
| `replicas` | Instance count | `1` | `2` |
| `memory` | Memory (MB) | `512` | `1024` |
| `cpu` | CPU units | `256` | `512` |

## Related Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment procedures
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [SECURITY.md](SECURITY.md) - Security configuration
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues