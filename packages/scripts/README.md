# Semiont Management Scripts

TypeScript-based management scripts for Semiont on AWS that dynamically integrate with CDK stack definitions.

## Overview

These scripts provide a comprehensive management interface for your Semiont deployment on AWS. Unlike traditional bash scripts with hardcoded values, these TypeScript scripts dynamically discover resources from your CDK stack outputs, making them robust and maintainable.

## Key Features

✅ **No hardcoded values** - All resource names/ARNs are dynamically discovered from CDK stack outputs  
✅ **Type safety** - Full TypeScript with AWS SDK v3 and strict type checking  
✅ **Security first** - Command injection prevention, input validation, and sensitive data redaction  
✅ **Better error handling** - Comprehensive error types and troubleshooting hints  
✅ **Auto-discovery** - Scripts automatically find the right clusters, services, secrets, etc.  
✅ **Unified interface** - Single `./semiont` command for all operations  
✅ **Self-contained** - Auto-installs dependencies when needed  
✅ **Structured logging** - Secure logging with automatic sensitive data filtering  

## Quick Start

The easiest way to use these scripts is through the unified `semiont` wrapper located in `/bin`:

```bash
# Validate your configuration
./bin/semiont configure validate

# Interactive real-time dashboard (New!)
./bin/semiont watch

# Focus on specific monitoring
./bin/semiont watch logs              # Log streaming
./bin/semiont watch metrics           # Performance metrics

# Check deployment status (legacy)
./bin/semiont check

# Run tests with custom environment
./bin/semiont test --environment staging --suite integration
```

## Available Commands

### 📊 Real-time Monitoring (New!)

The `watch` command provides modern, interactive monitoring with React-powered terminal dashboards:

```bash
# Unified dashboard - recommended default view
./bin/semiont watch

# Focused log streaming with service status
./bin/semiont watch logs

# Performance metrics dashboard  
./bin/semiont watch metrics

# Filter to specific services
./bin/semiont watch logs frontend
./bin/semiont watch logs backend
```

**Interactive Controls:**
- `q` - Quit dashboard
- `r` - Force refresh data
- `↑↓` - Scroll through logs
- `Space` - Toggle auto-scroll
- `g/G` - Jump to top/bottom of logs

### Service Management

```bash
# Interactive dashboard with services, logs, and metrics
./bin/semiont watch

# Check comprehensive status of all components (legacy)
./bin/semiont check

# Restart Semiont service (force new deployment)
./bin/semiont restart production

# View container logs
./semiont logs [tail|follow]

# Execute commands in running container
./semiont exec [command]
./semiont exec "cat /tmp/php-error.log"
./semiont exec "/bin/bash"  # Interactive shell
```

### Secrets Management

```bash
# List all available secrets
./semiont secrets list

# Configure Google OAuth
./semiont secrets set oauth/google

# Configure GitHub OAuth  
./semiont secrets set oauth/github

# Set JWT signing secret
./semiont secrets set jwt-secret "your-32-character-secret"

# View secret status (masked)
./semiont secrets get oauth/google
```

### Database Operations

```bash
# Create database backup with auto-generated name
./semiont backup

# Create database backup with custom name
./semiont backup "pre-upgrade-20250127"
./semiont backup "before-oauth-changes"

# Show backup help and examples
./semiont backup --help
```

### Configuration Management

```bash
# View current configuration (sensitive data masked)
./semiont config show

# Validate configuration for errors
./semiont config validate

# Show current environment and active overrides
./semiont config env

# Export configuration as environment variables
./semiont config export > .env

# Initialize configuration from example template
./semiont config init
```

### Build & Deployment

```bash
# Build applications and Docker images
./semiont build                    # Build everything
./semiont build frontend           # Build frontend only
./semiont build backend            # Build backend only
./semiont build docker             # Build Docker images only

# Create AWS infrastructure stacks
./semiont create                   # Create both stacks
./semiont create infra             # Create infrastructure only (VPC, RDS, EFS, Secrets)
./semiont create app               # Create application only (ECS, ALB, WAF)

# Deploy application code and images
./semiont deploy <environment>      # Deploy application code and images

# Deploy with manual approval for changes
./semiont create --approval
./semiont create app --approval

# Show build/create help and options
./semiont build --help
./semiont create --help
./semiont deploy --help
```

### Maintenance

```bash
# Run database maintenance commands
./semiont maintenance [command]

# Available maintenance commands:
./semiont maint update        # Update database schema
./semiont maint migrate       # Run database migrations
./semiont maint cache-clear   # Clear application cache
./semiont maint stats         # Show application statistics
```

### Performance Analysis

```bash
# Run comprehensive performance check
./semiont perf check

# Run bundle analysis with visual report
./semiont perf analyze

# Run performance monitoring
./semiont perf monitor

# Run Lighthouse CI tests
./semiont perf lighthouse

# View latest performance report
./semiont perf report

# Show performance command help
./semiont perf --help
```

## Configuration System

Semiont uses a centralized, environment-aware configuration system located in `/config`:

### Environment Management

Semiont uses `SEMIONT_ENV` (not `NODE_ENV`) to determine configuration:

```bash
# Development environment
export SEMIONT_ENV=development

# Production environment (uses example.com - must be customized)
export SEMIONT_ENV=production
```

### Configuration Structure

```
/config/
├── base/                        # Base configurations (no hardcoded values)
│   ├── site.config.ts          # Site settings (name, description)
│   ├── aws.config.ts           # AWS defaults (region, stack names)
│   └── app.config.ts           # Application settings
├── environments/               # Environment-specific JSON configurations
│   ├── development.json        # Example development values - customize for your deployment
│   ├── production.json         # Example values - MUST BE CUSTOMIZED
│   ├── integration.json        # Integration test environment
│   ├── test.json              # Base test configuration
│   ├── unit.json              # Unit test configuration
│   └── *.json                 # Custom environment configurations
├── schemas/                    # TypeScript interfaces and validation
└── index.ts                   # Main configuration export with JSON loading
```

### Configuration Commands

The `config` command provides configuration management:

```bash
./semiont config show      # View current config (masked sensitive data)
./semiont config validate  # Check for configuration errors
./semiont config env       # Show current environment and overrides
./semiont config export    # Export as environment variables
```

### Customizing for Production

1. Edit `/config/environments/production.ts`
2. Replace all `example.com` values with your actual domain/AWS settings
3. Set `SEMIONT_ENV=production`
4. Run `./semiont config validate` to verify

## Architecture

### Core Components

- **`lib/stack-config.ts`** - Dynamic CDK stack configuration reader
  - Fetches outputs from CloudFormation stacks
  - Provides typed access to resource names and ARNs
  - Comprehensive error handling with proper AWS error types
  - Caches configuration for performance

- **`lib/types.ts`** - Comprehensive type definitions
  - Type-safe interfaces for all AWS resources and operations
  - Custom error types (`ScriptError`, `AWSError`, `ValidationError`)
  - Type guards and validation utilities
  - Eliminates use of `any` types throughout the codebase

- **`lib/logger.ts`** - Secure structured logging
  - Automatic detection and redaction of sensitive data (API keys, passwords, emails)
  - Structured logging with timestamps and context
  - Multiple log levels (debug, info, warn, error)
  - Colored output for better readability

- **`lib/validators.ts`** - Input validation and sanitization
  - Prevents command injection attacks
  - Path traversal protection
  - AWS resource name validation
  - Email and JSON validation utilities

- **`lib/command-runner.ts`** - Secure command execution
  - Safe command execution with injection prevention
  - Timeout handling and process management
  - Specialized runners for AWS CLI, npm, and CDK commands
  - Environment variable sanitization

- **`package.json`** - Dependencies and npm scripts
  - AWS SDK v3 clients for all required services
  - TypeScript execution via `tsx`
  - Development dependencies for type checking

### Management Scripts

1. **`config.ts`** - Configuration management CLI
   - View, validate, and export configuration settings
   - Environment-aware configuration with SEMIONT_ENV support
   - Sensitive data masking and validation
   - Environment variable export for deployment

2. **`build.ts`** - Application and Docker image builder
   - Build frontend and backend applications
   - Create Docker images with proper tagging
   - Input/output validation and hash verification
   - Build artifact verification

3. **`create.ts`** - AWS infrastructure stack creation
   - Deploy CDK infrastructure and application stacks
   - ECR repository management and image pushing
   - Prerequisite checking and dependency validation
   - Progress monitoring and error diagnostics

4. **`deploy.ts`** - Application code and container deployment
   - Push local Docker images to ECR with timestamped tags
   - Update ECS services with new container images
   - Deployment verification and rollback support
   - ECS task diagnostics and failure analysis

5. **`logs.ts`** - Container log viewer with security enhancements
   - Dynamically discovers log groups and streams
   - Supports both tail and follow modes with type-safe argument parsing
   - Integrates with CloudWatch Logs API using secure command execution
   - WAF and ALB log analysis with structured output
   - Automatic task switching during deployments

2. **`status.ts`** - Comprehensive status checker with enhanced reliability
   - ECS service and task status with deployment history
   - Website health checks with HTTP status and timeout handling
   - Database connectivity and engine information with proper error handling
   - Recent deployment progress and rollout state
   - Cost estimation with both actual and projected costs
   - Secure logging throughout all status checks

3. **`secrets.ts`** - Secrets management (OAuth, JWT, etc.)
   - List, get, and set secrets stored in AWS Secrets Manager
   - Interactive credential setup for OAuth providers
   - Path-based secret organization (oauth/google, jwt-secret, etc.)
   - Secure value masking and validation
   - Support for both JSON objects and simple strings

4. **`restart.ts`** - Service restart utility
   - Forces new ECS deployment
   - Provides progress monitoring guidance

5. **`exec.ts`** - Container command execution
   - Interactive shell access
   - Command execution in running containers
   - Proper error handling for ECS Exec requirements

6. **`db-backup.ts`** - Database backup utility
   - Automatic database discovery
   - Auto-generated timestamp names or custom names
   - Comprehensive backup status and monitoring
   - Progress tracking with AWS CLI commands

7. **`deploy.ts`** - Infrastructure deployment manager
   - Deploy infrastructure and/or application stacks
   - Prerequisite checking and dependency installation
   - Progress reporting with timing information
   - Approval workflows and error handling

8. **`performance.ts`** - Performance analysis utility
   - Bundle size analysis with visual reports
   - Performance monitoring with recommendations
   - Lighthouse CI integration for Core Web Vitals
   - Historical performance tracking and reports

## How It Works

### Dynamic Resource Discovery

Instead of hardcoding cluster names and service ARNs, the scripts:

1. **Query CloudFormation** - Read stack outputs from `SemiontInfraStack` and `SemiontAppStack`
2. **Cache Configuration** - Store resource information for the session
3. **Type-Safe Access** - Provide strongly-typed getters for all resources

Example:
```typescript
// Old approach (hardcoded)
const clusterName = "SemiontAppStack-SemiontCluster82385F1E-3kHlZPAROgIe";

// New approach (dynamic)
const clusterName = await config.getClusterName();
```

### CDK Integration

The scripts rely on CDK stack outputs that are automatically generated during deployment:

**From SemiontAppStack:**
- `ClusterName` - ECS cluster name
- `FrontendServiceName` - Frontend ECS service name
- `BackendServiceName` - Backend ECS service name
- `LogGroupName` - CloudWatch log group
- `CustomDomainUrl` - Website URL

**From SemiontInfraStack:**
- `GoogleOAuthSecretName` - Google OAuth credentials
- `AppSecretsName` - Application secrets
- `DatabaseEndpoint` - RDS database endpoint

### Security & Error Handling

Scripts implement comprehensive security measures and error handling:

**Security Features:**
- **Command injection prevention** - All commands are validated and sanitized
- **Input validation** - Path traversal protection and resource name validation
- **Sensitive data redaction** - Automatic filtering of API keys, passwords, and secrets from logs
- **Safe environment handling** - Controlled environment variable access

**Error Handling:**
- **Typed errors** - Custom error types (`ScriptError`, `AWSError`, `ValidationError`)
- **Structured logging** - Consistent error reporting with context
- **Missing dependencies** - Auto-installation prompts with security checks
- **AWS permissions** - Clear permission requirement explanations  
- **Service issues** - Diagnostic information and resolution steps
- **Configuration problems** - Helpful hints for common setup issues

## Prerequisites

### AWS Credentials

Ensure your AWS credentials are configured:

```bash
# Via AWS CLI
aws configure

# Or via environment variables
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
export AWS_DEFAULT_REGION="us-east-2"

# Or via AWS SSO
aws sso login
```

### Dependencies

Dependencies are automatically installed when using `./semiont`, but you can manually install:

```bash
cd scripts
npm install
```

### ECS Exec (Optional)

For container execution (`./semiont exec`), install the Session Manager plugin:

- **macOS**: `brew install --cask session-manager-plugin`
- **Linux/Windows**: [AWS Documentation](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## Direct Script Usage

You can also run scripts directly with TypeScript execution:

```bash
# Using npx tsx
npx tsx logs.ts follow
npx tsx secrets.ts list
npx tsx status.ts

# Using npm scripts (from scripts directory)
npm run logs
npm run secrets
npm run status
```

## Configuration

Scripts use the centralized configuration system in `/config` which automatically detects:

- **CDK Stack Names**: `SemiontInfraStack` and `SemiontAppStack` 
- **AWS Region**: `us-east-2` (default)
- **Environment**: Determined by `SEMIONT_ENV` variable (defaults to development)

### Customization Options

**For Development** (customize the example values):
1. Edit `/config/environments/development.json`
2. Replace all example.com values with your actual development settings
3. Validate configuration:
```bash
./semiont config validate
```

**For Production** (customize the example values):
1. Edit `/config/environments/production.json`
2. Replace all example.com values with your actual settings
3. Validate configuration:
```bash
./semiont config validate
```

**To modify defaults** (stack names, region), edit `/config/base/aws.config.ts`:
```typescript
export const awsConfig: AWSConfiguration = {
  region: process.env.AWS_REGION || 'your-preferred-region',
  stackPrefix: 'YourPrefix',
  infraStackName: process.env.INFRA_STACK_NAME || 'YourCustomInfraStack',
  appStackName: process.env.APP_STACK_NAME || 'YourCustomAppStack',
  // ...
};
```

## Troubleshooting

### Common Issues

**"Configuration validation failed"**
- Validate configuration: `./semiont config validate`
- For production, ensure `/config/environments/production.json` is customized
- Check that all required fields are present in your JSON configuration

**"Invalid domain is required"**
- For development, ensure `/config/environments/development.json` has valid domain settings
- For production, customize `/config/environments/production.json` with your domain
- Run `./semiont config validate` to verify

**"No running tasks found"**
- Check if the Semiont service is running: `./semiont status`
- Restart the service if needed: `./semiont restart`

**"Stack not found"**
- Ensure CDK stacks are created: `./semiont create`
- Verify stack names in AWS CloudFormation console

**"ECS Exec failed"**
- Install Session Manager plugin (see Prerequisites)
- Ensure ECS Exec is enabled on the service
- Check IAM permissions for ECS Exec

**"OAuth not appearing on login page"**
- Configure OAuth credentials: `./semiont secrets set oauth/google`
- Restart service after configuration: `./semiont restart`
- Check container logs: `./semiont logs`

**"Database backup failed"**
- Check database status: `./semiont status`
- Ensure database is in "available" state
- Verify unique backup name (no duplicates)

**"Deployment failed"**
- Check AWS credentials: `aws sts get-caller-identity`
- Verify IAM permissions for CloudFormation
- Check deployment logs for specific errors
- Use `./semiont deploy --help` for options

### Getting Help

```bash
# Show available commands
./semiont help

# Check configuration
./semiont config validate
./semiont config show

# Check service status
./semiont status

# View error logs
./semiont logs
./semiont exec "cat /tmp/php-error.log"
```

## Development

### Adding New Scripts

1. Create a new TypeScript file in the `scripts/` directory
2. Import and use `SemiontStackConfig` for resource discovery
3. Add error handling and user-friendly output
4. Update the `semiont` wrapper script to include the new command
5. Document the new command in this README

### Example Script Structure

```typescript
#!/usr/bin/env -S npx tsx

import { SemiontStackConfig } from './lib/stack-config';
import { config } from '../config';
import { SomeAWSClient } from '@aws-sdk/client-some-service';
import { ScriptError, AWSError } from './lib/types.js';
import { logger } from './lib/logger.js';
import { validateAwsResourceName, assertValid } from './lib/validators.js';

const stackConfig = new SemiontStackConfig();
const client = new SomeAWSClient({ region: config.aws.region });

async function myOperation() {
  try {
    logger.info('Starting operation');
    
    // Type-safe resource access with validation
    const resourceName = await stackConfig.getSomeResource();
    const validatedName = assertValid(
      validateAwsResourceName(resourceName),
      'Resource name validation'
    );
    
    // Perform operation with error handling
    const result = await client.someOperation({ ResourceName: validatedName });
    
    logger.info('Operation completed successfully', { 
      resourceName: validatedName,
      resultCount: result.Items?.length || 0
    });
    
  } catch (error) {
    if (error instanceof AWSError) {
      logger.error('AWS operation failed', { 
        error: error.message,
        code: error.code,
        details: error.details 
      });
    } else {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Operation failed', { error: errorMessage });
    }
    process.exit(1);
  }
}

async function main() {
  try {
    await myOperation();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Script execution failed', { error: errorMessage });
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

## Security Considerations

The scripts implement multiple layers of security protection:

### Input Security
- **Command injection prevention** - All user inputs and commands are validated and sanitized
- **Path traversal protection** - File paths are validated to prevent directory traversal attacks
- **Input validation** - All parameters are validated against expected patterns and types

### Data Protection
- **Sensitive data redaction** - Automatic detection and filtering of API keys, passwords, tokens, and email addresses from logs
- **Secure credential handling** - OAuth credentials are stored encrypted in AWS Secrets Manager
- **Environment isolation** - Safe environment variable handling with controlled access

### AWS Security
- **Credential security** - Scripts use your AWS credentials; ensure they're properly secured with least-privilege access
- **IAM permissions** - Scripts require appropriate permissions for ECS, CloudFormation, Secrets Manager, etc.
- **Resource validation** - AWS resource names and ARNs are validated before use

### Runtime Security
- **Error handling** - Structured error handling prevents information leakage
- **Timeout protection** - All operations have configurable timeouts to prevent resource exhaustion
- **Process isolation** - Safe command execution with controlled environment and resource limits

## Related Documentation

- [OAuth Configuration Guide](../docs/OAuth.md) - Detailed OAuth setup instructions
- [Deployment Guide](../docs/DEPLOYMENT.md) - Infrastructure deployment steps  
- [Troubleshooting Guide](../docs/TROUBLESHOOTING.md) - Common issues and solutions
- [CDK Documentation](../cdk/README.md) - Infrastructure code documentation