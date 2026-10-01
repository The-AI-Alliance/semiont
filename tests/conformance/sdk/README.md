# SDK conformance suite

A black-box suite for the SDKs. Each SDK is put through one corpus of cases
against a real gateway, and must do on the wire, and report to its caller,
what every other SDK does. The corpus is data: a case is a JSON file, the
same file for every language. What differs per language is a **driver**, a
small program that turns the suite's operations into calls on that SDK's
public API and writes back what happened.

The suite imports nothing from an SDK. The lines that name one are
`SDK_DRIVERS` in [harness/paths.ts](../harness/paths.ts): how each driver is
started.

| Layer | Holds an SDK to | Cases | Entry |
|---|---|---|---|
| wire | the transport: the stream, emits, requests, content, the gateway's own operations | [wire/](wire/) | [wire.test.ts](wire.test.ts) |

## What every case holds a client to

A case states a scenario. Whatever the scenario, [case.ts](case.ts) also
fails a client that:

- sends a request the spec does not declare, or a JSON body the declared
  operation does not accept;
- sends anything the case does not account for: the requests on the wire are
  a transcript, read in order, and a request with no step of its own is a
  failure;
- delivers, on a channel the case listens to, anything other than the events
  the gateway sent it there, once each, in order, unchanged. The proxy reads
  every stream as the gateway wrote it, so what a driver says it delivered is
  held to what it was sent, not believed;
- reports a failure with no code, or with one
  [`specs/src/errors/codes.json`](../../../specs/src/errors/codes.json) does
  not list;
- reports anything on its error stream that the case does not expect;
- settles an operation twice.

A conforming client passes every case every time: steps wait for what they
expect and never compare how long it took. A client that does something
extra — a request too many, a credential sent again — fails when the extra
lands inside the case; a `quiet` step gives it the time to land.

## The backend

The gateway is the real one, on each signal plane, with the suite's issuer,
stand-in Archivist and broker around it (the same world the
[gateway suite](../gateway/README.md) runs). Two things stand between it and
the client:

- the **client proxy** ([harness/client-proxy.ts](../harness/client-proxy.ts)):
  the client is pointed at it instead of the gateway. It records every
  request and every event each stream carried, and can end the client's
  connections, refuse new ones, keep a request waiting, answer one itself
  with a refusal the case scripted, and pass a stream on a byte at a time;
- a **participant**: a software agent the suite plays in place of the
  services, which listens for requests and emits what a case tells it to.

The proxy answers in the gateway's place in one directive only, `refuse`, and
the suite holds what it is told to say to the response the spec declares
before it says it.

## The driver protocol

A driver is a process. The suite writes one JSON object per line to its
stdin and reads one per line from its stdout; stderr is free, and is shown
when a case fails. The driver writes `{"ready": true}` once it can take
operations. When its stdin ends it disposes of its client and exits 0.

**An operation** is `{"id": 7, "op": "emit", ...arguments}`. Operations run
concurrently; each is answered once, whenever it settles, by one of:

| Line | Meaning |
|---|---|
| `{"id": 7, "ok": <value>}` | it succeeded; `null` when there is nothing to return |
| `{"id": 7, "error": {"code": "...", "status": 429, "detail": "..."}}` | the SDK failed it |
| `{"id": 7, "abandoned": true}` | the suite abandoned it, and the SDK reported nothing else |
| `{"id": 7, "unsupported": true}` | this driver has no such operation |
| `{"id": 7, "misuse": "..."}` | the suite's arguments made no sense: the suite's mistake, never the SDK's |

A failure's `code` is the SDK's own, from `specs/src/errors/codes.json`.
`status` is the HTTP status when a server stated one, and absent otherwise.
`detail` is the SDK's words, for a person; nothing compares it.

**What the client observes** is written as it happens, with no `id`:

| Line | Meaning |
|---|---|
| `{"state": "open"}` | the transport's connection state changed |
| `{"frame": {"channel": "...", "payload": {...}, "correlationId": "...", "scope": "..."}}` | a frame was delivered on a channel the driver listens to; `correlationId` and `scope` only when the frame has them |
| `{"error": {"code": "...", "status": 401, "detail": "..."}}` | the error stream carried a failure |

A driver may report every state its transport passes through or only the
latest: a case waits for a state to be reached and never counts the ones
before it. Frames and failures are sequences: every one, in order.

### Operations

| `op` | Arguments | `ok` |
|---|---|---|
| `open` | `baseUrl`, `token`, `channels` (the global channels its stream names), `timing` | `null` |
| `close` | | `null` |
| `set-token` | `token`: the credential the client uses from now on | `null` |
| `listen` | `channel`: report every frame delivered on it | `null` |
| `subscribe-resource` | `resource`: take one hold on the resource's scope | `null` |
| `release-resource` | `resource`: let go of one hold | `null` |
| `emit` | `channel`, `payload`, and `scope`, `correlationId` when given | `{"subscribers": n}`, or `{}` when the gateway gave no count |
| `request` | `operation` (a request channel of the registry), `payload`, `timeoutMs` | `{"response": ...}`, or `{}` when the reply carries none |
| `abandon` | `request`: the `id` of a `request` not yet settled, which its caller now abandons | `null`; the request itself then settles as `abandoned` |
| `put` | `name`, `format`, `storageUri`, `bytes` (base64), and any of `language`, `entityTypes`, `sourceResourceId`, `sourceAnnotationId`, `generationPrompt`, `jobId`, `isDraft` | `{"resourceId": "..."}` |
| `get` | `resource` | `{"contentType": "...", "bytes": "<base64>"}` |
| `get-stream` | `resource`: read as a stream, to its end | the same |
| `graph` | `resource` | the description the gateway answered |
| `health`, `status`, `current-user`, `protected-resource-metadata` | | what the gateway answered |
| `media-token` | `resource` | what the gateway answered |

One driver holds one client: a second `open` is misuse.

`open`'s `timing` overrides entries of
[`specs/src/client/timing.json`](../../../specs/src/client/timing.json) by
name, so a case does not wait out a production delay. The cases override
`reconnectMs`, `lazyRemoveMs` and `emitRetry`; a driver must honour all three,
and answers `misuse` to a name it cannot override.

A driver started with `OTEL_EXPORTER_OTLP_ENDPOINT` in its environment exports
the SDK's telemetry there over OTLP/HTTP, and has exported all of it by the
time it exits.

## A case

```json
{
  "about": "what the case holds a client to, in a sentence",
  "source": "where the protocol or the spec states it",
  "planes": ["in-process"],
  "telemetry": true,
  "steps": [ ... ]
}
```

`planes` is given only when the case holds on one signal plane; absent, it
runs on both. `telemetry` runs the client exporting to a receiver, and once
the driver has exited holds what it exported to
[`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json):
every row arrived, of its kind, with every attribute not marked `only`, and
whatever arrived under a row's name carries only that row's attributes. What
no row names is the driver's process, not the SDK, and is not judged. [case.schema.json](case.schema.json) is the format, and every
case is checked against it when the suite loads. A case's name is its file's.

Steps run in order, each waiting for what it states:

| Step | Meaning |
|---|---|
| `{"let": {"name": value}}` | name values for later steps |
| `{"driver": "<op>", "with": {...}}` | the operation succeeds; with `"returns"`, with that value; with `"fails"`, it fails with that failure instead |
| `{"driver": "<op>", "with": {...}, "as": "name"}` | start the operation and go on |
| `{"settles": "name", "returns" or "fails": ...}` | an operation started with `as` settles |
| `{"abandon": "name"}` | the case abandons a request started with `as`, as its caller would |
| `{"settles": "name", "abandoned": true}` | it ended because it was abandoned, and reported nothing |
| `{"wire": "POST /bus/emit", ...}` | the client's next request is this operation of the spec, with each of `status`, `params`, `body`, `token`, `answer` given |
| `{"carried": "name", "is": frame}` | the stream a wire step named has carried this frame to the client |
| `{"state": "open"}` | the transport reaches this state |
| `{"frame": "<channel>", "is": {...}}` | the next frame delivered on the channel is this one |
| `{"error": {...}}` | the next failure on the error stream is this one |
| `{"backend": "<directive>", "with": {...}}` | the backend does something |
| `{"quiet": 300}` | the client sends nothing more for this many milliseconds |

A `wire` step waits for the request to be answered. `"at": "arrival"` reads
it as soon as it arrives, for a request the proxy is holding; `"at": "live"`
waits for a stream to have caught up, after which a frame cannot race the
subscription. `"as"` names the request, and two fields relate it to a named
one: `"follows"` (it arrived after that one was answered) and `"waited"` (it
arrived no sooner than the `Retry-After` that one's answer stated).

A subscription's `body` is read by what it means, not by how a client wrote
it: `global`, `scoped` and `pendingReplies` are always present, an absent
list an empty one, and channels, scopes and awaited replies are in name
order. Every other body is compared as sent.

### Values

A value a step expects is JSON, compared exactly: the same scalars, the same
list, the same keys. Two operators:

- `{"$var": "name"}` takes the value found there the first time the name is
  met; every later use must equal it, and a step's arguments use it as that
  value. `_` takes anything and keeps nothing.
- `{"$join": ["p-", {"$var": "r1"}, "-2"]}` is the text its parts make.

The suite binds these before a case begins:

| Name | Value |
|---|---|
| `token`, `token2` | two credentials of the case's own principal, a person no other case uses |
| `client` | that principal's DID |
| `participant` | the DID of the participant the suite plays |
| `r1`, `r2`, `r3` | three resource ids no other case uses, in name order |
| `resourceScopedChannels` | the channels a resource's scope carries, from the registry |

`open` is given the proxy as its `baseUrl`, and `token` when the step names
no other.

### Backend directives

| Directive | Arguments | Does |
|---|---|---|
| `listen` | `channels`, `scope` | the participant subscribes: globally, or to one scope |
| `emit` | `channel`, `payload`, `scope`, `correlationId` | the participant emits; the gateway must accept it |
| `record` | `resource`, `channel`, `sequence`, `live` | a persisted event enters the resource's record; with `live`, it is also published on the resource's scope |
| `content` | `resource`, `mediaType`, `bytes` | the Archivist holds these bytes for the resource |
| `description` | `resource`, `graph` | the Archivist holds this description of the resource |
| `uploaded` | `resource`, `fields`, `bytes` | the Archivist recorded this upload, for the case's principal |
| `refuse` | `wire`, `status`, `retryAfter`, `body`, `times` | the proxy answers the next `times` such requests itself, as the spec lets a gateway answer |
| `hold` | `wire` | the proxy keeps such requests waiting |
| `release` | | held requests go through |
| `rechunk` | `bytes` | streams reach the client this many bytes at a time |
| `cut` | | every connection the client has ends |
| `down`, `up` | | the gateway is unreachable; it is back |

## Cases that restate a table

Where a case states what a spec table already states, `wire.test.ts` holds
the case to the table, so a table that changes fails the case rather than
leaving it to agree with a client about the old value: `failure-codes`
against the wire codes and their client codes, `emit-budget-spent` against
the emit budget.

## Adding an SDK

Write its driver over the SDK's public API, add its line to `SDK_DRIVERS`,
and run the suite. The TypeScript driver is
[packages/http-transport/conformance/driver.ts](../../../packages/http-transport/conformance/driver.ts).

## Running it

It needs a built gateway, `nats-server` (2.10 or later) on `PATH`, and the
TypeScript transport built:

```bash
cargo build --release -p semiont-gateway
npm run build --workspace=@semiont/http-transport
cd tests/conformance
npm ci
npm run test:sdk
```

The suite type-checks the TypeScript driver before it starts: Node runs the
driver with its types stripped, and would run a mistyped one.
