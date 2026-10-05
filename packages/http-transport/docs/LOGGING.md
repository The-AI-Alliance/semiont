# Logging

What `HttpTransport` writes about what it does, and where. There are two logs: the lines it gives a logger you pass it, and the bus log, which is switched on for a whole process.

## The logger

Pass a `logger` in `HttpTransportConfig` and the transport logs its plain requests to it. Pass none and it logs nothing. The logger is [`@semiont/core`](../../core/README.md)'s `Logger`: `debug`, `info`, `warn`, `error`, each taking a message and an object of fields, and `child`. Anything of that shape will do.

```typescript
import { HttpTransport } from '@semiont/http-transport';
import { baseUrl, type Logger } from '@semiont/core';

const logger: Logger = {
  debug: (message, fields) => console.debug(message, fields),
  info: (message, fields) => console.info(message, fields),
  warn: (message, fields) => console.warn(message, fields),
  error: (message, fields) => console.error(message, fields),
  child: () => logger,
};

const transport = new HttpTransport({ baseUrl: baseUrl('http://localhost:4000'), logger });
```

A service passes the logger of its process: `createProcessLogger` in [`@semiont/observability`](../../observability/README.md).

## What it logs

Four lines, and no others. Each carries a `type` to filter on.

| Message | Level | `type` | Fields | When |
|---|---|---|---|---|
| `HTTP Request` | debug | `http_request` | `url`, `method`, `timestamp`, `hasAuth` | A plain request is sent |
| `HTTP Response` | debug | `http_response` | `url`, `method`, `status`, `statusText` | Its response arrives |
| `HTTP Request Failed` | error | `http_error` | `url`, `method`, `status`, `statusText`, `error` | The gateway refused it |
| `Bridge relay failed` | error | | `channel`, `error` | A frame from the stream could not be put on the client's bus |

A plain request is one of the gateway's own operations or a read or write of content. The transport logs nothing at `info` or `warn`.

Two things are outside this log:

- **Emits and the stream.** What a client sends on the bus and what it receives are in the bus log, below.
- **An upload with progress, in a browser.** When a caller asks for progress or passes a `signal`, a browser sends the upload through `XMLHttpRequest`, which these lines do not cover. Its `PUT` line in the bus log is still written.

## What is never logged

- **A token.** `hasAuth` says whether an `Authorization` header was sent, and nothing else about it.
- **A body.** Neither what was sent nor what came back. The lines carry addresses, methods and statuses only.

## The bus log

The bus log is one line for everything that crosses the wire, in the same form in every process, so that the lines of a client, the gateway and a service can be read together:

```
[bus EMIT] mark:create-request scope=res-7f3a cid=1b9d6bcd trace=4bf92f35 { ... }
[bus RECV] mark:create-ok scope=res-7f3a cid=1b9d6bcd { ... }
[bus PUT] content { name: 'Notes', format: 'text/markdown', storageUri: 'file://notes.md', sizeBytes: 412 }
[bus GET] content { resourceId: 'res-7f3a' }
```

`EMIT` is a frame this transport sent, `RECV` one it received, and `PUT` and `GET` a write and a read of content. `scope` is the resource a frame is about, where it has one. `cid` is the first eight characters of the correlation id that ties a reply to its request. `trace` is the first eight of the active trace, present when the process has telemetry running. The rest of the line is the payload.

It is off until switched on, for the whole process:

- **Node:** `SEMIONT_BUS_LOG` set to anything, in the environment the process starts with.
- **A browser:** `window.__SEMIONT_BUS_LOG__ = true`, in the console.

It is written with `console.debug`, not to the logger. Unlike the logger's lines, it shows payloads: a tool for following one action across processes, not something to leave on.
