# Developer Guide — building with the Semiont SDK

Task-oriented recipes for building a real system on `@semiont/sdk`, in roughly the order
you'll need them. Each recipe is a short description of the capability followed by the
lines of TypeScript that exercise it.

This is the **how-to** doc. For the exhaustive per-namespace surface see
[Usage.md](./Usage.md) (reference); for *why* the surface is shaped the way it is —
RxJS substrate, the four return shapes, the three paths to the bus — see
[REACTIVE-MODEL.md](./REACTIVE-MODEL.md) (explanation). Recipes here link into both rather
than repeat them.

Throughout, the eight verb namespaces hang off `session.client` — `session.client.browse`,
`session.client.gather`, and so on.

---

## 1. Connect — and stay connected

For anything longer than a one-shot script, use **`SemiontSession`**: it refreshes the
bearer token in the background, so long-running work doesn't die at the token TTL (a raw
`SemiontClient` does). Supply a `SessionStorage` — `InMemorySessionStorage` for Node/scripts,
a `localStorage`-backed one for the browser — and `dispose()` when done.

```typescript
import { SemiontSession, httpKb, InMemorySessionStorage } from '@semiont/sdk';

const session = await SemiontSession.signInHttp({
  kb: httpKb({ id: 'my-app', label: 'My KB', email, host: 'localhost', port: 4000, protocol: 'http' }),
  storage: new InMemorySessionStorage(),   // browser: a localStorage-backed SessionStorage
  baseUrl: 'http://localhost:4000',
  email,
  password,
});

// … use session.client.{browse,gather,yield,mark,bind,match,frame,beckon} …

await session.dispose();
```

A one-shot script that just needs a few calls and exits can use the lighter
`SemiontClient.signInHttp({ baseUrl, email, password })` (no token refresh, no `kb`). Already
hold a JWT? Use the `fromHttp(...)` variants. → [Usage § Setup](./Usage.md#setup).

## 2. Consume a call — `await`, `.subscribe`, and the `.run()` rule

Every method returns a `Promise<T>` (one value) or one of three awaitable Observables:
`CacheObservable` (live queries), `StreamObservable` (progress streams), `UploadObservable`
(uploads). `await` gives the final/loaded value; `.subscribe(...)` gives every emission.

⚠️ The Observables are **cold** — do **not** both `.subscribe()` *and* `await` the same
instance. Each consumption re-runs the producer; for a job-triggering stream that fires the
job **twice**. To get progress *and* the terminal result from one execution, use **`.run(onNext)`**.

```typescript
const text = await session.client.browse.resourceContent(rId);          // one value

const sub = session.client.browse.annotations(rId)                      // live query
  .subscribe((anns) => render(anns));                                    //   (await for one-shot)

const done = await session.client.mark.assist(rId, 'linking', { entityTypes })
  .run((ev) => { if (ev.kind === 'progress') showProgress(ev.data); }); // progress + result, ONE run
```

→ [REACTIVE-MODEL.md](./REACTIVE-MODEL.md) for the four-shape design and await-vs-subscribe per method.

## 3. Read resources and annotations

`browse.*` reads from materialized views. The live queries return `CacheObservable` — `await`
for the loaded value (skips the `undefined` loading state), `.subscribe(...)` for
loading→loaded→re-emit. `resources(...)` takes filters; text and binary content are one-shot reads.

```typescript
const docs    = await session.client.browse.resources({ entityType: 'Concept', limit: 50 });
const content = await session.client.browse.resourceContent(rId);          // Promise<string>
const types   = await session.client.browse.entityTypes();                 // string[]

session.client.browse.annotations(rId).subscribe((anns) => render(anns));  // live, re-emits on change
```

Live subscriptions are how you get real-time updates: **freshness follows observation** —
subscribing to `browse.*(rId)` acquires that resource's event scope while observed and
releases it on the last unsubscribe. No separate "subscribe to resource" call. → [Usage § Bus Connection](./Usage.md#bus-connection).

## 4. Establish your vocabulary

Entity types are the backbone of enrichment and graph context; register the ones your system
uses (idempotent — re-adding is a no-op). Structured tagging additionally needs a registered
**tag schema**. Reads of either vocabulary stay on `browse`; `frame` owns the writes.

```typescript
await session.client.frame.addEntityTypes(['Person', 'Organization', 'Concept']);
await session.client.frame.addTagSchema(MY_TAG_SCHEMA);   // only if you'll mark.assist('tagging')
```

→ [Usage § Frame](./Usage.md#frame) for the tag-schema shape and conflict semantics.

## 5. Ingest a document

`yield.resource` creates a resource from uploaded bytes — any MIME type — and embeds it, so
it's retrievable immediately. `.run()` subscribes the cold upload once and forwards real
byte-progress; awaiting it resolves `{ resourceId }`.

```typescript
const { resourceId } = await session.client.yield.resource({
  name: 'Spec',
  file,                              // a browser File or a Node Buffer
  format: 'text/markdown',
  storageUri: 'file://docs/spec.md',
  entityTypes: ['Concept'],          // optional: stamped on the resource + biases later passes
}).run((ev) => {
  if (ev.phase === 'progress' && ev.totalBytes > 0) setPct(ev.bytesUploaded / ev.totalBytes);
});
```

## 6. Enrich it — entity linking and tagging

`mark.assist` runs an AI pass that writes annotations onto a resource: `'linking'` extracts
entity references (the connections later retrieval reads as graph context), `'tagging'` applies
a tag schema, plus `'highlighting'`/`'assessing'`/`'commenting'`. It's a long-running job —
`.run()` for progress; each progress snapshot names the entity type currently being detected.

```typescript
await session.client.mark.assist(resourceId, 'linking', { entityTypes: ['Person', 'Organization'] })
  .run((ev) => { if (ev.kind === 'progress') log(ev.data.currentEntityType); });

// structured tagging:
await session.client.mark.assist(resourceId, 'tagging', { schemaId: 'legal-irac', categories: [...] });
```

## 7. Gather context (retrieval)

`gather` assembles the context that grounds generation and search. **`gather.resource`** does
whole-resource, KB-wide retrieval and resolves a `GatheredContext` directly (a Promise — no
progress stream); **`gather.annotation`** anchors on a specific annotation and returns a
progress `StreamObservable` whose terminal carries the context. A `GatheredContext` bundles the
focus, a knowledge-graph slice, KB-wide semantic neighbors, and metadata.

```typescript
const context = await session.client.gather.resource(resourceId, {
  depth: 2,
  maxResources: 10,
  excludeEntityTypes: ['Question'],   // omit entity types from semantic recall
});

// anchored variant — the terminal event carries the GatheredContext on `.response`:
const ann = await session.client.gather.annotation(resourceId, annotationId, { contextWindow: 2000 });
```

## 8. Generate a derived resource

`yield.fromResource` / `yield.fromAnnotation` synthesize a **new resource** from a source,
grounded in a `GatheredContext`. The role is carried by `prompt` (translate, summarize,
answer, …); `outputMediaType` sets the result's format (default `text/markdown`). On
completion the worker mints a source→derived reference annotation, so provenance is automatic.
The generated resource id arrives on the terminal `complete` event.

```typescript
const done = await session.client.yield.fromResource(resourceId, {
  title: 'Summary',
  storageUri: 'file://generated/summary.md',
  context,                                   // from gather.resource — required, grounds the output
  prompt: 'Summarize, grounding every claim in the provided context.',
  entityTypes: ['Concept'],
  outputMediaType: 'text/markdown',
}).run((ev) => { if (ev.kind === 'progress') showProgress(ev.data); });

const newId =
  done.kind === 'complete' && done.data.result && 'resourceId' in done.data.result
    ? done.data.result.resourceId
    : undefined;
```

(`yield.fromAnnotation(resourceId, annotationId, options)` is the annotation-anchored twin —
same options.)

## 9. Create annotations and links directly

`mark.annotation` writes a W3C-shaped annotation. Anchor on a passage with a `selector`; for a
**whole-resource edge** (resource A links to resource B), give a `target` with `source` only
(no selector) and a `SpecificResource` body pointing at B. The returned `annotationId` is
branded — pass it straight to other methods.

```typescript
// passage highlight
const { annotationId } = await session.client.mark.annotation({
  motivation: 'highlighting',
  target: { source: rId, selector: [{ type: 'TextPositionSelector', start: 0, end: 11 }] },
});

// whole-resource edge: claim → source
await session.client.mark.annotation({
  motivation: 'linking',
  target: { source: claimId },                                  // no selector = the whole resource
  body: { type: 'SpecificResource', source: sourceDocId, purpose: 'linking' },
});
```

To add a reference body to an *existing* annotation, use `bind.body(resourceId, annotationId, ops)`.

## 10. Find link candidates (semantic search)

Given a `GatheredContext` for a reference, `match.search` returns scored candidate resources to
link to. It's a `StreamObservable` — `await` for the final ranked set.

```typescript
const result = await session.client.match.search(resourceId, referenceId, context, {
  limit: 10,
  useSemanticScoring: true,
});
```

## 11. React to live collaboration

Subscribing to `browse.*` live queries is the primary way to keep a UI current (recipe 3). For
arbitrary bus channels — presence, attention, custom signals — `session.subscribe(channel,
handler)` is the sanctioned escape hatch; `beckon.*` emits attention signals other participants
observe.

```typescript
const sub = session.client.browse.annotations(rId).subscribe(render);  // live updates
session.subscribe('beckon:focus', (e) => highlight(e));                // observe a raw channel
session.client.beckon.attention(resourceId, annotationId);             // emit an attention signal
// teardown: sub.unsubscribe();
```

## 12. Drive a long-running job

Generation and `mark.assist` *are* jobs — their `StreamObservable` already surfaces the
lifecycle. When you instead hold a `jobId` (e.g. handed one out-of-band), poll it through the
`job` namespace.

```typescript
const status = await session.client.job.status(jobId);
const final  = await session.client.job.pollUntilComplete(jobId, { onProgress: (s) => log(s.status) });
```

## 13. Handle errors

Everything thrown through the SDK extends `SemiontError` with a discriminated `code`. Catch
broadly and route on `code`; reach for `BusRequestError` for bus-specific cases.

```typescript
import { SemiontError, BusRequestError } from '@semiont/sdk';

try {
  await session.client.mark.annotation(input);
} catch (e) {
  if (e instanceof BusRequestError && e.code === 'bus.timeout') retry();
  else if (e instanceof SemiontError && e.code === 'unauthorized') reauthenticate();
  else throw e;
}
```

→ [Usage § Error Handling](./Usage.md#error-handling) for the full code vocabulary.

## 14. Tear down cleanly

Unsubscribe live queries and `dispose()` the session when its work is done. **Don't
fire-and-forget SDK promises** — an unawaited call left in flight can reject with `bus.closed`
when the session is disposed. `await` or `.catch` every call you start.

```typescript
sub.unsubscribe();
await session.dispose();   // tears down the SSE connection, refresh timer, and bus
```

## Headless (Node) vs. browser

The same code runs in both — only two things differ:
- **Storage:** `InMemorySessionStorage` (or your own file-backed `SessionStorage`) in Node; a
  `localStorage`-backed `SessionStorage` in the browser.
- **Transport:** the default HTTP transport for a remote backend; `LocalTransport` (from
  `@semiont/make-meaning`) for fully in-process operation (embedded use, an agentic worker, a
  test). The verb namespaces are identical either way.

Keep your orchestration framework-free (plain functions over the `session` / `session.client`
surface) and the same logic serves a browser app, a Node daemon, and a one-shot script.

---

## Where to go deeper

- **[Usage.md](./Usage.md)** — the per-namespace reference: every method, every option.
- **[REACTIVE-MODEL.md](./REACTIVE-MODEL.md)** — return shapes, await-vs-subscribe, the bus.
- **[STATE-UNITS.md](./STATE-UNITS.md)** — the state-unit pattern for reactive UIs.
- **[CACHE-SEMANTICS.md](./CACHE-SEMANTICS.md)** — the read-through cache contract behind `browse.*`.
- **`docs/protocol/`** — the protocol-level framing (the eight flows, the programmable surfaces).
