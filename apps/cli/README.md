# Semiont CLI

The unified command-line interface for managing Semiont environments and services with platform-aware operations.

## Overview

The Semiont CLI provides a consistent interface for managing services across different environments and platforms through five core concepts:

### Core Concepts

1. **Environment** - The primary configuration context (dev, staging, production)
2. **Service** - Business entities managed by the CLI (backend, frontend, database)
3. **Service Type** - Platform-specific categorizations (web, worker, lambda, ecs)
4. **Command** - Operations you can perform (start, stop, check, deploy)
5. **Platform** - Infrastructure targets (posix, container, aws, external)

### Key Capabilities

- **Environment-Driven Configuration**: All operations require an environment context
- **Service Management**: start, stop, restart, check services based on environment
- **Infrastructure Operations**: provision, configure, backup across platforms
- **Development Workflows**: publish, update, test with platform awareness
- **Safety Features**: comprehensive `--dry-run` support for all operations

## Quick Links

- [**Architecture Overview**](./docs/ARCHITECTURE.md) - Understanding the CLI architecture and core concepts
- [**Managing Environments**](./docs/ADDING_ENVIRONMENTS.md) - Guide for configuring and managing environments
- [**Adding New Commands**](./docs/ADDING_COMMANDS.md) - Step-by-step guide for adding new CLI commands
- [**Adding New Platforms**](./docs/ADDING_PLATFORMS.md) - Guide for implementing new platform strategies
- [**Adding New Services**](./docs/ADDING_SERVICES.md) - Guide for adding new service types

## Installation

```bash
# From the CLI directory
cd apps/cli
npm run build               # Build the CLI
npm link                    # Install globally

# After installation, the 'semiont' command is available globally
semiont --help
```

## Common Options

All commands support these common options:

- **Environment** (required): `--environment <env>` or via `SEMIONT_ENV` - Target environment
- **Service Selection**: `-s, --service <service>` - Target specific service(s) (default: "all")
- **Safety**: `--dry-run` - Preview changes without applying (comprehensive support)
- **Output**: `-v, --verbose` - Show detailed output and debug information
- **Help**: `-h, --help` - Show help for the command

### Environment Configuration (Required)

Every command requires an environment to be specified:

```bash
# Via command-line flag (highest priority)
semiont start backend --environment production

# Via environment variable
export SEMIONT_ENV=staging
semiont start backend

# Error if neither is provided
semiont start backend
# Error: Environment is required. Specify --environment flag or set SEMIONT_ENV
```

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

### Environment-Driven Architecture

Environments are the foundation of configuration:
- **Define which services exist** in each deployment context
- **Specify platform assignments** for each service (posix, container, aws)
- **Configure service settings** (ports, environment variables, resources)
- **No special environment names** - all environments are treated equally
- **Required for all operations** via `--environment` or `SEMIONT_ENV`

## Architecture

The CLI follows a unified architecture built on five core concepts:

```
Environment (configuration context)
    ↓ defines
Services (what exists)
    ↓ assigns to
Platforms (where they run)
    ↓ categorized as
Service Types (how they're handled)
    ↓ operated via
Commands (what you can do)
```

See [Architecture Overview](./docs/ARCHITECTURE.md) for detailed information.

### Directory Structure

```
environments/                 # Environment configurations (primary config)
├── dev.json                 # Development environment
├── staging.json             # Staging environment
└── production.json          # Production environment

src/
├── cli.ts                    # CLI entry point
├── core/                     # Core execution engine
│   ├── unified-executor.ts  # Unified command execution
│   ├── command-descriptor.ts # Command configuration
│   ├── command-result.ts    # Unified result type
│   └── handlers/            # Handler management
│       ├── registry.ts      # Handler registration
│       └── types.ts         # Handler types
├── commands/                 # Command implementations
│   ├── start.ts             # Start services
│   ├── stop.ts              # Stop services
│   ├── check.ts             # Health checks
│   └── ...                  # Other commands
├── services/                 # Service definitions
│   ├── service-interface.ts # Service contracts
│   ├── base-service.ts      # Base service class
│   └── ...                  # Service implementations
├── platforms/                # Platform implementations
│   ├── posix/handlers/      # POSIX system handlers
│   ├── container/handlers/  # Docker/Podman handlers
│   ├── aws/handlers/        # AWS service handlers
│   └── ...                  # Other platforms
├── lib/                      # Shared utilities
└── docs/                     # Documentation
    ├── ARCHITECTURE.md       # Architecture & concepts
    ├── ADDING_ENVIRONMENTS.md # Environment guide
    ├── ADDING_COMMANDS.md    # Commands guide
    ├── ADDING_PLATFORMS.md   # Platforms guide
    └── ADDING_SERVICES.md    # Services guide
```

### Environment Configuration

Environments are JSON files that define:
- Which services exist
- Platform assignments for each service
- Service-specific configuration
- Platform settings (AWS regions, Docker registries, etc.)

#### Example Environment File (environments/staging.json)

```json
{
  "platform": {
    "default": "container"
  },
  "services": {
    "backend": {
      "platform": "container",
      "image": "myorg/backend:staging",
      "port": 3000,
      "env": {
        "NODE_ENV": "staging"
      }
    },
    "database": {
      "platform": "aws",
      "serviceType": "rds",
      "instanceClass": "db.t3.medium"
    }
  }
}
```

#### Environment Resolution

The CLI determines the environment using:

1. **Command-line flag** (`--environment`) - highest priority
2. **Environment variable** (`SEMIONT_ENV`) - fallback
3. **Error** - if neither is provided

```bash
# Via flag
semiont start backend --environment production

# Via environment variable
export SEMIONT_ENV=staging
semiont start backend

# Error if neither
semiont start backend
# Error: Environment is required
```

## Platform Support

Platforms are determined by environment configuration, not hardcoded:

- **POSIX** (`posix`): Services running as local OS processes
- **Container** (`container`): Services in Docker/Podman containers  
- **AWS** (`aws`): Services on AWS with various service types:
  - ECS (Fargate containers)
  - Lambda (serverless functions)
  - RDS (managed databases)
  - S3/CloudFront (static hosting)
- **External** (`external`): Third-party or existing services
- **Mock** (`mock`): Simulated services for testing

Each service's platform is specified in the environment configuration file.

## Key Design Principles

1. **Environment-First Configuration** - All configuration flows from environment files
2. **Unified Execution Pattern** - All commands use UnifiedExecutor for consistency
3. **Handler-Based Architecture** - Platform-specific logic in self-contained handlers
4. **Service Requirements Pattern** - Services declare needs, platforms provide resources
5. **Comprehensive Dry-Run Support** - All commands support `--dry-run` with detailed previews
6. **Type Safety** - Full TypeScript and Zod validation throughout
7. **No Special Environment Names** - All environments treated equally
8. **Extensible Architecture** - Easy to add new services, platforms, handlers, and commands

## Command Overview

All commands follow a consistent pattern and support common options like `--dry-run`, `--verbose`, and service selection. Commands automatically adapt their behavior based on the platform configuration of each service.

For detailed instructions on adding new commands, see the [Adding Commands Guide](./docs/ADDING_COMMANDS.md).

### Available Commands

**Service Management**
- `start` - Start services
- `stop` - Stop services  
- `restart` - Restart services
- `check` - Health check services
- `watch` - Monitor services with live dashboard

**Infrastructure & Configuration**
- `provision` - Provision infrastructure resources
- `configure` - Manage configuration and secrets
- `backup` - Create service backups
- `restore` - Restore from backups

**Development & Deployment**  
- `publish` - Build and publish artifacts
- `update` - Update running services
- `test` - Run test suites
- `exec` - Execute commands in service context
- `init` - Initialize new Semiont project

Each command automatically detects the platform for each service and executes the appropriate implementation. See the documentation links above for detailed guides on extending the CLI.

## MCP (Model Context Protocol) Server

The Semiont CLI includes built-in support for MCP, allowing AI assistants to interact with Semiont APIs.

### MCP Setup

MCP requires one-time OAuth provisioning per environment:

```bash
# Provision MCP for production environment
semiont provision --service mcp --environment production

# This will:
# 1. Open your browser for OAuth authentication
# 2. Store refresh token in ~/.config/semiont/mcp-auth-production.json
# 3. Display AI application configuration
```

### Starting MCP Server

After provisioning, the MCP server can be started:

```bash
# Start MCP server for production
semiont start --service mcp --environment production

# Or with environment variable
SEMIONT_ENV=production semiont start --service mcp
```

### AI Application Configuration

After provisioning, add this configuration to your AI application:

```json
{
  "semiont": {
    "command": "semiont",
    "args": ["start", "--service", "mcp"],
    "env": {
      "SEMIONT_ROOT": "/path/to/semiont",
      "SEMIONT_ENV": "production"
    }
  }
}
```

### Available MCP Tools

The MCP server currently provides:
- `semiont_hello` - Get a personalized greeting from Semiont API

Future capabilities will include graph retrieval for GraphRAG-like systems.

### Authentication Flow

1. **Initial Setup**: Browser-based OAuth during `provision` command
2. **Refresh Tokens**: Stored locally, valid for 30 days
3. **Access Tokens**: Automatically refreshed on startup, valid for 1 hour
4. **Unattended Operation**: No user interaction required after initial setup

### Troubleshooting MCP

- **Authentication Failed**: Re-run `semiont provision --service mcp --environment <env>`
- **Token Expired**: Refresh tokens expire after 30 days, re-provision if needed
- **Server Won't Start**: Check that the environment was provisioned first

## Development

### Building

```bash
npm run build        # Build the CLI
npm run watch        # Watch mode for development
npm test            # Run tests
```

### Testing

The CLI has comprehensive test coverage:

```bash
npm test                    # Run all tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests
npm run test:coverage      # Generate coverage report
```

### Code Style

The project uses ESLint and Prettier:

```bash
npm run lint        # Check code style
npm run lint:fix    # Auto-fix issues
npm run format      # Format code with Prettier
```

## Troubleshooting

### Common Issues

**Service won't start**
- Check if port is already in use: `lsof -i :PORT`
- Verify environment configuration exists
- Check service logs with `semiont watch`

**AWS commands fail**
- Ensure AWS credentials are configured: `aws configure`
- Check AWS region matches environment config
- Verify IAM permissions for ECS/RDS operations

**Container commands fail**
- Verify Docker/Podman is installed and running
- Check container runtime detection: `docker version` or `podman version`
- Ensure user has permissions for container operations

**MCP server issues**
- Re-provision if authentication fails
- Check refresh token hasn't expired (30 days)
- Verify environment was provisioned before starting

## Contributing

We welcome contributions! Please see our contributing guidelines for:

- Code style and standards
- Testing requirements
- Documentation updates
- Pull request process

### Adding New Features

1. **Environments**: See [Managing Environments Guide](./docs/ADDING_ENVIRONMENTS.md)
2. **Commands**: See [Adding Commands Guide](./docs/ADDING_COMMANDS.md)
3. **Services**: See [Adding Services Guide](./docs/ADDING_SERVICES.md)
4. **Platforms**: See [Adding Platforms Guide](./docs/ADDING_PLATFORMS.md)

### Development Workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a pull request

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.