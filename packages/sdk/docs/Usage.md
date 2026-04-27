# `@semiont/sdk` Usage Guide

## Table of Contents

- [Setup](#setup)
- [Browse — Reading Resources and Annotations](#browse)
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

## Setup

There are four idiomatic construction shapes, by audience:

### One-shot scripts with credentials: `SemiontClient.signIn(...)`

The credentials-first one-line construction. Calls `auth.password(email, password)` and returns a wired-up client with the access token populated.

```typescript
import { SemiontClient } from '@semiont/sdk';

const semiont = await SemiontClient.signIn({
  baseUrl: 'http://localhost:4000',
  email: 'me@example.com',
  password: 'pwd',
});

// ...use semiont.browse / mark / bind / gather / match / yield / etc.

semiont.dispose();
```

This is the right entry point for skills, CLI scripts, and any consumer that starts with email + password rather than a JWT already on hand. Throws on auth failure with no resources leaked.

### Long-running scripts with credentials: `SemiontSession.signIn(...)`

Same credentials shape, plus the session machinery: proactive refresh (using the refresh token returned by `auth.password`, automatically wired), validation, storage persistence, lifecycle observables.

`kb` is required. Its `id` is the storage key for this session — distinct scripts sharing the same `SessionStorage` instance must use distinct `id`s to avoid trampling each other's tokens. The factory does not synthesize a default; the consumer makes the choice.

```typescript
import { SemiontSession, InMemorySessionStorage, type KnowledgeBase } from '@semiont/sdk';

const kb: KnowledgeBase = {
  id: 'my-watcher',
  label: 'My Watcher',
  protocol: 'http',
  host: 'localhost',
  port: 4000,
  email: 'me@example.com',
};

const session = await SemiontSession.signIn({
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
  kb: { id: 'local', label: 'Local Backend', protocol: 'http', host: 'localhost', port: 4000, email: 'me@example.com' },
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
const semiont = new SemiontClient(transport, new HttpContentTransport(transport));

// Update token from outside
token$.next(accessToken(newToken));
```

`@semiont/sdk` re-exports the brand-cast functions (`accessToken`, `baseUrl`, `resourceId`, `annotationId`, `entityType`) and the common branded types from `@semiont/core` for one-import convenience.

### Public bus access

The client does **not** expose `emit / on / stream` methods. All bus traffic flows through typed namespace methods (`semiont.mark.archive(...)`, `semiont.browse.resource(...)`, etc.). The single sanctioned escape hatch for arbitrary-channel subscription is `session.subscribe(channel, handler)`, available when you go through `SemiontSession`.

## Browse

Browse methods read from materialized views. Live queries return `CacheObservable<T>` — an Observable subclass that's also awaitable. `await` resolves to the loaded value (skipping the initial `undefined` "loading" state); `.subscribe(...)` yields the full sequence so reactive consumers can render a loading state.

### Awaitable observables

The streaming and live-query namespace methods on `SemiontClient` return one of two thenable Observable subclasses, both of which implement `PromiseLike<T>`:

- `StreamObservable<T>` — for bounded streams (`mark.assist`, `gather.annotation`, `match.search`, `yield.fromAnnotation`). `await` resolves to the **last** emitted value on completion.
- `CacheObservable<T>` — for live queries (`browse.resource`, `browse.resources`, `browse.annotations`, `browse.annotation`, `browse.referencedBy`, `browse.events`, `browse.entityTypes`). `await` resolves to the **first non-undefined** value (skipping the loading state).

Either subclass can be `.subscribe(...)`d like a plain Observable. `.pipe(...)` returns a plain `Observable<T>` — once you compose with RxJS operators you've explicitly opted into RxJS land, and `lastValueFrom` from `rxjs` is the right bridge for awaiting the result. The `firstValueFrom`/`lastValueFrom` re-exports from `@semiont/sdk` stay available for that case.

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

// Subscribe to entity types — re-emits on mark:entity-type-added (global stream)
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

## Mark

Commands return Promises that resolve on HTTP acceptance. Results appear on browse Observables via the bus gateway.

```typescript
// Create an annotation
const { annotationId } = await semiont.mark.annotation(resourceId, {
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

// Add entity types
await semiont.mark.entityType('Person');
await semiont.mark.entityTypes(['Location', 'Organization']);

// Archive / unarchive
await semiont.mark.archive(resourceId);
await semiont.mark.unarchive(resourceId);

// AI-assisted annotation (Observable with progress)
semiont.mark.assist(resourceId, 'linking', {
  entityTypes: ['Person', 'Organization'],
}).subscribe({
  next: (progress) => console.log(`${progress.status}: ${progress.percentage}%`),
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

Long-running. Returns Observable with scored results.

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
// File upload (synchronous)
const { resourceId } = await semiont.yield.resource({
  name: 'My Document',
  file: new File([content], 'doc.md'),
  format: 'text/markdown',
  storageUri: 'file://docs/doc.md',
});

// AI generation from annotation (Observable with progress)
semiont.yield.fromAnnotation(resourceId, annotationId, {
  title: 'Generated Summary',
  storageUri: 'file://generated/summary.md',
  context: gatheredContext,
}).subscribe({
  next: (p) => console.log(`${p.status}: ${p.percentage}%`),
  complete: () => console.log('Resource generated'),
});

// Clone
const { token } = await semiont.yield.cloneToken(resourceId);
const source = await semiont.yield.fromToken(token);
await semiont.yield.createFromToken({ token, name: 'Clone', ... });
```

## Beckon

Fire-and-forget. Ephemeral presence signal.

```typescript
semiont.beckon.attention(annotationId, resourceId);
```

## Auth

```typescript
const auth = await semiont.auth.password('user@example.com', 'password');
const auth = await semiont.auth.google(credential);
const auth = await semiont.auth.refresh(refreshToken);
await semiont.auth.logout();
const user = await semiont.auth.me();
await semiont.auth.acceptTerms();
```

## Admin

```typescript
const users = await semiont.admin.users();
const stats = await semiont.admin.userStats();
await semiont.admin.updateUser(userId, { isAdmin: true });
const config = await semiont.admin.oauthConfig();
const health = await semiont.admin.healthCheck();
```

## Job

```typescript
const status = await semiont.job.status(jobId);
const final = await semiont.job.pollUntilComplete(jobId, {
  onProgress: (s) => console.log(s.status),
});
```

## Bus Connection

The client lazily creates one `ActorVM` that opens a single SSE
connection to `/bus/subscribe`. All subscriptions — result channels,
global events, resource-scoped domain events — flow through it.

To receive live updates for a specific resource:

```typescript
// Adds resource-scoped channels to the bus subscription and bridges
// them into the local EventBus so `semiont.browse.*` Observables
// update in real-time. Call on mount; call the returned cleanup
// function on unmount.
const cleanup = semiont.subscribeToResource(resourceId);

// ... later
cleanup();
```

The ActorVM auto-reconnects with exponential backoff. On reconnect
after a disconnect, `BrowseNamespace` invalidates all active caches
and refetches — no Last-Event-ID replay needed.

For direct access (advanced use — CLI, workers, smelter):

```typescript
import { createActorVM } from '@semiont/api-client';

const actor = createActorVM({
  baseUrl,
  token,
  channels: ['my:channel'],
});
actor.start();
actor.on$('my:channel').subscribe((payload) => { ... });
await actor.emit('another:channel', { ... });
actor.dispose();
```

## Error Handling

```typescript
import { APIError } from '@semiont/api-client';

try {
  await semiont.mark.annotation(resourceId, input);
} catch (error) {
  if (error instanceof APIError) {
    console.error(`${error.status}: ${error.message}`);
  }
}
```

## Logging

```typescript
const semiont = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  eventBus: new EventBus(),
  token$,
  logger, // winston, pino, etc.
});
```

See [Logging Guide](./LOGGING.md) for details.
