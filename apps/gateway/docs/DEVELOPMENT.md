# Gateway Local Development

Complete guide to local development for the Semiont gateway service.

**Related Documentation:**
- [Main README](../README.md) - Gateway overview
- [Semiont Protocol](../../../docs/protocol/README.md) - The eight verbs and the bus
- [Testing Guide](./TESTING.md) - Running tests
- [Deployment Guide](../../../docs/system/administration/DEPLOYMENT.md) - Deployment procedures

## Quick Start

### 🚀 Instant Setup with Semiont CLI (Recommended)

```bash
# From inside a knowledge-base repo — starts everything automatically!
semiont start

# This will:
# ✅ Start PostgreSQL, Neo4j, Qdrant, and Ollama containers
# ✅ Start gateway, worker, smelter, and weaver with the KB's config
# ✅ Ensure the Browser is running
# 🎉 Ready to develop in ~30 seconds!
```

**That's it!** Your complete development environment is running:
- **Browser**: http://localhost:3000
- **Gateway**: http://localhost:4000
- **Database**: PostgreSQL in Docker container

### 🛠 Manual Setup (Alternative)

```bash
# Install dependencies
npm install

# Start development server (with auto-restart on changes)
npm run dev

# Build for production (also run during the container image build)
npm run build
npm start
```

**Note on Building**: For local development, use `npm run dev` for auto-restart. Production builds happen in the `semiont-gateway` image build (`apps/gateway/Dockerfile`).

## Essential CLI Commands

```bash
# Full stack development
semiont start              # Start everything (infrastructure + the five services)
semiont stop               # Stop all services
semiont status              # Check service health

# Service-specific commands
semiont start --service database  # Start PostgreSQL container
semiont start --service gateway   # Start gateway (auto-starts database if needed)
semiont start --service browser  # Start the Browser only
semiont stop --service gateway    # Stop gateway service
semiont start --service gateway   # Restart gateway, leaving the rest of the stack up
```

## Why Use Semiont CLI?

- **🔄 Smart Dependencies**: The Browser auto-starts gateway, gateway auto-starts database
- **📦 Consistent Environment**: Everyone gets identical PostgreSQL setup
- **⚡ Zero Configuration**: No manual database setup, connection strings, or environment variables
- **🧹 Easy Reset**: Corrupted data? `--reset` gives you a fresh start
- **🎯 Focused Development**: Start only what you need
- **🐳 Container Runtime Flexibility**: Works with Apple Container, Docker, or Podman (auto-detected)

## Development Workflows

### First Time Setup

Run once:

```bash
brew install the-ai-alliance/semiont/semiont
cd /your/knowledge-base
semiont init --name "my-project"   # Writes .semiont/config + a semiontconfig
```

### Daily Development

Typical workflow:

```bash
# Start everything for full-stack development
semiont start

# Your services are now running! Develop normally...
# Browser: http://localhost:3000
# Gateway: http://localhost:4000
# Database: Managed automatically

# When done developing
semiont stop
```

### Restarting one service

```bash
semiont start --service gateway    # Rebuild-free restart of just the gateway
semiont start --service database   # Just PostgreSQL
```

`--service` takes one name: `gateway`, `worker`, `smelter`, `weaver`, `browser`,
`database`, `graph`, `vectors`, `inference`, `embedding`, or `traces`. The rest of the stack is
left untouched. Each service reads its own credential from the per-root state the full start
wrote, so a partial restart needs nothing recovered from the running stack.

### Browser against a mock API

The mock lives in the Browser's own dev server, not in the launcher:

```bash
cd apps/browser && npm run dev:mock
```

### Fresh start (reset the database)

```bash
semiont stop
semiont clean                      # Removes PostgreSQL, Qdrant, and Neo4j state
semiont clean --store database     # Or just PostgreSQL
semiont start
```

`stop` deliberately leaves persistent state so the next `start` reuses it;
`clean` is the only thing that removes it. Neither touches the event log, which
lives in the KB's git repo.

## Container Runtime Options

The launcher works with **Apple Container**, **Docker**, and **Podman**. By default
it uses the runtime a successful `start` last used (recorded per machine), falling
back to the first one found on `PATH`. Choose explicitly with `--runtime`:

```bash
semiont start --runtime podman
```

### Using Podman

For better security and performance, you can use Podman:

**Linux Setup (Recommended):**

```bash
# 1. Install Podman (if not already installed)
sudo apt install podman  # Ubuntu/Debian
sudo dnf install podman  # Fedora/RHEL

# 2. Enable rootless Podman socket
systemctl --user enable --now podman.socket

# 3. Set environment variables
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

# 4. Bring the stack up on Podman
semiont start --runtime podman
```

**macOS Setup:**

```bash
# 1. Install Podman via Homebrew
brew install podman

# 2. Initialize Podman machine
podman machine init
podman machine start

# 3. Configure environment
export DOCKER_HOST="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"

# 4. Bring the stack up on Podman
semiont start --runtime podman
```

**Benefits of Using Podman:**
- **Enhanced Security**: Rootless containers by default (no root daemon)
- **Better Performance**: No VM overhead on Linux systems
- **Lower Resource Usage**: More efficient than Docker Desktop
- **No Background Daemon**: Containers run without persistent daemon

The launcher is told which runtime to use by `--runtime`. The gateway's tests
need no container runtime of their own.

## Running a gateway by hand

The launcher is the normal way. Running the gateway outside it takes what the
launcher would give it — a built package, its configuration document, and three
secrets:

```bash
npm run build:packages            # at the repository root: the gateway needs core
npm run build -w semiont-gateway  # typecheck, then bundle to apps/gateway/dist
```

Write `~/.semiontconfig` — a JSON `GatewayConfig`
([schema](../../../specs/src/components/schemas/GatewayConfig.json)), resolved:
no `${VAR}` in it, nothing left to default. The
[README](../README.md#configuration) has an example. Then:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export SEMIONT_OIDC_CLIENT_ID=semiont-gateway
export SEMIONT_OIDC_CLIENT_SECRET=<the secret the realm registers for it>
node apps/gateway/dist/index.js
```

It refuses to start — before it listens — on a document that does not validate
(each failing field is named by its JSON pointer), on a missing or short
`JWT_SECRET`, on a missing service account, and on a broker it cannot reach or
that runs without JetStream.

### There is no gateway database

The gateway holds no database and issues no SQL. It reads every caller's
identity off their token, and the record lives in the Archivist. PostgreSQL
still runs in a Semiont stack, but it belongs to **Keycloak**; see
[Database](../../../docs/system/administration/DATABASE.md).

## Testing

The gateway's behavioural contract is the black-box
[conformance suite](../../../tests/gateway-conformance/README.md): it starts
gateway processes on both signal planes and checks them against `specs/`. See
[TESTING.md](./TESTING.md).

```bash
curl http://localhost:4000/api/health            # public
curl http://localhost:4000/api/openapi.json      # public: the contract
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/status
```

## Debugging

Set `logLevel` to `debug` in the configuration document to see every request,
authentication attempt and bus line; see [LOGGING.md](./LOGGING.md).

### "JWT_SECRET must be at least 32 characters long"

Each key must be at least 32 characters — the check is per key, since
`JWT_SECRET` may be a comma-separated rotation ring (the first key signs, every
key verifies). Generate one with `openssl rand -hex 32`.

### Does the gateway trust an issuer, and does it answer?

```bash
curl -s http://localhost:4000/.well-known/oauth-protected-resource
```

## Configuration

One document, `~/.semiontconfig` (a JSON `GatewayConfig`), which the launcher
writes resolved from the knowledge base's config and committed identity; see
the [README](../README.md#configuration). Beyond it, the gateway reads the
environment variables
[`specs/src/gateway-environment/variables.json`](../../../specs/src/gateway-environment/variables.json)
lists, each with what sets it and what it changes, and the broker credentials
the document names (`signal.userEnv`, `signal.passwordEnv`). For rotating the
signing key ring, see [Rotating `JWT_SECRET`](../../../docs/system/administration/AUTHENTICATION.md#rotating-jwt_secret-without-signing-everyone-out).

### Adding a configuration key

1. Add it to `GatewayConfig` in `specs/src/components/schemas/` and regenerate
   (`npm run generate:openapi --workspace=@semiont/core`; `go generate ./...`
   in `packages/sdk-go`).
2. Have the launcher write it (`apps/launcher/internal/launcher/gatewaydoc.go`).
3. Read it off the document at the call site — never from `process.env`.

An environment variable is a row in `variables.json` first:
`lint:gateway-environment` fails on a read the table does not list, on a row
nothing reads, and on a row no conformance case names.

## Related Documentation

- [Semiont Protocol](../../../docs/protocol/README.md) - The verbs and the bus
- [Authentication Guide](./AUTHENTICATION.md) - Tokens, agents, sign-in
- [Testing Guide](./TESTING.md) - The conformance suite
- [Deployment Guide](../../../docs/system/administration/DEPLOYMENT.md) - Production deployment procedures
