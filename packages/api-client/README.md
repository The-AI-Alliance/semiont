# @semiont/api-client

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+api-client%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=api-client)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=api-client)
[![npm version](https://img.shields.io/npm/v/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/api-client.svg)](https://www.npmjs.com/package/@semiont/api-client)
[![License](https://img.shields.io/npm/l/@semiont/api-client.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

HTTP-specific transport adapters for the Semiont SDK. This is the wire-side
implementation of the `ITransport` and `IContentTransport` contracts defined
in [`@semiont/core`](../core/), consumed by [`@semiont/sdk`](../sdk/).

Most application code does **not** import this package directly. The sdk
re-exports the HTTP adapters for convenience, so a typical consumer writes:

```ts
import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
import { baseUrl } from '@semiont/core';

const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example/') });
const client = new SemiontClient(transport, new HttpContentTransport(transport));
```

Direct imports from `@semiont/api-client` are appropriate when constructing
the transport stack by hand — e.g. CLI factories, MCP entrypoints, or worker
pools that wire bespoke `tokenRefresher` / `BehaviorSubject` token sources.

## Public surface

```ts
import {
  HttpTransport,
  HttpContentTransport,
  type HttpTransportConfig,
  type TokenRefresher,
  APIError,
  // SSE-actor machinery used by SDK adapters; not application code:
  createActorVM,
  type ActorVM,
  type BusEvent,
  type ActorVMOptions,
  DEGRADED_THRESHOLD_MS,
} from '@semiont/api-client';
```

That's the entire surface. Everything else moved out:

- **`ITransport`, `IContentTransport`, `BRIDGED_CHANNELS`, `ConnectionState`,
  response/progress types** live in [`@semiont/core`](../core/).
- **`SemiontClient`, namespaces, `SemiontSession`, `SemiontBrowser`,
  view-models, `bus-request`, `cache`** live in [`@semiont/sdk`](../sdk/).

## Behavioral contract

The guarantees every `ITransport` implementation must honor — including
`HttpTransport` — are documented in
[`packages/core/docs/TRANSPORT-CONTRACT.md`](../core/docs/TRANSPORT-CONTRACT.md).
HTTP-specific guarantees (the `/bus/emit` gateway, SSE reconnect, `Last-Event-ID`
replay, etc.) live alongside the backend at
[`apps/backend/docs/TRANSPORT.md`](../../apps/backend/docs/TRANSPORT.md).

## Writing a new transport

If you need to add a non-HTTP transport (gRPC, WebSocket, IPC, …), implement
`ITransport` + `IContentTransport` from `@semiont/core` and consume the
contract from there. There's no inheritance from `HttpTransport`. For an
in-process example, see `LocalTransport` in
[`@semiont/make-meaning`](../make-meaning/).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
