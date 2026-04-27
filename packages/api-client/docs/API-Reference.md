# `@semiont/api-client` Reference

`@semiont/api-client` ships the HTTP-specific implementations of the transport contracts in `@semiont/core`. The developer-facing surface (`SemiontClient`, the verb namespaces, sessions, view-models) lives in `@semiont/sdk`. This doc covers the HTTP adapters only.

For the namespace-level API tour, see [`@semiont/sdk/docs/Usage.md`](../../sdk/docs/Usage.md).

## `HttpTransport`

```typescript
import { HttpTransport } from '@semiont/api-client';

new HttpTransport(config: HttpTransportConfig)
```

Implements `ITransport` from `@semiont/core`. Owns the SSE bus connection, HTTP `/bus/emit`, and the auth/admin/exchange/health/status REST surface that crosses the remote boundary.

### `HttpTransportConfig`

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `BaseUrl` | yes | Backend API URL (cast via `baseUrl(...)` from `@semiont/core`). |
| `token$` | `BehaviorSubject<AccessToken \| null>` | no | Observable access-token source. Headers read the current value; updates via `.next(newToken)` are observed for the next request. Omit for unauthenticated usage. |
| `timeout` | `number` | no | Request timeout in ms (default: 30000). |
| `retry` | `number` | no | Retry attempts on transient failure (default: 2). |
| `logger` | `Logger` | no | Optional logger for HTTP/SSE observability — see [`LOGGING.md`](./LOGGING.md). |
| `tokenRefresher` | `TokenRefresher` | no | 401-recovery hook (see below). |

### `TokenRefresher`

```typescript
type TokenRefresher = () => Promise<string | null>;
```

Called when the transport receives a 401. Should return a new access token (no `Bearer ` prefix), or `null` to give up. The transport pushes the new token into `token$` and retries the originating request.

For session-managed refresh (proactive refresh on a timer, terminal-auth-failure surface, cross-tab sync), use `SemiontSession` from `@semiont/sdk` rather than the raw `tokenRefresher` hook — `SemiontSession.refresh()` orchestrates the lifecycle and `tokenRefresher` is the lower-level escape hatch.

## `HttpContentTransport`

```typescript
import { HttpContentTransport } from '@semiont/api-client';

new HttpContentTransport(transport: HttpTransport)
```

Implements `IContentTransport` from `@semiont/core`. Binary I/O — `putBinary`, `getBinary`, `getBinaryStream`. Shares the wrapped transport's `baseUrl`, `token$`, and timeout; binary requests piggyback on the same auth.

## `APIError`

```typescript
class APIError extends Error {
  status: number;
  statusText: string;
  details?: unknown;
}
```

Thrown for non-2xx HTTP responses from the REST methods on `HttpTransport`. `status` and `statusText` are the HTTP-level fields; `details` is the parsed response body when available.

## Composing with `SemiontClient`

The intended consumption pattern is to import `SemiontClient` from `@semiont/sdk` and pass `HttpTransport` + `HttpContentTransport` instances to its constructor. `@semiont/sdk` re-exports `HttpTransport` and `HttpContentTransport` for convenience, so a typical consumer needs only one import:

```typescript
import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
import { baseUrl, accessToken, type AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

const token$ = new BehaviorSubject<AccessToken | null>(accessToken('...'));
const transport = new HttpTransport({ baseUrl: baseUrl('https://kb.example.com'), token$ });
const client = new SemiontClient(transport, new HttpContentTransport(transport));
```

Direct imports from `@semiont/api-client` are appropriate when constructing the transport stack by hand (CLI factories, MCP entrypoints, worker pools that wire bespoke `tokenRefresher` callbacks or token sources).

## Behavioral contract

The guarantees every `ITransport` implementation must honor — including `HttpTransport` — are documented in [`packages/core/docs/TRANSPORT-CONTRACT.md`](../../core/docs/TRANSPORT-CONTRACT.md). HTTP-specific guarantees (the `/bus/emit` gateway, SSE reconnect, `Last-Event-ID` replay window, six-state connection machine) live alongside the backend at [`apps/backend/docs/TRANSPORT.md`](../../../apps/backend/docs/TRANSPORT.md).

## Other docs in this package

- [`LOGGING.md`](./LOGGING.md) — logger interface, what gets logged, integration examples.
- [`MEDIA-TOKENS.md`](./MEDIA-TOKENS.md) — short-lived JWT for binary URL fetches that can't carry an `Authorization` header.
