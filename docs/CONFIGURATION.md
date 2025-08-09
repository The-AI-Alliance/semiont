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

1. **Ensure development environment has AWS region**:
   ```bash
   # Check that development.json includes:
   # "aws": { "region": "us-east-2", ... }
   ```

2. **Deploy locally**:
   ```bash
   ./bin/semiont start local
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
   ./bin/semiont deploy production
   ```

## Environment Variables

### Configuration Loading

Scripts use explicit environment parameters:

```bash
./bin/semiont start production    # Uses production.json
./bin/semiont build development   # Uses development.json  
./bin/semiont test unit          # Uses unit.json
```

### Environment-Specific Properties

Each environment specifies its deployment configuration:

- **Local environments**: Use Docker containers
- **Cloud environments**: Use AWS ECS with required AWS config
- **Test environments**: Use containers or mock services

## Managing Secrets

Configuration files contain public settings. Secrets are managed separately:

```bash
# Set OAuth credentials
./bin/semiont configure production set oauth/google

# List all secrets
./bin/semiont configure production list

# Check secret status
./bin/semiont configure production get oauth/google
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
     "_comment": "Staging environment",
     "deployment": { "default": "aws" },
     "site": {
       "domain": "staging.example.com",
       "adminEmail": "admin@staging.example.com"
     },
     "aws": {
       "region": "us-east-2",
       "accountId": "123456789012"
     }
   }
   ```

3. **Use immediately**:
   ```bash
   ./bin/semiont deploy staging
   ```

## Deployment Types

Each service can specify its deployment type:

- **`aws`**: ECS Fargate service
- **`container`**: Local Docker container  
- **`process`**: Local process
- **`mock`**: Mock/test service
- **`external`**: External service

## Configuration Validation

The system validates configuration at load time:

- **Required fields**: Environment must have required properties for its deployment type
- **AWS validation**: Cloud environments must have complete AWS config
- **No defaults**: Missing required config causes explicit errors

## Best Practices

1. **Always specify AWS region** - No defaults provided
2. **Use complete environment configs** - Each environment is self-contained  
3. **Use inheritance sparingly** - Prefer explicit configuration
4. **Test configuration changes** - Use `--dry-run` flags
5. **Keep secrets separate** - Use AWS Secrets Manager, not JSON files

## Troubleshooting

### Missing AWS Configuration
```
Error: Environment production does not have AWS configuration
```
**Solution**: Add `aws` section with required `region` field.

### Invalid Region
```
Error: AWS region is required for deployment
```  
**Solution**: Ensure `aws.region` is specified in environment JSON.

### Configuration Not Found
```
Error: Configuration file not found: environments/staging.json
```
**Solution**: Create the environment JSON file or use existing environment name.

