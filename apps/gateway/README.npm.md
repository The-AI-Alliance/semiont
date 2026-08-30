# @semiont/gateway

[![npm version](https://img.shields.io/npm/v/@semiont/gateway.svg)](https://www.npmjs.com/package/@semiont/gateway)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/gateway.svg)](https://www.npmjs.com/package/@semiont/gateway)
[![License](https://img.shields.io/npm/l/@semiont/gateway.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont gateway server for npm consumption. This package contains the compiled gateway application with Prisma schema and migrations.

## Running Semiont

Most people should **not** install this package directly. A Semiont stack is run with the `semiont`
launcher — a single static binary that pulls the published container images:

```bash
brew install the-ai-alliance/semiont/semiont

cd /path/to/your-knowledge-base
semiont start
```

This package is what the `semiont-gateway` container image runs inside.

## Direct usage

```bash
npm install @semiont/gateway

npx prisma migrate deploy --schema=node_modules/@semiont/gateway/prisma/schema.prisma
node node_modules/@semiont/gateway/dist/index.js
```

Requires in the environment:

- `SEMIONT_ROOT` — path to the knowledge-base working tree
- A config TOML readable at `~/.semiontconfig` — the container image mounts the
  KB's `.semiont/semiontconfig/<name>.toml` there; running the package directly
  means placing or symlinking one yourself. The environment block comes from its
  `[defaults] environment`.
- `DATABASE_URL` — Postgres connection string. The container image derives one
  from `services.database` in the config when this is unset; running the package
  directly has no such step, so set it yourself.
- `JWT_SECRET` — minimum 32 characters
- `SEMIONT_WORKER_SECRET` — for the software-agent token exchange

## What's included

- `dist/` — compiled gateway application (Hono server)
- `prisma/` — Prisma schema and migrations

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
