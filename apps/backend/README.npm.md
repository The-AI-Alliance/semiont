# @semiont/backend

[![npm version](https://img.shields.io/npm/v/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)
[![License](https://img.shields.io/npm/l/@semiont/backend.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont backend server for npm consumption. This package contains the compiled backend application with Prisma schema and migrations.

## Running Semiont

Most people should **not** install this package directly. A Semiont stack is run with the `semiont`
launcher — a single static binary that pulls the published container images:

```bash
brew install the-ai-alliance/semiont/semiont

cd /path/to/your-knowledge-base
semiont start
```

This package is what the `semiont-backend` container image runs inside.

## Direct usage

```bash
npm install @semiont/backend

npx prisma migrate deploy --schema=node_modules/@semiont/backend/prisma/schema.prisma
node node_modules/@semiont/backend/dist/index.js
```

Requires in the environment:

- `SEMIONT_ROOT` — path to the knowledge-base working tree
- `SEMIONT_ENV` — environment name in `~/.semiontconfig` (e.g. `local`)
- `DATABASE_URL` — or `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`
- `JWT_SECRET` — minimum 32 characters
- `SEMIONT_WORKER_SECRET` — for the software-agent token exchange

## What's included

- `dist/` — compiled backend application (Hono server)
- `prisma/` — Prisma schema and migrations

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
