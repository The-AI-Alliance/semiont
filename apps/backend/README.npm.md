# @semiont/backend

[![npm version](https://img.shields.io/npm/v/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/backend.svg)](https://www.npmjs.com/package/@semiont/backend)
[![License](https://img.shields.io/npm/l/@semiont/backend.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont backend server for npm consumption. This package contains the compiled backend application with Prisma schema and migrations.

## Installation

```bash
npm install -g @semiont/backend
```

This package is typically installed automatically by `semiont provision` when using the [Semiont CLI](https://www.npmjs.com/package/@semiont/cli).

## Usage

The recommended way to run Semiont is through the CLI:

```bash
npm install -g @semiont/cli
semiont init my-project
cd my-project
semiont provision
semiont start
```

The CLI handles configuration, database setup, and process management.

## Direct Usage

```bash
semiont-backend
# or
node node_modules/@semiont/backend/dist/index.js
```

Requires `DATABASE_URL` and other environment variables to be configured.

## What's Included

- `dist/` - Compiled backend application (Hono server)
- `prisma/` - Prisma schema and migrations

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont CLI](https://www.npmjs.com/package/@semiont/cli)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
