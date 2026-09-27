# @semiont/gateway

[![npm version](https://img.shields.io/npm/v/@semiont/gateway.svg)](https://www.npmjs.com/package/@semiont/gateway)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/gateway.svg)](https://www.npmjs.com/package/@semiont/gateway)
[![License](https://img.shields.io/npm/l/@semiont/gateway.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

Pre-built Semiont gateway server for npm consumption. This package contains the compiled gateway application. It holds no database and carries no schema or migrations.

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
node node_modules/@semiont/gateway/dist/index.js
```

It needs, at `~/.semiontconfig`, its configuration document — a JSON
`GatewayConfig` ([schema](https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/components/schemas/GatewayConfig.json)),
resolved: the knowledge base's committed name and did:web domain, the port and
public URL, the issuer, where the Archivist listens, and the signal plane. The
launcher writes it; running the package directly means writing one. And in the
environment:

- `JWT_SECRET` — minimum 32 characters (a comma-separated key ring during a
  rotation: the first key signs, every key verifies)
- `SEMIONT_OIDC_CLIENT_ID` / `SEMIONT_OIDC_CLIENT_SECRET` — the gateway's own service
  account at the knowledge base's issuer

## What's included

- `dist/` — compiled gateway application (Hono server)

## Links

- [Semiont GitHub](https://github.com/The-AI-Alliance/semiont)
- [Semiont launcher](https://github.com/The-AI-Alliance/semiont/tree/main/apps/launcher)
- [Documentation](https://github.com/The-AI-Alliance/semiont#readme)
