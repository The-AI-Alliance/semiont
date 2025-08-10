# Semiont CLI Setup

The Semiont CLI is now available as a standard npm package that can be installed globally.

## Installation

### For Development (Recommended)

1. Build the CLI:
```bash
cd packages/scripts
npm install
npm run build
```

2. Link the CLI globally:
```bash
npm link
```

This creates a global `semiont` command linked to your development version.

### For Production Users

```bash
npm install -g @semiont/scripts
```

## Usage

Once installed, the `semiont` command is available globally:

```bash
# Start services
semiont start -e local
semiont start -e production --service backend

# Stop services  
semiont stop -e local
semiont stop -e staging --service frontend

# Check health
semiont check -e local
semiont check -e production --section services

# Restart services
semiont restart -e local --grace-period 5
```

## Environment Variables

- `SEMIONT_ENV`: Default environment (local, development, staging, production)
  ```bash
  export SEMIONT_ENV=staging
  semiont start  # Uses staging environment
  ```

- `SEMIONT_ROOT`: Project root directory (optional, defaults to current directory)
  ```bash
  export SEMIONT_ROOT=/path/to/semiont/project
  ```

## Commands

Run `semiont --help` to see all available commands:

- `start` - Start services in any environment
- `stop` - Stop services in any environment  
- `restart` - Restart services in any environment
- `check` - Check system health and status
- `test` - Run automated tests
- `deploy` - Deploy application code and configuration
- `provision` - Create cloud infrastructure (one-time)
- `watch` - Monitor logs and system metrics

## Command Help

Get help for any command:
```bash
semiont start --help
semiont deploy --help
```

## Uninstalling

To uninstall the global CLI:

```bash
# If installed via npm link
cd packages/scripts
npm unlink

# If installed via npm install -g
npm uninstall -g @semiont/scripts
```

## Migration from Bash Scripts

The new TypeScript CLI replaces the bash scripts in `/bin`. The old scripts are deprecated:

- `./bin/semiont` → `semiont` (global command)
- `./bin/semiont-v2` → `semiont` (same global command)

All functionality is now unified in a single `semiont` command.