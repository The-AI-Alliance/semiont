# @semiont/http-transport

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+http-transport%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=http-transport)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=http-transport)
[![npm version](https://img.shields.io/npm/v/@semiont/http-transport.svg)](https://www.npmjs.com/package/@semiont/http-transport)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/http-transport.svg)](https://www.npmjs.com/package/@semiont/http-transport)
[![License](https://img.shields.io/npm/l/@semiont/http-transport.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

HTTP-specific transport adapters for the Semiont SDK. This is the wire-side
implementation of the `ITransport` and `IContentTransport` contracts defined
in [`@semiont/core`](../core/), consumed by [`@semiont/sdk`](../sdk/).

Most application code does **not** import this package directly. The sdk
re-exports the HTTP adapters for convenience, so a typical consumer writes:

```ts
import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
import { baseUrl } from '@semiont/core';

const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example/') });
// HttpTransport implements both ITransport and IBackendOperations; passing it
// third enables the `auth` / `admin` namespaces.
const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
```

Direct imports from `@semiont/http-transport` are appropriate when constructing
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
  createActorStateUnit,
  type ActorStateUnit,
  type BusEvent,
  type ActorStateUnitOptions,
  DEGRADED_THRESHOLD_MS,
} from '@semiont/http-transport';
```

That's the entire surface. Everything else moved out:

- **`ITransport`, `IContentTransport`, `BRIDGED_CHANNELS`, `ConnectionState`,
  response/progress types** live in [`@semiont/core`](../core/).
- **`SemiontClient`, namespaces, `SemiontSession`, `SemiontBrowser`,
  state units, `bus-request`, `cache`** live in [`@semiont/sdk`](../sdk/).

## Behavioral contract

The guarantees every `ITransport` implementation must honor — including
`HttpTransport` — are documented in
[`docs/protocol/TRANSPORT-CONTRACT.md`](../../docs/protocol/TRANSPORT-CONTRACT.md).
HTTP-specific guarantees (the `/bus/emit` gateway, SSE reconnect, `Last-Event-ID`
replay, etc.) live in
[`docs/protocol/TRANSPORT-HTTP.md`](../../docs/protocol/TRANSPORT-HTTP.md).

## Writing a new transport

If you need to add a non-HTTP transport (gRPC, WebSocket, IPC, …), implement
`ITransport` + `IContentTransport` from `@semiont/core` and consume the
contract from there. There's no inheritance from `HttpTransport`. For an
in-process example, see `LocalTransport` in
[`@semiont/make-meaning`](../make-meaning/).

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
