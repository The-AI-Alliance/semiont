# API Client Usage Guide

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

```typescript
import { SemiontApiClient } from '@semiont/api-client';
import { baseUrl, accessToken, type AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

const token$ = new BehaviorSubject<AccessToken | null>(accessToken(myToken));

const client = new SemiontApiClient({
  baseUrl: baseUrl('http://localhost:4000'),
  token$,
});
```

Each client owns a private `EventBus`. No `eventBus` parameter is
needed or accepted — all bus traffic happens through
`client.emit(channel, payload)`, `client.on(channel, handler)`, and
`client.stream(channel)`.

All namespace calls and the bus SSE connection read the current value
from `token$`. Update by calling `.next(newToken)` — the client's bus
actor reconnects with the new token automatically.

```typescript
// After token refresh
token$.next(accessToken(newToken));
```

Omit `token$` for unauthenticated usage (public endpoints only). The
bus actor will not connect until a non-null token is available.

### In apps that use `SemiontBrowser`

When the app lives behind `SemiontBrowser` (browser / CLI / MCP), you
rarely construct the client directly. The browser owns the
`SemiontSession`, which owns the client:

```ts
import { SemiontBrowser, InMemorySessionStorage } from '@semiont/api-client';

const browser = new SemiontBrowser({ storage: new InMemorySessionStorage() });
await browser.addKb({ ... });
await browser.signIn(kbId, accessToken, refreshToken);

const session = browser.activeSession$.getValue()!;
session.client.emit('mark:create-request', { ... });
```

See [SESSION.md in `@semiont/react-ui`](../../react-ui/docs/SESSION.md)
for the full class model, including the second (app-scoped) bus on
`SemiontBrowser` for `panel:*` / `shell:*` / `tabs:*` / `nav:*` /
`settings:*` channels.

## Browse

Browse methods read from materialized views. Live queries return Observables that emit initial state and re-emit when the bus gateway delivers relevant domain events.

### Live Queries (Observable)

```typescript
import { firstValueFrom } from 'rxjs';

// Subscribe to a resource — re-emits on yield:updated, mark:archived, etc.
semiont.browse.resource(resourceId).subscribe((resource) => {
  console.log('Resource:', resource?.name);
});

// Subscribe to annotations — re-emits on mark:added, mark:removed, mark:body-updated
semiont.browse.annotations(resourceId).subscribe((annotations) => {
  console.log('Annotations:', annotations?.length);
});

// Subscribe to entity types — re-emits on mark:entity-type-added (global stream)
semiont.browse.entityTypes().subscribe((types) => {
  console.log('Entity types:', types);
});

// One-shot read from Observable
const resource = await firstValueFrom(semiont.browse.resource(resourceId));
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
