# Semiont Configuration Guide

This document describes how configuration is managed in the Semiont application using the environment-based configuration system.

## Overview

Semiont uses an **environment-based configuration system** with JSON configuration files stored in the `/config/environments/` directory at the project root. Each environment is completely self-contained with all required configuration.

## Configuration Architecture

### 1. **File Structure**

Configuration files are located at the project root:

```
<project-root>/
├── semiont.json                  # Project metadata (created by semiont init)
└── config/
    └── environments/             # Environment configurations
        ├── local.json           # Local development
        ├── development.json     # Development environment
        ├── staging.json         # Staging environment
        ├── production.json      # Production environment
        ├── test.json            # Test environment base
        ├── unit.json            # Unit test configuration
        └── integration.json     # Integration test configuration
```

### 2. **Project Root Detection**

The project root is determined by:

1. **SEMIONT_ROOT environment variable** (highest priority)
2. **Walking up directories** looking for `semiont.json`
3. **Fallback** to directories containing `config/environments/`

```bash
# Override project root if needed
export SEMIONT_ROOT=/path/to/project

# Or let it auto-detect based on semiont.json
cd /anywhere/in/project
semiont start  # Finds project root automatically
```

### 3. **Environment Configuration Schema**

Each environment configuration file follows this structure:

```json
{
  "_comment": "Environment description",
  "_extends": "base-environment",  // Optional: inherit from another config
  
  "site": {
    "name": "My Semiont Instance",
    "domain": "wiki.example.com",
    "adminEmail": "admin@example.com",
    "oauthAllowedDomains": ["example.com"]
  },
  
  "services": {
    "backend": {
      "deployment": { "type": "aws" },  // aws | container | process | external
      "port": 3001,
      "host": "localhost"
    },
    "frontend": {
      "deployment": { "type": "aws" },
      "port": 3000
    },
    "database": {
      "deployment": { "type": "container" },
      "name": "semiont_db",
      "port": 5432
    }
  },
  
  "aws": {
    "region": "us-east-2",
    "accountId": "123456789012",
    "certificateArn": "arn:aws:acm:...",
    "hostedZoneId": "Z1234567890ABC",
    "stacks": {
      "infra": "SemiontInfraStack",
      "app": "SemiontAppStack"
    }
  }
}
```

### 4. **Configuration Loading Process**

1. **Find Project Root**: Uses SEMIONT_ROOT or searches for semiont.json
2. **Load Base Config**: Reads `<root>/semiont.json` for project defaults
3. **Load Environment Config**: Reads `<root>/config/environments/<env>.json`
4. **Merge Configurations**: Deep merges base defaults with environment-specific settings
5. **Return Typed Config**: Returns validated EnvironmentConfig object

## Quick Start

### For Development

1. **Initialize project configuration**:
   ```bash
   semiont init --name "my-project" --environments "local,staging,production"
   ```
   This creates:
   - `semiont.json` - Project metadata
   - `config/environments/local.json` - Local development config
   - `config/environments/staging.json` - Staging config
   - `config/environments/production.json` - Production config

2. **Start local development**:
   ```bash
   export SEMIONT_ENV=local
   semiont start
   ```

### For Production

1. **Edit `config/environments/production.json`**:
   ```json
   {
     "site": {
       "name": "Production Wiki",
       "domain": "wiki.yourdomain.com",
       "adminEmail": "admin@yourdomain.com"
     },
     "services": {
       "backend": { "deployment": { "type": "aws" } },
       "frontend": { "deployment": { "type": "aws" } },
       "database": { "deployment": { "type": "aws" } }
     },
     "aws": {
       "region": "us-east-1",
       "accountId": "your-account-id",
       "certificateArn": "arn:aws:acm:...",
       "hostedZoneId": "your-zone-id"
     }
   }
   ```

2. **Deploy to AWS**:
   ```bash
   export SEMIONT_ENV=production
   semiont provision  # Create infrastructure
   semiont publish    # Build and push images
   semiont update     # Deploy services
   ```

## Deployment Types

Each service can have one of four deployment types:

### 1. **AWS Deployment** (`"type": "aws"`)
Used for production cloud deployments:
- Backend/Frontend: ECS Fargate containers
- Database: RDS PostgreSQL
- Storage: EFS

### 2. **Container Deployment** (`"type": "container"`)
Used for local development with Docker/Podman:
- Runs services in containers
- Auto-detects Docker or Podman
- Manages container lifecycle

### 3. **Process Deployment** (`"type": "process"`)
Used for simple local development:
- Runs services as Node.js processes
- No containerization overhead
- Direct filesystem access

### 4. **External Deployment** (`"type": "external"`)
Used for third-party or existing services:
- References external endpoints
- No lifecycle management
- Configuration only

## Environment Variables

### Core Environment Variables

- **SEMIONT_ENV**: Default environment (overrides --environment flag)
- **SEMIONT_ROOT**: Project root directory (parent of config/)
- **AWS_PROFILE**: AWS profile for AWS operations
- **AWS_REGION**: AWS region (overrides config file)

### Setting Default Environment

```bash
export SEMIONT_ENV=production

# All commands now use production environment
semiont start       # Uses config/environments/production.json
semiont publish     # Uses config/environments/production.json
semiont check       # Uses config/environments/production.json
```

### Overriding Environment

Override per command with `--environment`:

```bash
# With SEMIONT_ENV=production set
semiont start --environment staging  # Uses config/environments/staging.json
```

## Configuration Resolution Order

The CLI looks for configuration in this order:

1. `$SEMIONT_ROOT/config/environments/<env>.json` (if SEMIONT_ROOT is set)
2. Current directory: `./config/environments/<env>.json`
3. Parent directories (walks up looking for semiont.json)
4. Parent directories with `config/environments/` (backward compatibility)

## Secrets Management

### Never Store Secrets in Config Files

Configuration files are committed to git. Use the `configure` command for secrets:

```bash
# Set secrets for local development
semiont configure set jwt-secret
semiont configure set database-password

# Set OAuth credentials
semiont configure set oauth/google
semiont configure set oauth/github

# View configured secrets (values hidden)
semiont configure show
```

For AWS deployments, secrets are stored in AWS Secrets Manager.

## Configuration Inheritance

Environments can extend other configurations using `_extends`:

```json
{
  "_extends": "test",
  "_comment": "Integration tests extend base test config",
  "services": {
    "database": {
      "name": "semiont_integration_test"
    }
  }
}
```

The child configuration merges with and overrides the parent.

## Authentication Configuration

### OAuth Setup

Configure OAuth in your environment file:

```json
{
  "site": {
    "oauthAllowedDomains": ["example.com", "company.org"]
  }
}
```

Then set the OAuth credentials:
```bash
semiont configure set oauth/google
```

### JWT Configuration

JWT secrets must be configured securely:

```bash
# Local development
semiont configure set jwt-secret

# Production (stored in AWS Secrets Manager)
SEMIONT_ENV=production semiont configure set jwt-secret
```

## Validation

### Validate Configuration

Check configuration before deployment:

```bash
# Validate current environment
semiont configure validate

# Validate specific environment
semiont configure validate --environment production

# Dry run to test configuration
semiont provision --dry-run
semiont publish --dry-run
```

## Best Practices

1. **Environment Naming**: Use standard names: `local`, `development`, `staging`, `production`
2. **Keep Secrets Secure**: Never commit secrets to git
3. **Use Inheritance**: Share common config with `_extends`
4. **Validate Before Deploy**: Always run validation before deployment
5. **Document Custom Config**: Add `_comment` fields to explain non-obvious settings

## Troubleshooting

### Configuration Not Found

```bash
# Check project root detection
ls -la semiont.json
echo $SEMIONT_ROOT

# Check environment directory
ls -la config/environments/

# Check current environment
echo $SEMIONT_ENV

# List available environments
ls config/environments/*.json
```

### Invalid Configuration

```bash
# Validate configuration schema
semiont configure validate

# Check for JSON syntax errors
python -m json.tool < config/environments/production.json
```

### Wrong Environment Used

```bash
# Check environment precedence
echo $SEMIONT_ENV                    # Environment variable
semiont check --environment staging  # Command flag (overrides SEMIONT_ENV)
```

### Project Root Issues

```bash
# Explicitly set project root if auto-detection fails
export SEMIONT_ROOT=/path/to/project

# Or run from project directory
cd /path/to/project
semiont start
```

## Implementation Details

The configuration system is implemented in `apps/cli/src/lib/deployment-resolver.ts`, which provides:

- **`loadEnvironmentConfig(environment: string)`**: Loads and merges configuration for a specific environment
- **`findProjectRoot()`**: Locates the project root by searching for `semiont.json`
- **`getAvailableEnvironments()`**: Lists all available environment configurations
- **`isValidEnvironment(environment: string)`**: Validates if an environment exists

### Backend Configuration

Backend services receive configuration through environment variables at runtime:

- **`SITE_DOMAIN`**: Domain for JWT issuer (from `config.site.domain`)
- **`OAUTH_ALLOWED_DOMAINS`**: Comma-separated list of allowed OAuth domains (from `config.site.oauthAllowedDomains`)
- **`JWT_SECRET`**: Authentication secret (from AWS Secrets Manager or local development)
- **`DATABASE_URL`**: Database connection string
- **`NODE_ENV`**: Runtime environment (development/production/test)
- **`SEMIONT_ENV`**: Semiont environment name

The CLI automatically passes these environment variables when starting services.

## Related Documentation

- [apps/cli/src/lib/deployment-resolver.ts](../apps/cli/src/lib/deployment-resolver.ts) - Configuration loading implementation
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide using configurations
- [apps/cli/README.md](../apps/cli/README.md) - CLI commands that use configuration
- [apps/backend/src/auth/jwt.ts](../apps/backend/src/auth/jwt.ts) - Backend JWT service using environment variables