# Semiont CLI

The unified command-line interface for managing Semiont environments and services with deployment-type aware operations.

## Overview

The Semiont CLI provides a consistent interface for:
- **Service Management**: start, stop, restart, check, watch services based on deployment type
- **Infrastructure Operations**: provision, configure, backup services across deployment types
- **Development Workflows**: publish, update, test, exec commands with deployment-type awareness
- **Safety Features**: comprehensive `--dry-run` support for all operations
- **Environment Agnostic**: no special treatment of "local" vs "cloud" environments

## Quick Links

- [**Adding New Commands Guide**](./ADDING_COMMANDS.md) - Step-by-step guide for adding new CLI commands
- [Service-Command Matrix](#service-command-matrix) - How commands work with different deployment types
- [Contributing](#contributing) - Development guidelines and best practices

## Installation

```bash
# From the CLI directory
cd apps/cli
npm run build               # Build the CLI
npm link                    # Install globally

# After installation, the 'semiont' command is available globally
semiont --help
```

## Architecture

### Directory Structure

```
packages/cli/
├── cli.ts.                   # CLI entry point
├── commands/                 # Command implementations (deployment-type aware)
│   ├── start.ts             # Start services based on deployment type
│   ├── stop.ts              # Stop services based on deployment type
│   ├── restart.ts           # Restart services based on deployment type
│   ├── provision.ts         # Provision infrastructure based on deployment type
│   ├── configure.ts         # Configure services based on deployment type
│   ├── publish.ts           # Build and push images (container/aws services)
│   ├── update.ts            # Update running services with latest code/images
│   ├── check.ts             # Health checks based on deployment type
│   ├── watch.ts             # Monitor logs/metrics based on deployment type
│   ├── test.ts              # Run tests based on deployment type
│   ├── exec.ts              # Execute commands based on deployment type
│   └── backup.ts            # Create backups based on deployment type
└── lib/                      # Shared utilities
    ├── cli-colors.ts         # Color definitions
    ├── cli-paths.ts          # Path resolution
    ├── services.ts           # Service selection and validation
    ├── deployment-resolver.ts # Deployment type resolution (core)
    └── container-runtime.ts  # Container operations (Docker/Podman)
```

### Environment Selection

The CLI determines the environment using the following precedence:

1. **Command-line flag** (`-e` or `--environment`) - highest priority
2. **Environment variable** (`SEMIONT_ENV`) - fallback
3. **Default** (`local`) - if neither is specified

Example:
```bash
# Set default environment via SEMIONT_ENV
export SEMIONT_ENV=staging

# Commands will use staging by default
semiont start                    # Uses staging
semiont check --service backend  # Uses staging

# Override with -e flag when needed
semiont start -e production      # Uses production
```

### Core Architecture: Deployment-Type Awareness

The CLI is built around the concept that **services have deployment types**, not environments:

- **AWS**: Services running on ECS, RDS, EFS (managed cloud infrastructure)
- **Container**: Services running in local containers (Docker/Podman)
- **Process**: Services running as local processes (development)
- **External**: Services managed separately (third-party SaaS, existing infrastructure)

Each command adapts its behavior based on the deployment type of each service:

```typescript
// Example: start command logic
switch (serviceInfo.deploymentType) {
  case 'aws': await startECSService(serviceInfo); break;
  case 'container': await startContainer(serviceInfo); break;
  case 'process': await startProcess(serviceInfo); break;
  case 'external': await verifyExternalService(serviceInfo); break;
}
```

### Key Design Patterns

1. **Deployment-Type Aware Operations** - All commands adapt behavior per service deployment type
2. **Centralized Service Resolution** - `resolveServiceDeployments()` provides deployment info
3. **Shared Utilities** - Common functionality in `lib/` to avoid duplication
4. **Comprehensive Dry-Run Support** - All commands support `--dry-run` with detailed previews
5. **Type Safety** - Full Zod validation for all arguments and service configurations
6. **Environment Agnostic** - No special treatment of environment names ("local" vs "production")
7. **Container-Runtime Agnostic** - Support for both Docker and Podman

## Adding a New Command

Follow this pattern when adding new commands to maintain deployment-type awareness:

### 1. Create the Command File (commands/mycommand.ts)

```typescript
/**
 * MyCommand V2 - Deployment-type aware description of what this command does
 * 
 * This command operates on services based on deployment type:
 * - AWS: Description of AWS-specific behavior
 * - Container: Description of container-specific behavior
 * - Process: Description of process-specific behavior
 * - External: Description of external service behavior
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const MyCommandOptionsSchema = z.object({
  environment: z.string(),
  service: z.string().default('all'),
  myOption: z.string().optional(),
  count: z.number().int().positive().default(1),
  force: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

type MyCommandOptions = z.infer<typeof MyCommandOptionsSchema>;

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function printSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function printInfo(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

function printDebug(message: string, options: MyCommandOptions): void {
  if (options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// PARSE ARGUMENTS
// =====================================================================

function parseArguments(): MyCommandOptions {
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV || process.argv[2],
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
  };
  
  // Parse command-line arguments
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--service':
      case '-s':
        rawOptions.service = args[++i];
        break;
      case '--my-option':
        rawOptions.myOption = args[++i];
        break;
      case '--count':
        rawOptions.count = parseInt(args[++i]);
        break;
      case '--force':
      case '-f':
        rawOptions.force = true;
        break;
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
    }
  }
  
  // Validate with Zod
  try {
    return MyCommandOptionsSchema.parse(rawOptions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      printError('Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

// =====================================================================
// DEPLOYMENT-TYPE-AWARE COMMAND FUNCTIONS
// =====================================================================

async function processService(serviceInfo: ServiceDeploymentInfo, options: MyCommandOptions): Promise<void> {
  if (options.dryRun) {
    printInfo(`[DRY RUN] Would process ${serviceInfo.name} (${serviceInfo.deploymentType})`);
    return;
  }
  
  printInfo(`Processing ${serviceInfo.name} (${serviceInfo.deploymentType})...`);
  
  switch (serviceInfo.deploymentType) {
    case 'aws':
      await processAWSService(serviceInfo, options);
      break;
    case 'container':
      await processContainerService(serviceInfo, options);
      break;
    case 'process':
      await processProcessService(serviceInfo, options);
      break;
    case 'external':
      await processExternalService(serviceInfo, options);
      break;
    default:
      printWarning(`Unknown deployment type '${serviceInfo.deploymentType}' for ${serviceInfo.name}`);
  }
}

async function processAWSService(serviceInfo: ServiceDeploymentInfo, options: MyCommandOptions): Promise<void> {
  // AWS-specific implementation
  printInfo(`AWS processing for ${serviceInfo.name}`);
  // Implementation details...
}

async function processContainerService(serviceInfo: ServiceDeploymentInfo, options: MyCommandOptions): Promise<void> {
  // Container-specific implementation
  printInfo(`Container processing for ${serviceInfo.name}`);
  // Implementation details...
}

async function processProcessService(serviceInfo: ServiceDeploymentInfo, options: MyCommandOptions): Promise<void> {
  // Process-specific implementation
  printInfo(`Process processing for ${serviceInfo.name}`);
  // Implementation details...
}

async function processExternalService(serviceInfo: ServiceDeploymentInfo, options: MyCommandOptions): Promise<void> {
  // External service handling
  printInfo(`External service processing for ${serviceInfo.name}`);
  // Implementation details...
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArguments();
  
  printInfo(`Processing services in ${colors.bright}${options.environment}${colors.reset} environment`);
  
  if (options.verbose) {
    printDebug(`Options: ${JSON.stringify(options, null, 2)}`, options);
  }
  
  try {
    // Validate service selector and resolve to actual services
    await validateServiceSelector(options.service, 'start', options.environment);
    const resolvedServices = await resolveServiceSelector(options.service, 'start', options.environment);
    
    // Get deployment information for all resolved services
    const serviceDeployments = await resolveServiceDeployments(resolvedServices, options.environment);
    
    printDebug(`Resolved services: ${serviceDeployments.map(s => `${s.name}(${s.deploymentType})`).join(', ')}`, options);
    
    if (options.dryRun) {
      printInfo('[DRY RUN] Would process the following services:');
      for (const serviceInfo of serviceDeployments) {
        printInfo(`  - ${serviceInfo.name} (${serviceInfo.deploymentType})`);
      }
      return;
    }
    
    // Process all services
    let allSucceeded = true;
    for (const serviceInfo of serviceDeployments) {
      try {
        await processService(serviceInfo, options);
      } catch (error) {
        printError(`Failed to process ${serviceInfo.name}: ${error}`);
        allSucceeded = false;
        if (!options.force) {
          break; // Stop on first error unless --force
        }
      }
    }
    
    if (allSucceeded) {
      printSuccess('All services processed successfully');
    } else {
      printWarning('Some services failed to process - check logs above');
      if (!options.force) {
        printInfo('Use --force to ignore errors and continue');
      }
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Command failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { main, MyCommandOptions, MyCommandOptionsSchema };
```

### 2. Key Patterns to Follow

1. **Deployment-Type Switching**: Always use `switch (serviceInfo.deploymentType)` pattern
2. **Service Resolution**: Use `resolveServiceDeployments()` to get deployment information
3. **Dry-Run Support**: Include comprehensive `--dry-run` logic at both service and command levels
4. **Error Handling**: Use consistent error patterns with proper exit codes
5. **Shared Utilities**: Import from `lib/` for colors, service resolution, container runtime
6. **Type Safety**: Full Zod validation with TypeScript interfaces

## Command Reference

All commands are **deployment-type aware** and adapt behavior based on each service's deployment type.

### Service Management

| Command | Description | Deployment Types Supported |
|---------|-------------|--------------------------|
| `start` | Start services based on deployment type | AWS, Container, Process, External |
| `stop` | Stop services based on deployment type | AWS, Container, Process, External |
| `restart` | Restart services based on deployment type | AWS, Container, Process, External |
| `check` | Health checks based on deployment type | AWS, Container, Process, External |
| `watch` | Monitor logs/metrics based on deployment type | AWS, Container, Process, External |

### Infrastructure & Configuration

| Command | Description | Deployment Types Supported |
|---------|-------------|--------------------------|
| `provision` | Create infrastructure based on deployment type | AWS, Container, Process, External |
| `configure` | Manage configuration based on deployment type | AWS, Container, Process, External |
| `backup` | Create backups based on deployment type | AWS, Container, Process, External |

### Development & Deployment

| Command | Description | Deployment Types Supported |
|---------|-------------|--------------------------|
| `publish` | Build and push images | AWS (to ECR), Container (local) |
| `update` | Update running services with latest code/images | AWS, Container, Process, External |
| `test` | Run tests based on deployment type | AWS, Container, Process, External |
| `exec` | Execute commands based on deployment type | AWS, Container, Process, External |

## Service-Command Matrix

This table shows the **actual implemented actions** each command takes for each service across different deployment types.

### Command Environment Requirements

| Command | Environment Required | Notes |
|---------|---------------------|-------|
| `init` | No | Uses dummy `_init_` default - doesn't need environment |
| `provision` | Yes | Creates infrastructure for specific environment |
| `start` | Yes | Starts services in specific environment |
| `stop` | Yes | Stops services in specific environment |
| `restart` | Yes | Restarts services in specific environment |
| `check` | Yes | Checks health in specific environment |
| `publish` | Yes | Builds and pushes images for environment |
| `update` | Yes | Updates services in specific environment |
| `configure` | Yes | Sets configuration for specific environment |
| `backup` | Yes | Creates backups for specific environment |
| `exec` | Yes | Executes commands in specific environment |
| `test` | Yes | Runs tests for specific environment |
| `watch` | Yes | Monitors services in specific environment |

### Core Service Operations

| Command | Service | AWS | Container | Process | External |
|---------|---------|-----|-----------|---------|----------|
| **start** | frontend | Start ECS service | Start container with image | Start npm/node process | Verify external endpoint |
| | backend | Start ECS service | Start container with image | Start npm/node process | Verify external endpoint |
| | database | Start RDS instance | Start postgres container | Start PostgreSQL service | Verify external connection |
| | filesystem | Mount EFS volumes | Create container volumes | Create local directories | Verify external mount |
| **stop** | frontend | Stop ECS tasks | Stop container | Kill process on port | Note external service |
| | backend | Stop ECS tasks | Stop container | Kill process on port | Note external service |
| | database | Stop RDS instance | Stop container | Stop PostgreSQL service | Note external service |
| | filesystem | Unmount EFS | Remove volumes | No action needed | Note external service |
| **restart** | frontend | Force ECS rolling update (zero downtime) | Stop + start container (picks up env changes) | Kill + restart process (picks up code/env) | Not applicable |
| | backend | Force ECS rolling update (zero downtime) | Stop + start container (picks up env changes) | Kill + restart process (picks up code/env) | Not applicable |
| | database | Not implemented (use AWS Console) | Stop + start container | Not implemented | Not applicable |
| | filesystem | Not implemented | Not applicable | Not applicable | Not applicable |

### Infrastructure & Configuration

| Command | Service | AWS | Container | Process | External |
|---------|---------|-----|-----------|---------|----------|
| **provision** | frontend | Create ECS service + ALB | Create container networks | Install dependencies | Validate external config |
| | backend | Create ECS service + ALB | Create container networks | Install dependencies | Validate external config |
| | database | Create RDS instance | Pull postgres image, create volume | Install PostgreSQL locally | Validate external connection |
| | filesystem | Create EFS mount | Create named volumes | Create local directories | Validate external paths |
| **configure** | frontend | Update ECS environment | Update container env vars | Update .env files | Note external config |
| | backend | Update ECS environment | Update container env vars | Update .env files | Note external config |
| | database | Update RDS parameters | Update container env vars | Update PostgreSQL config | Note external config |
| | filesystem | Configure EFS permissions | Set volume permissions | Set directory permissions | Note external access |

### Development & Deployment

#### Update vs Restart

The distinction between `update` and `restart` commands:

- **`restart`**: Restarts the service to pick up configuration/environment changes
  - AWS: Triggers ECS rolling update with `forceNewDeployment` (zero downtime)
  - Container: Stops and starts container with existing image
  - Process: Kills and restarts process
  - Purpose: Apply new secrets, environment variables, or configuration

- **`update`**: Deploys new code/images to the service
  - AWS: Deploys latest image from ECR (requires `publish` first)
  - Container: Restarts container (same as restart - no new image pull)
  - Process: Restarts dev server (picks up code changes via hot reload failure)
  - Purpose: Deploy new application version

For AWS deployments, both commands use the same ECS update mechanism but with different intent:
- `restart`: "Make the service reload its configuration"
- `update`: "Deploy the new version I just published"

| Command | Service | AWS | Container | Process | External |
|---------|---------|-----|-----------|---------|----------|
| **publish** | frontend | Build + push to ECR | Build and tag container image | N/A | N/A |
| | backend | Build + push to ECR | Build and tag container image | N/A | N/A |
| | database | N/A | N/A | N/A | N/A |
| | filesystem | N/A | N/A | N/A | N/A |
| **update** | frontend | Deploy new image from ECR (rolling update) | Stop + start with same local image | Kill + restart dev server | Not applicable |
| | backend | Deploy new image from ECR (rolling update) | Stop + start with same local image | Kill + restart dev server | Not applicable |
| | database | Not applicable (use AWS Console) | Stop + start container | Not applicable (manual update) | Not applicable |
| | filesystem | Not applicable | Not applicable | Not applicable | Not applicable |

### Monitoring & Testing

| Command | Service | AWS | Container | Process | External |
|---------|---------|-----|-----------|---------|----------|
| **check** | frontend | Query ECS service status | Check container health + HTTP | Check process on port + HTTP | HTTP health check |
| | backend | Query ECS service status | Check container health + HTTP | Check process on port + HTTP | HTTP health check |
| | database | Check RDS status | Check container health | Check PostgreSQL service | Test database connection |
| | filesystem | Check EFS mount status | Check volume mounts | Check directory access | Check external storage |
| **watch** | frontend | Stream CloudWatch logs | Stream container logs | Tail log files | Monitor external endpoint |
| | backend | Stream CloudWatch logs | Stream container logs | Tail log files | Monitor external endpoint |
| | database | Stream RDS logs | Stream container logs | Tail PostgreSQL logs | Monitor external database |
| | filesystem | Monitor CloudWatch metrics | Monitor volume usage | Monitor disk usage | Monitor external storage |
| **test** | frontend | AWS integration tests | Container-based tests | Local process tests | External API tests |
| | backend | AWS integration tests | Container-based tests | Local process tests | External API tests |
| | database | RDS connection tests | Container database tests | Local database tests | External database tests |
| | filesystem | EFS operation tests | Volume operation tests | File system tests | External storage tests |

### Operations & Maintenance

| Command | Service | AWS | Container | Process | External |
|---------|---------|-----|-----------|---------|----------|
| **init** | N/A | Create initial configuration files | Create initial configuration files | Create initial configuration files | Create initial configuration files |
| **exec** | frontend | ECS exec with AWS CLI | Exec into container | Spawn shell in app directory | Provide connection guidance |
| | backend | ECS exec with AWS CLI | Exec into container | Spawn shell in app directory | Provide connection guidance |
| | database | Cannot exec into RDS | Exec into postgres container | Direct psql connection | Provide connection guidance |
| | filesystem | Cannot exec into EFS | Access via container | Direct file access | Provide access guidance |
| **backup** | frontend | No backup needed | Application code archive | Application code archive | Note external backup |
| | backend | No backup needed | Application code archive | Application code archive | Note external backup |
| | database | Create RDS snapshot | Container database dump | Local pg_dump | Note external backup |
| | filesystem | EFS automatically backed up | Volume archive/snapshot | Local directory backup | Note external backup |

## Common Options

All commands support these common options:

- **Environment**: `<environment>` (positional) or `--environment <env>` - Target environment 
- **Service Selection**: `-s, --service <service>` - Target specific service(s) (default: "all")
- **Safety**: `--dry-run` - Preview changes without applying (comprehensive support)
- **Output**: `-v, --verbose` - Show detailed output and debug information
- **Help**: `-h, --help` - Show help for the command

### Dry-Run Support

All commands have comprehensive `--dry-run` support with two levels:

1. **Overview Level**: Shows which services would be affected
2. **Detail Level**: Shows specific actions that would be taken for each service

```bash
# Example dry-run output
$ semiont start production --dry-run
ℹ️  Starting services in production environment
ℹ️  [DRY RUN] Would start the following services:
  - frontend (aws)
  - backend (aws)  
  - database (aws)
  - filesystem (aws)
```

### Service Selection

Flexible service targeting:
- `all` - All services in the environment (default)
- `frontend` - Just the frontend service
- `backend` - Just the backend service
- `database` - Just the database service
- `filesystem` - Just the filesystem service
- Service combinations and patterns (future extension)

### Environment Agnostic

No special treatment of environment names:
- `local`, `development`, `staging`, `production` are all treated equally
- Behavior is determined by each service's **deployment type**, not environment name
- Same commands work across all environments with appropriate adaptations

## Development

### Building

```bash
cd packages/cli
npm run build
```

### Testing Commands

```bash
# Test commands with dry-run (safe)
semiont start -e local --dry-run --verbose
semiont provision -e staging --service backend --dry-run

# Test specific deployment types
semiont check -e local --service database --verbose  # Container deployment
semiont watch -e production --service frontend       # AWS deployment

# Use environment variables to avoid repetitive -e flags
export SEMIONT_ENV=staging
semiont start                    # Uses staging environment
semiont check                    # Uses staging environment
semiont start -e production      # Override with -e flag
```

## Contributing

### Development Setup Prerequisites
- Node.js 18+ with npm
- Docker or Podman for testing container commands
- AWS CLI for testing cloud deployments
- TypeScript knowledge required

### Code Style Guidelines

1. **Functional, side-effect free code is strongly preferred**
   - Write pure functions whenever possible
   - Avoid mutations and global state
   - Side effects should be isolated to command execution
2. **Deployment-Type Awareness** - Always use `switch (serviceInfo.deploymentType)` pattern
3. **Use Shared Utilities** - Import from `lib/` for colors, service resolution, container runtime
4. **Service Resolution** - Always use `resolveServiceDeployments()` for getting service info
5. **Comprehensive Dry-Run** - Support `--dry-run` at both command and service levels
6. **Consistent Error Handling** - Use shared color utilities and proper exit codes
7. **Type Everything** - Full TypeScript with Zod validation for all arguments
8. **Container-Runtime Agnostic** - Support both Docker and Podman via utilities
9. **No unnecessary comments** - Code should be self-documenting with clear names

📖 **For detailed instructions on adding new commands, see the [Adding Commands Guide](./ADDING_COMMANDS.md)**

### Testing Requirements
- All tests must pass before committing
- Run `npm test` to execute all tests
- Test both container and AWS deployment types where applicable
- New commands should include appropriate tests

### Type Checking and Linting
```bash
# Type check all code
npm run type-check

# Build (includes type checking)
npm run build

# Run tests
npm test
```

### PR Requirements
- Tests must pass (all test suites)
- TypeScript must compile without errors (strict mode)
- Follow functional programming principles
- Include tests for new commands
- Update service/command matrix if adding new commands
- Document environment requirements clearly

### Environment Configuration Notes
- Environment parameter is optional in command schemas but required at runtime
- The `init` command uses `_init_` as a dummy default (it doesn't need environment)
- No hidden 'local' defaults - environment must be explicit
- Use `requiresEnvironment(true)` in commands that need environment

## Troubleshooting

### Command not found

```bash
# Reinstall the CLI globally
cd apps/cli
npm link --force
```

### Environment not recognized

Ensure your environment configuration exists:
```bash
ls config/environments/*.json
```

### Permission errors

Some operations require appropriate AWS credentials:
```bash
aws configure
export AWS_PROFILE=your-profile
```

## Contributing

When adding new commands or modifying existing ones:

1. **Follow Deployment-Type Pattern** - Use the pattern described in "Adding a New Command"
2. **Update Service-Command Matrix** - Add your command's behavior per deployment type
3. **Comprehensive Dry-Run** - Implement dry-run support at both levels
4. **Test All Deployment Types** - Verify behavior with AWS, Container, Process, and External
5. **Update Documentation** - Add command to README and update examples
6. **Use Shared Utilities** - No duplication of colors, service resolution, container operations
7. **Container-Runtime Support** - Ensure Docker and Podman compatibility where applicable

### Testing Checklist

- ✅ `--dry-run` works and shows meaningful output
- ✅ All four deployment types handled appropriately  
- ✅ Service selection works (`all`, specific services)
- ✅ Error handling provides helpful messages
- ✅ Verbose mode provides useful debug info
- ✅ Command integrates with service resolution system
- ✅ No hardcoded service lists or environment assumptions

## Deployment Types Explained

### AWS (Managed Cloud)
Services running on AWS managed infrastructure:
- **Frontend/Backend**: ECS Fargate tasks with ALB
- **Database**: RDS PostgreSQL instances  
- **Filesystem**: EFS mount points
- **Operations**: Use AWS APIs and CLI tools

### Container (Local Containers)
Services running in local containers (Docker/Podman):
- **Frontend/Backend**: Application containers with port mapping
- **Database**: PostgreSQL containers with persistent volumes
- **Filesystem**: Named volumes or bind mounts
- **Operations**: Use container runtime commands

### Process (Local Development)
Services running as local processes:
- **Frontend/Backend**: Node.js processes (npm/pm2)
- **Database**: Local PostgreSQL installation
- **Filesystem**: Local directories with permissions
- **Operations**: Use system process management

### External (Third-Party)
Services managed outside of Semiont:
- **Frontend/Backend**: External hosting (Vercel, Heroku, etc.)
- **Database**: Managed databases (PlanetScale, Supabase, etc.)
- **Filesystem**: Cloud storage (S3, Google Drive, etc.)
- **Operations**: Provide guidance for external management

## License

Apache-2.0