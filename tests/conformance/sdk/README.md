# SDK conformance suite

A black-box suite for the SDKs. Each SDK is put through one corpus of cases
against a real gateway, and must do on the wire, and report to its caller,
what every other SDK does. The corpus is data: a case is a JSON file, the
same file for every language. What differs per language is a **driver**, a
small program that turns the suite's operations into calls on that SDK's
public API and writes back what happened.

The suite imports nothing from an SDK. The lines that name one are
`SDK_DRIVERS` in [harness/paths.ts](../harness/paths.ts): how each of an SDK's
drivers is started.

| Layer | Holds an SDK to | Cases | Entry |
|---|---|---|---|
| wire | the transport: the stream, emits, requests, content, the gateway's own operations | [wire/](wire/) | [wire.test.ts](wire.test.ts) |
| live | the client's live queries and their cache: what an observer is given, and what each observation costs on the wire ([CACHE-SEMANTICS](../../../packages/sdk/docs/CACHE-SEMANTICS.md)) | [live/](live/) | [live.test.ts](live.test.ts) |

An SDK has a driver per layer it implements. The live layer has two tiers,
and an SDK's line says which it is held to: `fleet`, the cases every SDK with
a live layer passes, or `parity`, those and the rest of the contract. Each
case states its tier, and `live.test.ts` runs an SDK through the cases of the
tier it is held to.

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

The two layers read the wire differently. A wire case reads it as a
transcript: every request, in order. A live case reads what the live contract
means on it: each request the client makes of a service, in order and none
unaccounted, and the scopes its stream has come to name. How often the client
reopened its stream to get there is the wire layer's to judge.

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

### The live driver

The live driver holds the SDK's client. Its `open` takes `baseUrl`, `token`,
`timing`, and `persist`: with `persist`, the client's cache is kept across a
`close` and the `open` that follows, as storage keeps it across a reload. A
closed client stays the driver's until the next `open`, so a case can ask a
closed client for something. Its operations:

| `op` | Arguments | `ok` |
|---|---|---|
| `observe` | `observer` (a name), `query`: the observer begins observing the live query | `null` |
| `unobserve` | `observer`: it stops | `null` |
| `fresh` | `query`: a one-shot read | `{"value": ...}` |
| `invalidate` | `query`: the caller says the key is out of date | `null` |
| `sync` | | `null`, after everything the client reported before it |

A `query` names what is observed: `{"query": "resource", "resource": id}`,
and likewise `annotations`, `events`, `referencedBy`; `annotation` with
`resource` and `annotation`; `resources` with optional `filters`;
`entityTypes`; `tagSchemas`.

It writes, as they happen:

| Line | Meaning |
|---|---|
| `{"emission": {"observer": "a", "state": {"status": "pending"}}}` | the observer was given a state: `pending`, `ready` with its `value`, or `failed` with its `error` |
| `{"completed": "a"}` | the observer's live query completed |

An observer's states are read as states, not as a sequence: a case waits for
one to be reached, and never counts the ones before it, so an SDK whose
observers see only the latest state conforms. A case makes each state last by
holding back the answer that would end it.

Its `timing` overrides `busRequestTimeoutMs` and `invalidationWindowMs`
beside the transport's `reconnectMs`, `lazyRemoveMs` and `lingerMs`.

While a client hands its subscription from one stream to the next, both
streams carry every event sent to all clients, and the client is given each
twice: such an event has no id that says the two are one. A live case
therefore publishes one only after a `scopes` step, which waits for the old
stream to have closed.

`open`'s `timing` overrides entries of
[`specs/src/client/timing.json`](../../../specs/src/client/timing.json) by
name, so a case does not wait out a production delay. The cases override
`reconnectMs`, `lazyRemoveMs`, `lingerMs` and `emitRetry`; a driver must honour
all four, and answers `misuse` to a name it cannot override.

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

A live case uses these in place of `wire` and `carried`:

| Step | Meaning |
|---|---|
| `{"observe": query, "as": "a"}` | an observer, named `a`, begins observing |
| `{"leave": "a"}` | it stops |
| `{"reaches": "a", "state": {...}}` | the observer comes to hold this state |
| `{"holds": "a", "state": {...}}` | the state it holds now is this one |
| `{"completes": "a"}` | its live query completes |
| `{"fetch": "browse:resource-requested", "payload": {...}, "as": "f1"}` | the client's next request of a service is this one; `f1` is its correlation id, for the backend to answer |
| `{"fetches": [ ... ]}` | its next requests are these, in whatever order it makes them |
| `{"scopes": ["..."]}` | the client comes to hold one stream, naming exactly these scopes, that has caught up |

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
| `a1`, `a2` | two annotation ids no other case uses |
| `resourceScopedChannels` | the channels a resource's scope carries, from the registry |

`open` is given the proxy as its `baseUrl`, and `token` when the step names
no other.

### Backend directives

| Directive | Arguments | Does |
|---|---|---|
| `listen` | `channels`, `scope` | the participant subscribes: globally, or to one scope |
| `emit` | `channel`, `payload`, `scope`, `correlationId` | the participant emits; the gateway must accept it |
| `record` | `resource`, `channel`, `sequence`, `live`, `payload`, `enriched`, `unscoped` | a persisted event, with `payload` when given, enters the resource's record; with `live`, it is also published, with the fields of `enriched` added, on the resource's scope, or to every client with `unscoped` |
| `archivist` | `replayFails` | the Archivist fails, or stops failing, the gateway's reads of a record |
| `content` | `resource`, `mediaType`, `bytes` | the Archivist holds these bytes for the resource |
| `description` | `resource`, `graph` | the Archivist holds this description of the resource |
| `uploaded` | `resource`, `fields`, `bytes` | the Archivist recorded this upload, for the case's principal |
| `refuse` | `wire`, `status`, `retryAfter`, `body`, `times` | the proxy answers the next `times` such requests itself, as the spec lets a gateway answer |
| `hold` | `wire` | the proxy keeps such requests waiting |
| `release` | | held requests go through |
| `rechunk` | `bytes` | streams reach the client this many bytes at a time |
| `cut` | | every connection the client has ends |
| `down`, `up` | | the gateway is unreachable; it is back |

## What the live layer cannot show

A clause of CACHE-SEMANTICS that no case holds, and why:

| Clause | Why no case holds it |
|---|---|
| B4, one observable per key | It is the identity of an object in the client's own language; nothing of it crosses to the suite. What it is for, shared work, is B3. |
| B11, observables live as long as the cache | It is memory the client keeps, with no effect an observer or the wire can see. |
| B12, handlers are additive | It is a rule about how the code is written. Its effect is the `event-*` cases, each holding one event to exactly what it refreshes. |
| B17, the save's debounce, the storage document's version, sync between contexts | They are the storage adapter's, below what a driver's `persist` reaches. `rehydration` holds what they are for: a value saved by one client is the next one's. |
| A one-shot read of a closed client | TypeScript rejects it with an error that carries no code, which this suite cannot accept from any SDK. |

## Cases that restate a table

Where a case states what a spec table already states, `wire.test.ts` holds
the case to the table, so a table that changes fails the case rather than
leaving it to agree with a client about the old value: `failure-codes`
against the wire codes and their client codes, `emit-budget-spent` against
the emit budget.

## Adding an SDK

Write a driver for each layer over the SDK's public API, add them to its line
of `SDK_DRIVERS`, and run the suite. TypeScript's are
[packages/http-transport/conformance/driver.ts](../../../packages/http-transport/conformance/driver.ts)
for the wire and
[packages/sdk/conformance/driver.ts](../../../packages/sdk/conformance/driver.ts)
for the live layer.

## Running it

It needs a built gateway, `nats-server` (2.10 or later) on `PATH`, and the
TypeScript SDK built:

```bash
cargo build --release -p semiont-gateway
npm run build --workspace=@semiont/sdk
cd tests/conformance
npm ci
npm run test:sdk
```

The suite type-checks the TypeScript drivers before it starts: Node runs them
with their types stripped, and would run a mistyped one.
