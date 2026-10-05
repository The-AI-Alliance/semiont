# @semiont/http-transport

[![Tests](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml/badge.svg)](https://github.com/The-AI-Alliance/semiont/actions/workflows/package-tests.yml?query=branch%3Amain+is%3Asuccess+job%3A%22Test+http-transport%22)
[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=http-transport)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=http-transport)
[![npm version](https://img.shields.io/npm/v/@semiont/http-transport.svg)](https://www.npmjs.com/package/@semiont/http-transport)
[![npm downloads](https://img.shields.io/npm/dm/@semiont/http-transport.svg)](https://www.npmjs.com/package/@semiont/http-transport)
[![License](https://img.shields.io/npm/l/@semiont/http-transport.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

How the TypeScript SDK reaches a knowledge base over HTTP. It implements the three transport contracts [`@semiont/core`](../core/README.md) states (`ITransport`, `IContentTransport`, `IGatewayOperations`) against a knowledge base's gateway.

## Who uses it

- **[`@semiont/sdk`](../sdk/README.md)** builds one for every session, and re-exports `HttpTransport` and `HttpContentTransport`.
- **The Node services** build the stack by hand, because each signs in as an agent and listens to a narrowed set of channels: the Worker in [`@semiont/jobs`](../jobs/README.md), and the Archivist, Librarian, Smelter and Weaver in [`@semiont/make-meaning`](../make-meaning/README.md).
- **[`@semiont/mcp-server`](../mcp-server/README.md)**.

**Building an application?** Import from [`@semiont/sdk`](../sdk/README.md), not from here. A session gives you a connected client, and the two transport classes are re-exported there for the rare program that wires its own.

## What is in it

| | |
|---|---|
| `HttpTransport` | The bus over a gateway: `POST /bus/emit` for what a client sends, one stream (`POST /bus/subscribe`) for what it receives, and the gateway's plain operations |
| `HttpContentTransport` | A resource's bytes, up with progress and cancellation, and down whole or as a stream |
| `HttpTransportConfig` | What a transport is given: the gateway's address, a token source, a `TokenRefresher`, and the channels its stream names |
| `currentUserOf(baseUrl, token)` | One request asking the gateway who a token is, with no transport behind it. A session asks this of a stored credential before it trusts it |
| `APIError` | What an HTTP failure is thrown as |
| `createActorStateUnit` | The stream's machinery. Exported for the service-side adapters built on it (`createJobClaimAdapter` in `@semiont/jobs`, `smelterFanIn` in `@semiont/make-meaning`). Application code does not use it |

## Example

The stack wired by hand. A session does this for you.

```typescript
import { SemiontClient } from '@semiont/sdk';
import { HttpTransport, HttpContentTransport } from '@semiont/http-transport';
import { baseUrl } from '@semiont/core';

const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example/') });

// HttpTransport is also the gateway's plain operations: passed third, it
// gives the client its `auth` and `system` namespaces.
const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
```

## What a change must keep

- **The transport contract.** What every transport must do is [TRANSPORT-CONTRACT](../../docs/protocol/TRANSPORT-CONTRACT.md), and what this one does on the wire is [TRANSPORT-HTTP](../../docs/protocol/TRANSPORT-HTTP.md). The [SDK conformance suite](../../tests/conformance/sdk/README.md) holds it to both, through [conformance/driver.ts](conformance/driver.ts), beside the Rust transport.
- **One token source.** A transport reads the current token from `token$`. `tokenRefresher` is the only way a token is renewed, for a refused request and a refused stream alike.
- **Timing is the spec's.** The reconnect, linger and retry values are [`specs/src/client/timing.json`](../../specs/src/client/timing.json)'s. The config fields that override them are for a test or the conformance driver, which cannot wait them out.
- **A narrowed stream still hears its replies.** A process that passes `channels` names the reply channels of every operation it awaits. A request whose replies are outside the set fails at once with `bus.unsubscribed`, rather than timing out.
- **Wire shapes are generated.** Requests and responses are `@semiont/core`'s types, from the spec. None is retyped here.

A transport that is not HTTP implements `ITransport` and `IContentTransport` from `@semiont/core` and inherits nothing from this package.

## Documentation

- [Reference](docs/API-Reference.md): each export.
- [Logging](docs/LOGGING.md): what the transport logs, and the bus log.
- [Media tokens](docs/MEDIA-TOKENS.md): how a browser fetches a resource's bytes without an `Authorization` header.

## License

Apache-2.0
