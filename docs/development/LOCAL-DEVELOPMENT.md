# Local Development Guide

Local development is built around **[`./scripts/ci/local-build.sh`](../../scripts/ci/local-build.sh)**:
it builds your working tree into the real service images, and the launcher runs those. What you test
is what ships.

> The old workflow — a globally npm-installed CLI running `init`/`provision`/`start` against host
> processes — is gone. Nothing in this repo provides it.

## Prerequisites

- **Node.js 24+** — [nodejs.org](https://nodejs.org/)
- **A container engine** — [Apple Container](https://github.com/apple/container), Docker, or Podman
- **The `semiont` launcher** — `brew install the-ai-alliance/semiont/semiont`
- **A knowledge-base repo** to run against — see [KNOWLEDGE-BASES.md](../KNOWLEDGE-BASES.md)
  (`semiont-template-kb` is the canonical starting point)

## The loop

`local-build.sh` builds every package, publishes them to a throwaway local Verdaccio registry, and
builds all five service images tagged `:local` (never pushed). Images are loaded into every
responsive container engine on the machine, so the KB's `--runtime` choice is independent of which
engine built them.

```bash
# 1. From the monorepo — build packages and the five :local images
./scripts/ci/local-build.sh

# 2. From your KB — run the stack against them
cd /path/to/your-kb
SEMIONT_VERSION=local semiont start

# 3. Iterate — rebuild only what changed
./scripts/ci/local-build.sh --package backend --image backend

# 4. Done for the day
semiont stop
container rm -f semiont-verdaccio
```

`SEMIONT_VERSION=local` is what makes the launcher skip the registry pull and use your images.
Without it you get the published ones.

Full flag reference — `--package`, `--image`, `CONTAINER_RUNTIME`, what the Verdaccio step does — is
in **[scripts/ci/README.md](../../scripts/ci/README.md)**.

## Working on one package, without a stack

Most changes don't need a running stack:

```bash
npm ci --include=optional
npm run build:packages                  # all libraries, dependency-ordered
npm run typecheck                       # tsc --noEmit across workspaces
npm test --workspace=@semiont/sdk       # one workspace
```

See [TESTING.md](./TESTING.md) for per-workspace commands and the vitest watch-mode traps.

## Stack operations

Launcher verbs, run from the KB directory — see [apps/launcher](../../apps/launcher/README.md):

```bash
semiont status                    # container state + per-service health
semiont logs                      # follow service logs
semiont stop --service browser   # stop one service
```

## Service ports

| Service | Port | URL |
|---------|------|-----|
| Browser | 3000 | http://localhost:3000 |
| Backend | 4000 | http://localhost:4000 |
| PostgreSQL | 5432 | postgresql://localhost:5432 |
| Worker / Smelter / Weaver | 9090 / 9091 / 9092 | health endpoints |

## Database operations

Prisma is driven from the backend workspace:

```bash
cd apps/backend
npx prisma studio          # database browser
npx prisma migrate dev     # create + apply a migration
npx prisma generate        # regenerate the client
```

The backend container runs `npx prisma migrate deploy` itself at startup, so a fresh stack needs no
manual migration step.

## Additional Documentation

- **[scripts/ci/README.md](../../scripts/ci/README.md)** — `local-build.sh` in full
- **[TESTING.md](./TESTING.md)** — running tests, test commands
- **[CONTAINER-TOPOLOGY.md](../system/CONTAINER-TOPOLOGY.md)** — what runs where, and which layer runs it
- **[AUTHENTICATION.md](../system/administration/AUTHENTICATION.md)** — authentication setup, OAuth, admin users
- **[CONFIGURATION.md](../system/administration/CONFIGURATION.md)** — the `.semiont/semiontconfig/*.toml` schema
- **[TROUBLESHOOTING.md](../system/administration/TROUBLESHOOTING.md)** — common issues, port conflicts, database problems
- **[System Documentation](../system/README.md)** — architecture, component overview

## Getting Help

1. Check [TROUBLESHOOTING.md](../system/administration/TROUBLESHOOTING.md)
2. Search [GitHub Issues](https://github.com/The-AI-Alliance/semiont/issues)
3. Create a new issue with reproduction steps and error messages
