# Semiont CLI

The unified command-line interface for managing Semiont environments and services with platform-aware operations.

## Overview

The Semiont CLI provides a consistent interface for:
- **Service Management**: start, stop, restart, check, watch services based on platform
- **Infrastructure Operations**: provision, configure, backup services across platforms
- **Development Workflows**: publish, update, test, exec commands with platform awareness
- **Safety Features**: comprehensive `--dry-run` support for all operations
- **Environment Agnostic**: no special treatment of "local" vs "cloud" environments

## Quick Links

- [**Architecture Overview**](./docs/ARCHITECTURE.md) - Understanding the CLI architecture and design patterns
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
- Behavior is determined by each service's **platform**, not environment name
- Same commands work across all environments with appropriate adaptations

## Architecture

The CLI follows a layered architecture separating commands, services, platforms, and utilities. See [Architecture Overview](./docs/ARCHITECTURE.md) for detailed information.

### Directory Structure

```
src/
├── cli.ts                    # CLI entry point
├── commands/                 # Command implementations
│   ├── start.ts             # Start services
│   ├── stop.ts              # Stop services
│   ├── check.ts             # Health checks
│   ├── backup.ts            # Backup operations
│   └── ...                  # Other commands
├── services/                 # Service definitions
│   ├── service-interface.ts # Service contracts
│   ├── base-service.ts      # Base service class
│   ├── backend-service.ts   # Backend service
│   ├── frontend-service.ts  # Frontend service
│   └── ...                  # Other services
├── platforms/                # Platform strategies
│   ├── platform-strategy.ts # Platform interface
│   ├── process-platform.ts  # Local process platform
│   ├── container-platform.ts # Docker/Podman platform
│   ├── aws-platform.ts      # AWS ECS platform
│   └── ...                  # Other platforms
├── lib/                      # Shared utilities
│   ├── cli-colors.ts        # Color definitions
│   ├── cli-logger.ts        # Logging utilities
│   ├── validators.ts        # Input validation
│   └── ...                  # Other utilities
├── dashboard/                # Dashboard components
│   ├── dashboard-data.ts    # Data collection
│   └── dashboard-layouts.tsx # UI layouts
└── docs/                     # Documentation
    ├── ARCHITECTURE.md       # Architecture overview
    ├── ADDING_COMMANDS.md    # Adding commands guide
    ├── ADDING_PLATFORMS.md   # Adding platforms guide
    └── ADDING_SERVICES.md    # Adding services guide
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

## Platform Support

The CLI adapts its behavior based on each service's configured platform:

- **Process**: Services running as local OS processes (development)
- **Container**: Services in Docker/Podman containers  
- **AWS**: Services on AWS (ECS, RDS, EFS, Lambda)
- **External**: Third-party or existing services
- **Mock**: Simulated services for testing

## Key Design Principles

1. **Platform-Aware Operations** - Commands adapt behavior based on service platform
2. **Service Requirements Pattern** - Services declare what they need, platforms provide it
3. **Comprehensive Dry-Run Support** - All commands support `--dry-run` with detailed previews
4. **Type Safety** - Full TypeScript and Zod validation throughout
5. **Environment Agnostic** - No special treatment of environment names
6. **Extensible Architecture** - Easy to add new services, platforms, and commands

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

1. **Commands**: See [Adding Commands Guide](./docs/ADDING_COMMANDS.md)
2. **Services**: See [Adding Services Guide](./docs/ADDING_SERVICES.md)
3. **Platforms**: See [Adding Platforms Guide](./docs/ADDING_PLATFORMS.md)

### Development Workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a pull request

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.