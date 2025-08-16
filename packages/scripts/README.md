# Semiont Development Scripts

Development and build tools for the Semiont monorepo. This package contains scripts used for building, testing, and developing Semiont itself.

> **Note:** For user-facing CLI commands, see `apps/cli/` instead. This package is for development tools only.

## Overview

This package provides development and build automation for the Semiont monorepo, including TypeScript build tools, test runners, installation scripts, and performance benchmarking tools.

## Key Features

✅ **Monorepo Build Tools** - TypeScript compilation and workspace management  
✅ **Test Automation** - Vitest integration with coverage reporting  
✅ **Installation Scripts** - Automated setup and dependency management  
✅ **Performance Benchmarking** - Bundle analysis and performance monitoring  
✅ **Development Utilities** - Local secrets management and environment setup  

## User-Facing Commands

User-facing CLI commands are in `apps/cli/`. Use the global `semiont` command:

```bash
# Environment management
semiont provision -e local        # Setup local environment  
semiont start -e local            # Start services
semiont publish -e staging        # Build and push images
semiont update -e staging         # Update running services
semiont check -e production       # Health checks

# See all commands
semiont --help
```

## Development Scripts

These scripts are for **developing Semiont itself**, not for end-users:

### Installation & Setup
```bash
# Install Semiont CLI globally (recommended)
npm run install:cli            # Install CLI only
npm run install:full           # Full monorepo setup (all packages + CLI)

# Direct installation script (rarely needed)
npx tsx install.ts
```

### Build Tools  
```bash
# Build all packages
npm run build

# Development utilities
npx tsx local-secrets.ts        # Manage local dev secrets
npx tsx benchmark.ts            # Performance benchmarking
```


## Development Tools Available

### Local Development Utilities

```bash
# Local secrets management for development
npx tsx local-secrets.ts list
npx tsx local-secrets.ts set oauth/google
npx tsx local-secrets.ts get jwt-secret

# Performance benchmarking tools  
npx tsx benchmark.ts            # Run performance benchmarks
npx tsx benchmark.ts --analysis # Generate bundle analysis

# Build system
npm run build                   # Build all packages
npm run clean                   # Clean build artifacts  
npm run typecheck              # Run TypeScript checks
```

### Available Development Scripts

```bash
# Deployment utilities (for development/testing)
semiont update -e staging      # Update services in staging environment

# Real-time monitoring dashboard
semiont watch -e local         # Interactive monitoring dashboard

# Environment provisioning
semiont provision -e local     # Provision local development environment
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

### Core Development Libraries

- **`lib/installer.ts`** - Monorepo installation orchestrator
  - Manages workspace dependencies and build order
  - Handles CLI installation and global linking  
  - Progress reporting and error handling
  - Supports both full and CLI-only installation modes

- **`lib/dependency-graph.ts`** - Package dependency management
  - Analyzes workspace dependencies
  - Determines optimal build order
  - Handles circular dependency detection
  - TypeScript and build system integration

- **`lib/package-builder.ts`** - Build automation
  - TypeScript compilation for all packages
  - Handles different package types (apps, libs, CLI)
  - Build caching and incremental builds
  - Error reporting and build verification

- **`lib/progress-reporter.ts`** - Installation progress UI
  - Colored terminal output for installation steps
  - Step-by-step progress tracking
  - Success/error reporting with helpful messages
  - Verbose mode support for debugging

- **`lib/environment-validator.ts`** - Development environment checks
  - Node.js version validation
  - npm/yarn compatibility checks  
  - TypeScript compiler availability
  - Git repository validation

### Development Scripts

- **`install.ts`** - Main installation entry point
  - Orchestrates full monorepo setup
  - CLI-only installation option
  - Type-safe argument parsing with Zod
  - Comprehensive error handling

- **`local-secrets.ts`** - Development secrets management
  - Local OAuth credential setup
  - JWT secret generation
  - Environment variable management
  - Development-only secret storage

- **`benchmark.ts`** - Performance analysis tools
  - Bundle size analysis
  - Build time measurements
  - Memory usage profiling
  - Performance regression detection

- **`build.mjs`** - Build system orchestrator
  - Coordinates workspace builds
  - Handles TypeScript compilation
  - Manages build artifacts
  - Integration with npm scripts

### Development Scripts

- **`deploy.ts`** - Development deployment utilities (use `semiont update` instead)
- **`watch.tsx`** - Monitoring dashboard (use `semiont watch` instead)
- **Legacy service scripts** - Use `semiont` CLI commands instead

## How It Works

### Monorepo Build System

The build system manages workspace dependencies and compilation:

1. **Dependency Analysis** - Parse package.json files to build dependency graph
2. **Build Ordering** - Determine optimal build sequence based on dependencies
3. **Incremental Builds** - Only rebuild packages that have changed
4. **Type Safety** - Full TypeScript compilation with strict checking

Example build flow:
```typescript
// 1. Analyze dependencies
const graph = new DependencyGraph();
const buildOrder = graph.getBuildOrder();

// 2. Build in dependency order
for (const pkg of buildOrder) {
  await packageBuilder.buildPackage(pkg.path, pkg.name);
}

// 3. Link CLI globally
await packageBuilder.linkCliGlobally();
```

### Installation System

The installer orchestrates the complete setup process:

1. **Environment Validation** - Check Node.js, npm, TypeScript
2. **Dependency Installation** - Install root and workspace dependencies  
3. **Package Building** - Build all packages in correct order
4. **CLI Linking** - Install semiont CLI globally
5. **Verification** - Test that installation worked correctly

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
# Check installation
semiont --version
semiont --help

# Development build issues
npm run build                    # Build all packages
npm run clean                    # Clean and rebuild
npm run typecheck               # Check types only

# Installation issues  
npm run install:cli --verbose   # Verbose CLI installation
npm run install:full            # Full monorepo installation
```

## Development

### Adding New Development Scripts

1. Create a new TypeScript file in `packages/scripts/src/`
2. Use the existing patterns from `lib/` utilities
3. Add proper error handling and progress reporting
4. Update `package.json` scripts if needed
5. Document the new script in this README

### Contributing to Build System

1. Modify `lib/package-builder.ts` for build logic changes
2. Update `lib/dependency-graph.ts` for dependency management  
3. Extend `lib/installer.ts` for installation flow changes
4. Test with both `--cli-only` and full installation modes

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