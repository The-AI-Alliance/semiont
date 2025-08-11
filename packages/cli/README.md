# Semiont CLI

The unified command-line interface for managing Semiont environments and services.

## Overview

The Semiont CLI provides a consistent interface for:
- Environment provisioning (local containers, AWS infrastructure)
- Service management (start, stop, restart)
- Deployment and configuration
- Health monitoring and diagnostics
- Database backups and maintenance

## Installation

```bash
# From project root
npm run install              # Full installation (all packages + CLI)
npm run install -- --cli-only   # CLI only installation

# After installation, the 'semiont' command is available globally
semiont --help
```

## Architecture

### Directory Structure

```
packages/cli/
├── cli.ts                    # Main entry point & command registry
├── commands/                 # Command implementations
│   ├── start.ts
│   ├── stop.ts
│   ├── provision.ts
│   ├── check.ts
│   └── ...
└── lib/                      # Shared utilities
    ├── cli-colors.ts         # Color definitions
    ├── cli-logger.ts         # Logging utilities
    ├── cli-paths.ts          # Path resolution
    ├── argument-parser.ts    # Argument parsing
    ├── schema-transforms.ts  # Schema transformations
    └── base-command.ts       # Base command class
```

### Key Design Patterns

1. **Centralized Schema Management** - All command schemas defined in `cli.ts`
2. **Shared Utilities** - Common functionality in `lib/` to avoid duplication
3. **Consistent Error Handling** - Via `CliLogger` and base patterns
4. **Type Safety** - Full Zod validation for all arguments
5. **Environment Agnostic** - No special treatment of environment names

## Adding a New Command

Follow this pattern when adding new commands to maintain consistency:

### 1. Define the Argument Schema (cli.ts)

```typescript
// In cli.ts - Define how arguments are parsed from CLI
const MyCommandArgsSchema = CommonArgsSchema.extend({
  '--my-option': z.string().optional(),
  '--count': z.number().int().positive().optional(),
  '--force': z.boolean().optional(),
  '-f': z.literal('--force').optional(),
});
```

### 2. Define the Command Schema (lib/schema-transforms.ts)

```typescript
// In lib/schema-transforms.ts - Define clean property names for the command
export const MyCommandSchema = BaseCommandSchema.extend({
  myOption: z.string().optional(),
  count: z.number().int().positive().default(1),
  force: z.boolean().default(false),
});
```

### 3. Register the Command (cli.ts)

```typescript
// In cli.ts - Add to COMMANDS registry
const COMMANDS: Record<string, CommandDefinition> = {
  // ... existing commands ...
  mycommand: {
    description: 'My new command description',
    schema: MyCommandArgsSchema,
    handler: 'commands/mycommand.mjs',
    requiresEnvironment: true,  // If --environment is required
    examples: [
      'semiont mycommand -e local',
      'semiont mycommand -e production --my-option value --force',
    ],
  },
};
```

### 4. Implement the Command (commands/mycommand.ts)

```typescript
/**
 * MyCommand - Description of what this command does
 */

import { z } from 'zod';
import { getProjectRoot } from '../lib/cli-paths.js';
import { CliLogger, printError, printSuccess } from '../lib/cli-logger.js';
import { MyCommandSchema, transformCliArgs } from '../lib/schema-transforms.js';
import { colors } from '../lib/cli-colors.js';

type MyCommandOptions = z.infer<typeof MyCommandSchema>;

function parseArguments(): MyCommandOptions {
  // Get base arguments from environment variables (set by main CLI)
  const rawOptions: any = {
    '--environment': process.env.SEMIONT_ENV,
    '--verbose': process.env.SEMIONT_VERBOSE === '1',
    '--dry-run': process.env.SEMIONT_DRY_RUN === '1',
  };

  // Parse additional command-specific arguments from argv
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--my-option':
        rawOptions['--my-option'] = args[++i];
        break;
      case '--count':
        rawOptions['--count'] = parseInt(args[++i]);
        break;
      case '--force':
      case '-f':
        rawOptions['--force'] = true;
        break;
    }
  }

  // Transform CLI args to clean property names and validate
  const transformed = transformCliArgs(rawOptions);
  return MyCommandSchema.parse(transformed);
}

async function main(): Promise<void> {
  const options = parseArguments();
  const logger = new CliLogger(options.verbose);
  
  logger.info(`🚀 Starting MyCommand for ${options.environment}`);
  logger.debug(`Options: ${JSON.stringify(options)}`);
  
  try {
    // Validate environment if needed
    if (!options.environment) {
      throw new Error('--environment is required');
    }
    
    // Implement your command logic here
    if (options.dryRun) {
      logger.info('[DRY RUN] Would execute command with:');
      logger.info(`  Option: ${options.myOption}`);
      logger.info(`  Count: ${options.count}`);
      logger.info(`  Force: ${options.force}`);
      return;
    }
    
    // Actual implementation
    // ...
    
    logger.success('Command completed successfully');
    
  } catch (error) {
    logger.error(`Command failed: ${error}`);
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

export { main };
export type { MyCommandOptions };
```

### 5. Update Argument Parsing (cli.ts)

Add command-specific argument parsing to the `parseArguments` function:

```typescript
// In cli.ts parseArguments()
...(command === 'mycommand' ? {
  '--my-option': String,
  '--count': Number,
  '--force': Boolean,
  '-f': '--force',
} : {}),
```

## Command Reference

### Environment Management

| Command | Description | Required Flags |
|---------|-------------|----------------|
| `provision` | Create infrastructure (containers or cloud) | `-e` |
| `start` | Start services | `-e` |
| `stop` | Stop services | `-e` |
| `restart` | Restart services | `-e` |
| `check` | Check system health | `-e` |
| `watch` | Monitor logs and metrics | `-e` |

### Deployment & Configuration

| Command | Description | Required Flags |
|---------|-------------|----------------|
| `deploy` | Deploy application code | `-e` |
| `configure` | Manage secrets and configuration | `-e` |
| `backup` | Create database backups | `-e` |

### Operations

| Command | Description | Required Flags |
|---------|-------------|----------------|
| `exec` | Execute commands in containers | `-e` |
| `test` | Run test suites | `-e` |

## Service-Command Matrix

This table shows what actions each command takes for each service across different deployment types:

| Command | Service | AWS ECS | Container | Process | External |
|---------|---------|---------|-----------|---------|----------|
| **provision** | frontend | Create ECS service + ALB | Create container network | Install dependencies | Configure external endpoint |
| | backend | Create ECS service + ALB | Create container | Install dependencies | Configure external endpoint |
| | database | Create RDS instance | Create PostgreSQL container | Install PostgreSQL locally | Use external database |
| | filesystem | Create EFS mount | Create container volumes | Create local directories | Use external storage |
| **configure** | frontend | Update ECS environment vars | Update container env file | Update .env file | Update external config |
| | backend | Update ECS environment vars | Update container env file | Update .env file | Update external config |
| | database | Update RDS parameters | Update container env vars | Update local config | Update external config |
| | filesystem | Configure EFS permissions | Set volume permissions | Set directory permissions | Configure external access |
| **publish** | frontend | Build + push to ECR | Build container image | N/A (no build needed) | N/A |
| | backend | Build + push to ECR | Build container image | N/A (no build needed) | N/A |
| | database | N/A | N/A | N/A | N/A |
| | filesystem | N/A | N/A | N/A | N/A |
| **start** | frontend | Start ECS service | Start container | Start process (npm/pm2) | Check external service |
| | backend | Start ECS service | Start container | Start process (npm/pm2) | Check external service |
| | database | Start RDS instance | Start container | Start PostgreSQL service | Check external connection |
| | filesystem | Mount EFS volumes | Mount container volumes | Create directories | Check external mount |
| **check** | frontend | Query ECS service status | Check container health | Check process status | HTTP health check |
| | backend | Query ECS service status | Check container health | Check process status | HTTP health check |
| | database | Check RDS status | Check container health | Check service status | Test connection |
| | filesystem | Check EFS mount status | Check volume mounts | Check directory access | Check external storage |
| **watch** | frontend | Stream CloudWatch logs | Stream container logs | Tail log files | Monitor external logs |
| | backend | Stream CloudWatch logs | Stream container logs | Tail log files | Monitor external logs |
| | database | Stream RDS logs | Stream container logs | Tail PostgreSQL logs | Monitor external logs |
| | filesystem | Monitor CloudWatch metrics | Monitor volume usage | Monitor disk usage | Monitor external storage |
| **test** | frontend | Run tests against ECS | Run tests in container | Run local tests | Run tests against external |
| | backend | Run tests against ECS | Run tests in container | Run local tests | Run tests against external |
| | database | Test RDS connections | Test container DB | Test local DB | Test external DB |
| | filesystem | Test EFS operations | Test volume operations | Test file operations | Test external storage |
| **update** | frontend | Update ECS service | Update container image | Restart process | Update external service |
| | backend | Update ECS service | Update container image | Restart process | Update external service |
| | database | Apply RDS updates | Update container | Update local install | Update external database |
| | filesystem | Update EFS configuration | Update volume config | Update permissions | Update external config |
| **restart** | frontend | Restart ECS tasks | Restart container | Restart process | Restart external service |
| | backend | Restart ECS tasks | Restart container | Restart process | Restart external service |
| | database | Restart RDS instance | Restart container | Restart PostgreSQL | Restart external database |
| | filesystem | Remount EFS | Remount volumes | No action needed | Remount external storage |
| **stop** | frontend | Stop ECS service | Stop container | Stop process | Stop external service |
| | backend | Stop ECS service | Stop container | Stop process | Stop external service |
| | database | Stop RDS instance | Stop container | Stop PostgreSQL | Stop external database |
| | filesystem | Unmount EFS | Remove volumes | No action needed | Unmount external storage |
| **exec** | frontend | ECS exec into task | Exec into container | N/A (direct access) | SSH to external service |
| | backend | ECS exec into task | Exec into container | N/A (direct access) | SSH to external service |
| | database | RDS session manager | Exec into container | psql direct connection | Connect to external DB |
| | filesystem | N/A | Access via container | Direct file access | Mount external storage |
| **backup** | frontend | N/A | N/A | N/A | N/A |
| | backend | N/A | N/A | N/A | N/A |
| | database | Create RDS snapshot | Export container data | pg_dump to file | Backup external database |
| | filesystem | Create EFS backup | Create volume snapshot | rsync/tar backup | Backup external storage |

## Common Options

All commands support these common options:

- `-e, --environment <env>` - Target environment (local, development, staging, production)
- `-v, --verbose` - Show detailed output
- `--dry-run` - Preview changes without applying
- `-h, --help` - Show help for the command

## Development

### Building

```bash
cd packages/cli
npm run build
```

### Testing

```bash
# Test a command locally
node dist/cli.mjs start -e local --verbose

# Test with environment variables
SEMIONT_ENV=local SEMIONT_VERBOSE=1 node dist/commands/check.mjs
```

### Code Style Guidelines

1. **Use shared utilities** - Don't duplicate color definitions, logging, or path resolution
2. **Follow schema patterns** - Define in registry, transform for commands
3. **Consistent error handling** - Use CliLogger for all output
4. **Type everything** - Full TypeScript with Zod validation
5. **Document commands** - Clear descriptions and examples

## Troubleshooting

### Command not found

```bash
# Reinstall the CLI globally
cd packages/cli
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

1. Follow the pattern described in "Adding a New Command"
2. Update this README with command documentation
3. Add examples to the command registry
4. Test locally before committing
5. Ensure all shared utilities are used (no duplication)

## License

Apache-2.0