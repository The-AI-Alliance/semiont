# @semiont/sdk

The developer-facing SDK for [Semiont](https://github.com/The-AI-Alliance/semiont).
This package owns the high-level surface every Semiont consumer reaches for:

- **`SemiontClient`** — the verb-oriented coordinator over a wire transport.
- **Namespaces** — `browse`, `mark`, `bind`, `gather`, `match`, `yield`,
  `beckon`, `job`, `auth`, `admin`. Typed methods that wrap the bus
  protocol; consumers never touch raw channel strings.
- **Session layer** — `SemiontSession` (per-KB authentication, token
  refresh, lifecycle), `SemiontBrowser` (tab-singleton coordinator),
  `SessionStorage` adapters (`InMemorySessionStorage`, plus a web one in
  `@semiont/react-ui`).
- **View-models** — RxJS-based MVVM factories the React layer mounts via
  `useViewModel`.
- **Helpers** — `bus-request` (correlation-ID request/reply), `cache`
  (per-key SWR cache).

The sdk is **transport-agnostic**: it consumes the `ITransport` /
`IContentTransport` contract defined in
[`@semiont/core`](../core/). For HTTP, the canonical wire adapter is
re-exported from this package for convenience; for in-process operation,
use `LocalTransport` from
[`@semiont/make-meaning`](../make-meaning/).

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
setStoredSession(storage, kb.id, { access: accessToken('your-jwt'), refresh: '' });

const session = await SemiontSession.create({ kb, storage });
const resources = await firstValueFrom(
  session.client.browse.resources({ limit: 10 }).pipe(filter((r): r is NonNullable<typeof r> => r !== undefined)),
);
console.log(resources);
```

## Quick start (in-process)

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
const client = new SemiontClient(transport, new LocalContentTransport(ks.knowledgeSystem));
```

## Verb namespaces

All ten namespaces hang off `SemiontClient`. Each method either returns a
`Promise` (for one-shot RPC-style operations) or an `Observable` (for
streaming subscriptions). The bus is invisible to callers — channel
strings, correlation IDs, and reconnection are internal.

```ts
// Browse
await client.browse.resources({ limit: 10 });
client.browse.resource(resourceId).subscribe(/* ... */);

// Mark / Bind
const { annotationId } = await client.mark.annotation(rid, request);
await client.bind.body(rid, aid, [{ op: 'add', item: { ... } }]);

// Gather / Match
const ctx = await lastValueFrom(client.gather.annotation(aid, rid));
client.match.search(rid, refId, ctx, { limit: 10 }).subscribe(/* ... */);

// Yield
const { resourceId } = await client.yield.resource({ name, file, format, storageUri });

// Beckon (UI signals)
client.beckon.hover(annotationId);
```

See [docs/flows](../../docs/flows/) for verb-by-verb walkthroughs.

## Behavioral contract

The guarantees every `ITransport` implementation must honor are documented in
[`packages/core/docs/TRANSPORT-CONTRACT.md`](../core/docs/TRANSPORT-CONTRACT.md).
HTTP-specific guarantees (gateway, SSE, `Last-Event-ID`, etc.) live at
[`apps/backend/docs/TRANSPORT.md`](../../apps/backend/docs/TRANSPORT.md).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
