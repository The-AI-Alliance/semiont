# POSIX Platform

Local development platform for running services as native OS processes.

## Overview

The POSIX platform runs services directly on your local machine as operating system processes using Node.js `child_process.spawn` ([backend-start.ts:1](../../apps/cli/src/platforms/posix/handlers/backend-start.ts#L1)). This is used for local development.

**Platform Type**: `posix`

**Use Cases**:
- Local development
- Testing and debugging

## Configuration

Services configured with `platform.type: "posix"` in environment files.

**Example from** [local.json](../../apps/cli/templates/environments/local.json):

```json
{
  "backend": {
    "platform": {
      "type": "posix"
    },
    "command": "npm run dev",
    "port": 4000
  },
  "frontend": {
    "platform": {
      "type": "posix"
    },
    "command": "npm run dev",
    "port": 3000
  }
}
```

## Supported Services

Based on [local.json](../../apps/cli/templates/environments/local.json):
- **backend** - API server
- **frontend** - Next.js app
- **mcp** - Model Context Protocol server
- **filesystem** - File storage

## Implementation

**Handlers**: [apps/cli/src/platforms/posix/handlers/](../../apps/cli/src/platforms/posix/handlers/)

Service-specific handlers (not generic):
- [backend-start.ts](../../apps/cli/src/platforms/posix/handlers/backend-start.ts) - Start backend
- [backend-stop.ts](../../apps/cli/src/platforms/posix/handlers/backend-stop.ts) - Stop backend
- [frontend-start.ts](../../apps/cli/src/platforms/posix/handlers/frontend-start.ts) - Start frontend
- [mcp-start.ts](../../apps/cli/src/platforms/posix/handlers/mcp-start.ts) - Start MCP server

## Process Management

### PID Files

Process IDs stored per service ([backend-start.ts:40](../../apps/cli/src/platforms/posix/handlers/backend-start.ts#L40)):

```
{projectRoot}/backend/.pid
{projectRoot}/frontend/.pid
```

**Not** in `.semiont/pids/` directory.

## Related Documentation

- [CLI Platform Implementation](../../apps/cli/src/platforms/posix/) - POSIX handlers source code
- [Adding Platforms Guide](../../apps/cli/docs/ADDING_PLATFORMS.md) - How to extend platform support
- [Container Platform](./Container.md) - Container-based alternative
- [AWS Platform](./AWS.md) - Production deployment
