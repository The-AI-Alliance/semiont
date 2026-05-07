# `@semiont/sdk` Usage Guide

## Table of Contents

- [Orientation](#orientation)
- [Setup](#setup)
- [Browse — Reading Resources and Annotations](#browse)
- [Frame — Schema Vocabulary](#frame)
- [Mark — Annotation CRUD and AI Assist](#mark)
- [Bind — Reference Linking](#bind)
- [Gather — LLM Context Assembly](#gather)
- [Match — Semantic Search](#match)
- [Yield — Resource Creation and Generation](#yield)
- [Beckon — Attention Coordination](#beckon)
- [Auth — Authentication](#auth)
- [Admin — Administration](#admin)
- [Job — Worker Lifecycle](#job)
- [SSE Streams](#sse-streams)
- [Error Handling](#error-handling)
- [Logging](#logging)

## Orientation

Three framings hold the SDK's surface together. Skim them once and the per-namespace details below become predictable.

**Eight verbs.** Every operation belongs to one of eight flows — *frame, yield, mark, match, bind, gather, browse, beckon* — that describe what a participant *does* with a shared corpus. The first seven act on content (resources, annotations, references, attention); Frame acts on the schema layer (the conceptual vocabulary the others operate within). Each flow is a namespace on `SemiontClient`. The verb is the unit of mental model; methods belong to flows, not to nouns. The protocol-level definitions live in [`docs/protocol/flows`](../../../docs/protocol/flows); the per-namespace examples in this guide track the same vocabulary.

**Four return shapes.** Method return types follow a predictable convention:

| Shape | Naming | When to reach for it |
|---|---|---|
| `Promise<T>` | past-tense or short noun (`mark.annotation`, `auth.password`) | atomic backend ops — one round-trip, one value |
| `StreamObservable<T>` | plain verb (`mark.assist`, `gather.annotation`) | long-running progress streams — `await` for the final value, `.subscribe(...)` for every emit |
| `CacheObservable<T>` | plain noun (`browse.resource`, `browse.annotations`) | live queries — `await` for the loaded value, `.subscribe(...)` for loading-then-loaded re-emits |
| `void` | imperative or progressive verb (`beckon.hover`, `mark.changeShape`) | collaboration signals — fire-and-forget onto the bus, observed by other participants |

Both Observable subclasses implement `PromiseLike<T>`, so `await` works without learning RxJS. Reach for `.subscribe(...)` when you want progress events or live updates. Full design in [REACTIVE-MODEL.md](./REACTIVE-MODEL.md).

**Collaboration primitives.** The fourth row above — `void`-returning collaboration signals (`beckon.hover`, `mark.changeShape`, `bind.initiate`, `browse.click`) — is the SDK's distinctive contribution to multi-participant coordination. They look fire-and-forget at the call site; on the bus they fan out across every participant. A human hovers; an AI agent reacts. An agent emits a sparkle; a human's UI lights up. This is *protocol-level* coordination on the same typed namespace surface as data operations. Observers reach the same signals via `session.subscribe(channel, handler)` or `client.bus.get(channel)` — see [`REACTIVE-MODEL.md` § Three paths to the bus](./REACTIVE-MODEL.md#three-paths-to-the-bus).

## Setup

There are four idiomatic construction shapes, by audience:

### One-shot scripts with credentials: `SemiontClient.signInHttp(...)`

The credentials-first one-line construction. Calls `auth.password(email, password)` and returns a wired-up client with the access token populated.

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signInHttp({
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});

// ...use semiont.browse / mark / bind / gather / match / yield / etc.

semiont.dispose();
```

This is the right entry point for skills, CLI scripts, and any consumer that starts with email + password rather than a JWT already on hand. Throws on auth failure with no resources leaked.

### Long-running scripts with credentials: `SemiontSession.signInHttp(...)`

Same credentials shape, plus the session machinery: proactive refresh (using the refresh token returned by `auth.password`, automatically wired), validation, storage persistence, lifecycle observables.

`kb` is required. Its `id` is the storage key for this session — distinct scripts sharing the same `SessionStorage` instance must use distinct `id`s to avoid trampling each other's tokens. The factory does not synthesize a default; the consumer makes the choice.

```typescript
import { SemiontSession, InMemorySessionStorage, type KnowledgeBase } from '@semiont/sdk';

const kb: KnowledgeBase = {
  id: 'my-watcher',
  label: 'My Watcher',
  email: 'me@example.com',
  endpoint: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' },
};

const session = await SemiontSession.signInHttp({
  kb,
  storage: new InMemorySessionStorage(),
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});

// session.client is the same SemiontClient surface; the session manages
// the access-token lifecycle around it (proactive refresh, validation,
// storage-adapter wiring).
```

`KnowledgeBase` is a uniform shape regardless of transport kind. The transport-specific connection details live in the nested `endpoint` discriminated union (`{ kind: 'http', host, port, protocol }` for HTTP backends, `{ kind: 'local', kbId }` for in-process). Code that doesn't construct transports never inspects `endpoint`.

The default `refresh` callback uses the refresh token returned by `auth.password`. Override only for non-standard refresh flows (worker-pool shared secret, OAuth refresh-token grant, interactive re-prompt).

### Already-have-a-token: `SemiontClient.fromHttp(...)` / `SemiontSession.fromHttp(...)`

For consumers that already hold a JWT (CLI cached-token path, env-var token, embedded auth flow that produced one elsewhere), skip the auth round-trip:

```typescript
import { SemiontClient, SemiontSession, InMemorySessionStorage } from '@semiont/sdk';

// One-shot
const semiont = SemiontClient.fromHttp({
  baseUrl: 'http://localhost:4000',
  token: 'your-jwt',
});

// Long-running — supply your own refresh callback
const session = SemiontSession.fromHttp({
  kb: {
    id: 'local',
    label: 'Local Backend',
    email: 'me@example.com',
    endpoint: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' },
  },
  storage: new InMemorySessionStorage(),
  baseUrl: 'http://localhost:4000',
  token: 'your-jwt',
  refresh: async () => /* return new access token, or null */ null,
});
await session.ready;
```

The session factory owns the load-bearing "same `BehaviorSubject` instance flows into both transport and session" invariant for you — there is no separate `token$` to thread.

### Manual construction (advanced)

When you need direct control of `token$`, an alternate transport (`LocalTransport` from `@semiont/make-meaning`, a future `GrpcTransport`, etc.), or to inject a `tokenRefresher` callback at the transport level, construct each piece by hand:

```typescript
import { SemiontClient, HttpTransport, HttpContentTransport } from '@semiont/sdk';
import { baseUrl, accessToken, type AccessToken } from '@semiont/sdk';
import { BehaviorSubject } from 'rxjs';

const token$ = new BehaviorSubject<AccessToken | null>(accessToken('your-jwt'));
const transport = new HttpTransport({ baseUrl: baseUrl('http://localhost:4000'), token$ });
// HttpTransport implements both ITransport and IBackendOperations; passing it
// as the third arg wires `client.auth` and `client.admin`. Non-HTTP transports
// implement only ITransport — omit the third arg and `client.auth` / `.admin`
// are `undefined`.
const semiont = new SemiontClient(transport, new HttpContentTransport(transport), transport);

// Update token from outside
token$.next(accessToken(newToken));
```

`@semiont/sdk` re-exports the brand-cast functions (`accessToken`, `baseUrl`, `resourceId`, `annotationId`, `entityType`) and the common branded types from `@semiont/core` for one-import convenience.

### Public bus access

The client does **not** expose `emit / on / stream` methods. All bus traffic flows through typed namespace methods (`semiont.mark.archive(...)`, `semiont.browse.resource(...)`, etc.). The single sanctioned escape hatch for arbitrary-channel subscription is `session.subscribe(channel, handler)`, available when you go through `SemiontSession`.

## Browse

Browse methods read from materialized views. Live queries return `CacheObservable<T>` — an Observable subclass that's also awaitable. `await` resolves to the loaded value (skipping the initial `undefined` "loading" state); `.subscribe(...)` yields the full sequence so reactive consumers can render a loading state.

### Awaitable observables

Streaming methods (`mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`) return `StreamObservable<T>`; live-query methods (`browse.resource`, `browse.resources`, `browse.annotations`, `browse.annotation`, `browse.referencedBy`, `browse.events`, `browse.entityTypes`) return `CacheObservable<T>`. Both are `Observable<T>` subclasses that implement `PromiseLike<T>` — `await` works directly, `.subscribe(...)` yields the full sequence, `.pipe(...)` composes with RxJS operators (and loses the thenable). See [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) for the design rationale and method-by-method assignment.

### Live Queries (subscribe)

```typescript
// Subscribe to a resource — re-emits on yield:updated, mark:archived, etc.
semiont.browse.resource(resourceId).subscribe((resource) => {
  console.log('Resource:', resource?.name);   // resource: ResourceDescriptor | undefined
});

// Subscribe to annotations — re-emits on mark:added, mark:removed, mark:body-updated
semiont.browse.annotations(resourceId).subscribe((annotations) => {
  console.log('Annotations:', annotations?.length);
});

// Subscribe to entity types — re-emits on frame:entity-type-added (global stream)
semiont.browse.entityTypes().subscribe((types) => {
  console.log('Entity types:', types);
});

// One-shot read — await directly, no firstValueFrom wrapper needed.
const resource = await semiont.browse.resource(resourceId);   // resource: ResourceDescriptor
```

### One-Shot Reads (Promise)

```typescript
// Text content
const content = await semiont.browse.resourceContent(resourceId);

// Binary representation
const { data, contentType } = await semiont.browse.resourceRepresentation(resourceId, {
  accept: 'image/png',
});

// Event history
const events = await semiont.browse.resourceEvents(resourceId);

// Annotation history
const history = await semiont.browse.annotationHistory(resourceId, annotationId);

// File browser
const files = await semiont.browse.files('/docs', 'mtime');
```

## Frame

The schema-layer flow. Frame operates on the KB's conceptual vocabulary — what *kinds* of things exist (entity types) and what structural-analysis taxonomies are recognized (tag schemas). Where the other seven flows act on content, Frame acts on the schema layer the content is expressed in. Live reads of either vocabulary stay on Browse (`browse.entityTypes()`, `browse.tagSchemas()`) — Frame owns writes; Browse owns reads.

### Entity types

```typescript
// Add a single entity type
await semiont.frame.addEntityType('Person');

// Add multiple in one call
await semiont.frame.addEntityTypes(['Location', 'Organization', 'Event']);

// Live-read the current vocabulary (lives on Browse, not Frame)
semiont.browse.entityTypes().subscribe((types) => {
  console.log('Current vocabulary:', types);
});
```

Adding the same entity type twice is idempotent — the backend dedupes; the second `frame:add-entity-type` for an existing tag is a no-op.

### Tag schemas

Tag schemas are structural-analysis frameworks (IRAC, IMRAD, Toulmin, custom). They're **runtime-registered per knowledge base** — the SDK ships the type, the KB owns the schema data and registers it via `frame.addTagSchema(...)` at session/skill startup. The dispatcher embeds the resolved schema in worker job params at job-creation time, so an unknown `schemaId` rejects synchronously with `Tag schema not registered: <id>`.

```typescript
import type { TagSchema } from '@semiont/sdk';

// Define the schema (typically lives in your KB's `src/tag-schemas.ts`).
const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue / Rule / Application / Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    { name: 'Issue',       description: 'The legal question to be resolved',  examples: ['What must the court decide?'] },
    { name: 'Rule',        description: 'The relevant law or legal principle', examples: ['What law applies?'] },
    { name: 'Application', description: 'How the rule applies to the facts',  examples: ['How does the law apply here?'] },
    { name: 'Conclusion',  description: 'The resolution',                       examples: ['What is the holding?'] },
  ],
};

// Register at startup. Idempotent — re-runs with identical content
// are silent at the projection layer; differing content overwrites
// and logs a warning.
await semiont.frame.addTagSchema(LEGAL_IRAC_SCHEMA);

// Now mark.assist with motivation 'tagging' can use it.
await semiont.mark.assist(rId, 'tagging', {
  schemaId: LEGAL_IRAC_SCHEMA.id,
  categories: LEGAL_IRAC_SCHEMA.tags.map((t) => t.name),
});

// Live-read registered schemas (Browse, not Frame). The cache
// invalidates on `frame:tag-schema-added` so it stays current as new
// schemas land.
semiont.browse.tagSchemas().subscribe((schemas) => {
  console.log('Registered schemas:', schemas.map((s) => s.id));
});
```

For the full per-flow contract — including the `__system__`-stream event-sourcing layer, projection materialization, and "most-recent wins + log warning" conflict semantics — see [`docs/protocol/flows/FRAME.md`](../../../docs/protocol/flows/FRAME.md). For deferred schema-evolution work (rename / remove / version / migrate), see [`.plans/EVOLVE-TAG-SCHEMA.md`](../../../.plans/EVOLVE-TAG-SCHEMA.md).

## Mark

Commands return Promises that resolve on backend acceptance. Results appear on browse Observables via the bus gateway. `mark.annotation` takes the W3C-shaped annotation directly — `target.source` is the resource the annotation is anchored on, and the resulting `annotationId` is already branded so you can pass it to other namespace methods (`bind.body`, `gather.annotation`, etc.) without a manual cast.

For entity-type vocabulary writes, see [Frame](#frame) — those moved off Mark when Frame was promoted to flow status.

```typescript
// Create an annotation. The wire layer derives `resourceId` from
// `input.target.source`.
const { annotationId } = await semiont.mark.annotation({
  motivation: 'highlighting',
  target: {
    source: resourceId,
    selector: [
      { type: 'TextPositionSelector', start: 0, end: 11 },
      { type: 'TextQuoteSelector', exact: 'Hello World' },
    ],
  },
  // highlighting annotations carry no body — motivation + target is
  // the whole annotation per the W3C Web Annotation Model.
});

// Delete an annotation
await semiont.mark.delete(resourceId, annotationId);

// Archive / unarchive
await semiont.mark.archive(resourceId);
await semiont.mark.unarchive(resourceId);

// AI-assisted annotation — StreamObservable<MarkAssistEvent>: subscribe
// for progress, await for the final event.
semiont.mark.assist(resourceId, 'linking', {
  entityTypes: ['Person', 'Organization'],
}).subscribe({
  next: (event) => console.log(event.type, event),
  error: (err) => console.error('Failed:', err.message),
  complete: () => console.log('Done'),
});
```

## Bind

One method. The result arrives on `semiont.browse.annotations()` via the enriched `mark:body-updated` event.

```typescript
await semiont.bind.body(resourceId, annotationId, [
  { op: 'add', item: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' } },
]);
```

## Gather

Long-running. Returns Observable with progress then gathered context.

```typescript
semiont.gather.annotation(annotationId, resourceId, { contextWindow: 2000 }).subscribe({
  next: (progress) => {
    if ('response' in progress) {
      console.log('Context:', progress.response.context);
    } else {
      console.log(`Gathering: ${progress.percentage}%`);
    }
  },
  error: (err) => console.error('Failed:', err.message),
});
```

## Match

Long-running. Returns a `StreamObservable` of scored results — `await` for the final emission, or `subscribe` for streaming progress. `referenceId` is typed as `AnnotationId` (the annotation containing the reference body to search candidates for).

```typescript
semiont.match.search(resourceId, referenceId, gatheredContext, {
  limit: 10,
  useSemanticScoring: true,
}).subscribe({
  next: (result) => {
    console.log('Results:', result.response);
  },
});
```

## Yield

```typescript
// File upload — UploadObservable: subscribe for the upload lifecycle
// (`started` → optional `progress` → `finished`); await for `{ resourceId }`.
const { resourceId } = await semiont.yield.resource({
  name: 'My Document',
  file: new File([content], 'doc.md'),
  format: 'text/markdown',
  storageUri: 'file://docs/doc.md',
});

// AI generation from annotation — StreamObservable<YieldGenerationEvent>:
// subscribe for progress, await for the final event. The optional
// `entityTypes` are stamped on the synthesized resource (so
// `browse.resources({ entityType: 'Character' })` finds it) and also
// fed into the LLM prompt as a topical bias.
semiont.yield.fromAnnotation(resourceId, annotationId, {
  title: 'Generated Summary',
  storageUri: 'file://generated/summary.md',
  context: gatheredContext,
  entityTypes: ['Character', 'Hero'],
}).subscribe({
  next: (event) => console.log(event.type, event),
  complete: () => console.log('Resource generated'),
});

// Clone
const { token } = await semiont.yield.cloneToken(resourceId);
const source = await semiont.yield.fromToken(token);
await semiont.yield.createFromToken({ token, name: 'Clone', /* ... */ });
```

## Beckon

Fire-and-forget. Ephemeral presence signal.

```typescript
semiont.beckon.attention(annotationId, resourceId);
```

## Auth

Like `admin`, the `auth` namespace lives on `IBackendOperations` and is `undefined` on a `SemiontClient` constructed without a backend. HTTP-context callers narrow with `!`:

```typescript
const auth = await semiont.auth!.password('user@example.com', 'password');
const auth = await semiont.auth!.google(credential);
const auth = await semiont.auth!.refresh(refreshToken);
await semiont.auth!.logout();
const user = await semiont.auth!.me();
await semiont.auth!.acceptTerms();
const { token } = await semiont.auth!.mediaToken(resourceId);
```

For credentials-first construction, prefer `SemiontClient.signInHttp({ baseUrl, email, password })` over calling `auth!.password(...)` directly — the factory wires the resulting token into `token$` for you.

## Admin

The `admin` namespace lives on `IBackendOperations`. A `SemiontClient` constructed with a backend (e.g. `fromHttp` / `signInHttp`) has `client.admin: AdminNamespace`; one constructed without a backend has `client.admin: undefined`. HTTP-context callers narrow with `!`:

```typescript
const users = await semiont.admin!.users();
const stats = await semiont.admin!.userStats();
await semiont.admin!.updateUser(userId, { isAdmin: true });
const config = await semiont.admin!.oauthConfig();
const health = await semiont.admin!.healthCheck();

// Backup / export — return BackendDownload: { stream, contentType, filename? }.
// The stream is a transport-neutral ReadableStream<Uint8Array>; wrap in
// `new Response(stream)` to convert to a Blob for browser download.
const backup = await semiont.admin!.backup();
const blob = await new Response(backup.stream).blob();
const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = backup.filename ?? `kb-backup-${Date.now()}.tar.gz`;
link.click();

// Restore / import — StreamObservable<ProgressEvent>: subscribe for each
// progress phase; await for the final event.
semiont.admin!.restore(file).subscribe({
  next: (event) => console.log(`${event.phase}: ${event.message ?? ''}`),
  complete: () => console.log('Restore complete'),
  error: (err) => console.error('Restore failed:', err.message),
});

// Import (alt-scope export/import follow the same shapes)
await semiont.admin!.exportKnowledgeBase({ includeArchived: true });
semiont.admin!.importKnowledgeBase(file).subscribe(/* ... */);
```

## Job

```typescript
const status = await semiont.job.status(jobId);
const final = await semiont.job.pollUntilComplete(jobId, {
  onProgress: (s) => console.log(s.status),
});
```

## Bus Connection

For HTTP transports, the client lazily opens a single SSE connection to `/bus/subscribe`. Result channels, global domain events, and resource-scoped fan-out all flow through it. For in-process transports, the bus is the in-memory `EventBus` from `@semiont/core`. Either way, the namespace methods hide the wire.

To receive live updates for a specific resource:

```typescript
// Adds resource-scoped channels to the transport's subscription set and
// bridges them into the client's local EventBus so `semiont.browse.*`
// Observables update in real-time. Call on mount; call the returned
// cleanup function on unmount. Ref-counted across overlapping calls.
const cleanup = semiont.subscribeToResource(resourceId);

// ... later
cleanup();
```

For HTTP, the underlying connection auto-reconnects with exponential backoff. On reconnect, `BrowseNamespace` invalidates active caches and refetches — no `Last-Event-ID` replay needed.

### Worker / actor adapters

Worker-side adapters live with their domain and consume the transport-neutral `WorkerBus` interface that `@semiont/sdk` exports. `createJobClaimAdapter` and `createJobQueueStateUnit` are in `@semiont/jobs`; `createSmelterActorStateUnit` is in `@semiont/make-meaning`. `WorkerBus` is a small contract (`on$(channel)`, `emit(channel, payload)`, optional `addChannels(...)`). The HTTP `ActorStateUnit` from `@semiont/api-client` satisfies it structurally; an in-process worker can wrap an `EventBus` in a small shim. Workers today reach for the HTTP actor like this:

```typescript
import type { HttpTransport } from '@semiont/api-client';
import { createJobClaimAdapter } from '@semiont/jobs';

// session.client.transport is the bus-shaped ITransport. For HTTP-backed
// workers, narrow to HttpTransport to access the underlying ActorStateUnit.
const httpTransport = session.client.transport as HttpTransport;
const adapter = createJobClaimAdapter({
  bus: httpTransport.actor,
  jobTypes: ['generation', 'reference-annotation'],
});
adapter.start();
```

The cast names the seam: today only HTTP workers exist. The adapter itself is transport-neutral — when an in-process worker emerges, it builds its own `WorkerBus` shim and the cast goes away.

## Debugging the bus

When something on the bus is silently not happening — a job-claim worker that isn't claiming, an SSE connection that dropped, a `mark:create` emit that didn't reach the backend — there are two complementary tools.

**Wire-level event logging (Tier 1 of the observability stack).** Every event that crosses a transport boundary is logged as a single grep-friendly line on stdout / `console.debug`:

```
[bus EMIT] mark:create [scope=res-abc] [cid=a89a670a] {annotation: ..., userId: ...}
[bus RECV] mark:added  [scope=res-abc] [cid=a89a670a] {annotation: ..., ...}
```

Toggle:

```bash
SEMIONT_BUS_LOG=1 <command>          # Node (backend, workers, smelter, CLI, MCP, scripts)
window.__SEMIONT_BUS_LOG__ = true;   # Browser (DevTools or e2e init)
```

Cost when disabled: a single truthy check, zero allocations. Five op codes — `EMIT`, `RECV`, `SSE`, `PUT`, `GET` — cover every transport-level write and read. Failure modes are diagnosable from a missing line: backend `EMIT` missing → request never reached the server; backend `SSE` missing → handler emitted no result; frontend `RECV` missing → server wrote but bytes never parsed client-side. The full guide with the timeline format and e2e capture API is at [`tests/e2e/docs/bus-logging.md`](../../../tests/e2e/docs/bus-logging.md).

When OpenTelemetry is initialized (Tier 2), every bus-log line gets a `trace=<8hex>` suffix that correlates the grep timeline with the trace UI.

**Runtime SSE health.** For a long-running worker or daemon, subscribe to the transport's connection-state observable to surface health in your status endpoint:

```typescript
import { HttpTransport } from '@semiont/api-client';
import type { ConnectionState } from '@semiont/core';

const httpTransport = session.client.transport as HttpTransport;

httpTransport.state$.subscribe((state: ConnectionState) => {
  // 'initial' | 'connecting' | 'open' | 'reconnecting' | 'degraded' | 'closed'
  logger.info('transport state', { state });
});
```

`degraded` is the threshold to escalate — it means the SSE has been reconnecting for >`DEGRADED_THRESHOLD_MS` and isn't a brief mount-churn cycle. `closed` is terminal (`stop()` / `dispose()` was called).

**Worker-specific gotcha.** A job-claim adapter widens the SSE channel set on `start()` to include `job:queued` and the other channels it needs. If your worker is silently doing nothing, the most common cause is `adapter.start()` not being called — `SEMIONT_BUS_LOG=1` makes this immediately visible (no `RECV job:queued` lines).

## Error Handling

Every error thrown through the SDK extends `SemiontError`, the unified base from `@semiont/core` (re-exported from `@semiont/sdk`). It carries a discriminated `code` field plus `details`. Each error class tightens `code` to a specific literal union.

Transport-level errors (HTTP `APIError`, future gRPC `GrpcError`, etc.) all map their native failure codes to a transport-neutral vocabulary `TransportErrorCode` so a routing layer doesn't have to know which transport produced the error:

| `code` | Meaning | Typical HTTP status |
|---|---|---|
| `unauthorized` | auth required / token missing or expired | 401 |
| `forbidden` | auth ok but lacks permission | 403 |
| `not-found` | resource missing | 404 |
| `conflict` | concurrent modification, duplicate, etc. | 409 |
| `bad-request` | request malformed | 400 |
| `unavailable` | backend unreachable, network error | 5xx |
| `error` | unclassified fallback | other |

Bus-layer and session-layer errors keep their own code namespaces:

| Class | Codes | Thrown by |
|---|---|---|
| `APIError` (extends `SemiontError`) | `TransportErrorCode` (above) — plus `APIError.status` for the original HTTP status | HTTP transport (`@semiont/api-client`) |
| `BusRequestError` | `bus.timeout`, `bus.rejected`, `bus.bad-payload`, `bus.unauthorized`, `bus.forbidden`, `bus.not-found` | bus-mediated commands inside namespaces |
| `SemiontSessionError` | `session.auth-failed`, `session.refresh-exhausted`, `session.construct-failed` | the session layer — surfaced on `SemiontBrowser.error$`, not as a per-call rejection |

Catch broadly on `SemiontError` and route on `code`; reach for `APIError` (imported from `@semiont/api-client`) only when a handler genuinely needs HTTP-specific fields like `status`.

```typescript
import { SemiontError, BusRequestError } from '@semiont/sdk';

try {
  await semiont.mark.annotation(input);
} catch (error) {
  if (error instanceof BusRequestError) {
    if (error.code === 'bus.timeout') {
      console.error(`Bus request timed out: ${error.message}`);
    } else {
      console.error(`Bus rejected (${error.code}): ${error.message}`);
    }
  } else if (error instanceof SemiontError) {
    // `code` is from `TransportErrorCode` for transport-layer errors,
    // bus-specific for `BusRequestError`, session-specific for
    // `SemiontSessionError`.
    if (error.code === 'unauthorized') {
      // log in / show session-expired modal
    } else if (error.code === 'forbidden') {
      // surface permission-denied
    } else {
      console.error(`Semiont error (${error.code}): ${error.message}`);
    }
  } else {
    throw error;
  }
}
```

`APIError` is *not* re-exported from `@semiont/sdk` — it's transport-specific. Catch on `SemiontError` and route on the neutral code; reach for `APIError` directly only in HTTP-aware code that needs `error.status`:

```typescript
import { APIError } from '@semiont/api-client';

if (error instanceof APIError) {
  console.error(`HTTP ${error.status} (${error.code}): ${error.message}`);
}
```

`SemiontSessionError` is asynchronous — it reaches you through `SemiontBrowser.error$`, not as a thrown rejection on a namespace call. The transport-level `errors$` stream (`client.transport.errors$`) carries every transport-mediated error just before it's thrown, so a host layer (e.g. `SemiontBrowser`'s session-expired / permission-denied modal routing) can subscribe once and surface them globally.

## Logging

`HttpTransport` accepts an optional `logger` (`winston`, `pino`, or any `Logger`-shaped object from `@semiont/core`). The transport emits structured request/response logs through it:

```typescript
import { HttpTransport, HttpContentTransport } from '@semiont/api-client';
import { SemiontClient } from '@semiont/sdk';
import { baseUrl } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

const transport = new HttpTransport({
  baseUrl: baseUrl('http://localhost:4000'),
  token$: new BehaviorSubject(null),
  logger,    // Logger instance: winston / pino / etc.
});
const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
```

The factory shorthands (`fromHttp` / `signInHttp`) don't currently expose a `logger` parameter; use manual construction when you need transport-level logging.
