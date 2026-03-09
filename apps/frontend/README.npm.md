# @semiont/frontend

[![npm version](https://img.shields.io/npm/v/@semiont/frontend.svg)](https://www.npmjs.com/package/@semiont/frontend)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/frontend.svg)](https://www.npmjs.com/package/@semiont/frontend)
[![License](https://img.shields.io/npm/l/@semiont/frontend.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont frontend server as a Next.js standalone output. This package contains the compiled frontend application ready to run with Node.js.

## Installation

```bash
npm install -g @semiont/frontend
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

The CLI handles configuration, environment setup, and process management.

## Direct Usage

```bash
semiont-frontend
# or
node node_modules/@semiont/frontend/standalone/apps/frontend/server.js
```

Requires environment variables (`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `SERVER_API_URL`, etc.) to be configured.

## What's Included

- `standalone/` - Next.js standalone output with all dependencies bundled

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont CLI](https://www.npmjs.com/package/@semiont/cli)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
