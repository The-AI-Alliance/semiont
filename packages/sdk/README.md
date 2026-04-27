# @semiont/sdk

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+sdk%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=sdk)
[![npm version](https://img.shields.io/npm/v/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/sdk.svg)](https://www.npmjs.com/package/@semiont/sdk)
[![License](https://img.shields.io/npm/l/@semiont/sdk.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The developer-facing SDK for [Semiont](https://github.com/The-AI-Alliance/semiont). This package owns the high-level surface every Semiont consumer reaches for: a verb-oriented `SemiontClient`, per-KB sessions, RxJS view-models, and the helpers that wire them all together.

The SDK is **transport-agnostic** — it consumes the `ITransport` and `IContentTransport` contracts from [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core). For HTTP, the canonical wire adapter is re-exported here for convenience. For in-process operation, use `LocalTransport` from [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning).

## What's in the box

- **`SemiontClient`** — the verb-oriented coordinator over a wire transport.
- **Verb namespaces** — `browse`, `mark`, `bind`, `gather`, `match`, `yield`, `beckon`, `job`, `auth`, `admin`. Typed methods that wrap the bus protocol; consumers never touch raw channel strings.
- **Session layer** — `SemiontSession` (per-KB authentication, token refresh, lifecycle), `SemiontBrowser` (tab-singleton coordinator), and `SessionStorage` adapters (`InMemorySessionStorage`, plus a web one in `@semiont/react-ui`).
- **View-models** — RxJS-based MVVM factories the React layer mounts via `useViewModel`.
- **Helpers** — `bus-request` (correlation-ID request/reply) and `cache` (per-key SWR cache).

## Installation

```bash
npm install @semiont/sdk
```

## Quick start (HTTP)

```ts
import {
  SemiontSession,
  InMemorySessionStorage,
  setStoredSession,
  type KnowledgeBase,
} from '@semiont/sdk';
import { accessToken } from '@semiont/core';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

const kb: KnowledgeBase = {
  id: 'local',
  label: 'Local Backend',
  protocol: 'http',
  host: 'localhost',
  port: 4000,
  email: 'me@example.com',
};

const storage = new InMemorySessionStorage();
setStoredSession(storage, kb.id, {
  access: accessToken('your-jwt'),
  refresh: '',
});

const session = await SemiontSession.create({ kb, storage });

const resources = await firstValueFrom(
  session.client.browse.resources({ limit: 10 }).pipe(
    filter((r): r is NonNullable<typeof r> => r !== undefined),
  ),
);
console.log(resources);
```

## Quick start (in-process)

When you want the SDK without an HTTP backend — e.g. in a CLI, a unit test, or an Electron-style desktop app — wire `LocalTransport` directly to a knowledge system:

```ts
import { SemiontClient } from '@semiont/sdk';
import {
  startMakeMeaning,
  LocalTransport,
  LocalContentTransport,
} from '@semiont/make-meaning';

const ks = await startMakeMeaning(project, config, eventBus, logger);
const transport = new LocalTransport({
  knowledgeSystem: ks.knowledgeSystem,
  eventBus,
  userId,
});
const client = new SemiontClient(
  transport,
  new LocalContentTransport(ks.knowledgeSystem),
);
```

Same `SemiontClient`, same verb namespaces — no network involved.

## Verb namespaces

All ten namespaces hang off `SemiontClient`. Each method either returns a `Promise` (one-shot RPC-style operations) or an `Observable` (streaming subscriptions). The bus is invisible to callers — channel strings, correlation IDs, and reconnection are internal.

```ts
// Browse — read the knowledge graph.
await client.browse.resources({ limit: 10 });
client.browse.resource(resourceId).subscribe(/* ... */);

// Mark / Bind — create and modify annotations.
const { annotationId } = await client.mark.annotation(rid, request);
await client.bind.body(rid, aid, [{ op: 'add', item: { /* W3C body */ } }]);

// Gather / Match — assemble context and run semantic search.
const ctx = await lastValueFrom(client.gather.annotation(aid, rid));
client.match.search(rid, refId, ctx, { limit: 10 }).subscribe(/* ... */);

// Yield — author new resources.
const { resourceId } = await client.yield.resource({
  name, file, format, storageUri,
});

// Beckon — UI signals (hover, focus, selection).
client.beckon.hover(annotationId);
```

The verb-by-verb walkthroughs live in [docs/flows](https://github.com/The-AI-Alliance/semiont/tree/main/docs/flows).

## Behavioral contract

The guarantees every `ITransport` implementation must honor — what `subscribe()` does on disconnect, what `LastEventId` replay must look like, what `puts` must be idempotent — are documented in [packages/core/docs/TRANSPORT-CONTRACT.md](https://github.com/The-AI-Alliance/semiont/blob/main/packages/core/docs/TRANSPORT-CONTRACT.md). HTTP-specific guarantees (the `/bus/emit` gateway, SSE reconnect, `Last-Event-ID` replay window) live alongside the backend at [apps/backend/docs/TRANSPORT.md](https://github.com/The-AI-Alliance/semiont/blob/main/apps/backend/docs/TRANSPORT.md).

When implementing a new transport (gRPC, WebSocket, IPC, …), implement those interfaces from `@semiont/core` directly — there is no inheritance from `HttpTransport`.

## License

Apache-2.0 — see [LICENSE](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE).

## Related packages

- [`@semiont/core`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/core) — domain types, `ITransport` contract, OpenAPI-derived schemas
- [`@semiont/api-client`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/api-client) — HTTP transport (`HttpTransport`, `HttpContentTransport`)
- [`@semiont/make-meaning`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/make-meaning) — in-process transport (`LocalTransport`) and the actor model behind it
- [`@semiont/observability`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/observability) — OpenTelemetry tracing the SDK propagates across the bus
- [`@semiont/react-ui`](https://github.com/The-AI-Alliance/semiont/tree/main/packages/react-ui) — React bindings (`useViewModel`, web `SessionStorage`)
