# API Integration

Guide to working with the Semiont API from `@semiont/react-ui`.

## Overview

`@semiont/react-ui` does not own a data-fetching layer. Fetching and caching
are an SDK concern: `@semiont/sdk` exposes the typed API surface and an RxJS
read-through cache (stale-while-revalidate). React components consume that
surface as **live queries** via the `useObservable()` hook.

The shape is:

- **Reads** come from `client.browse.*(...)` observables, backed by the
  read-through cache. Subscribe with `useObservable()` and the component
  re-renders as the cache emits fresh values.
- **Writes** go through the typed namespaces — `client.mark.*`,
  `client.bind.*`, `client.yield.*`, etc. These emit on the session bus and
  the SDK invalidates the affected cache keys; you do not invalidate by hand.
- **Events** are observed with `useEventSubscription` / `useEventSubscriptions`.

The cache's freshness and invalidation contract lives in the SDK, not here —
see [`packages/sdk/docs/CACHE-SEMANTICS.md`](../../sdk/docs/CACHE-SEMANTICS.md).
For the layered Service → Hook → Component pattern these pieces compose into,
see [SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md). This guide stays
focused on how a component reaches the client and reads/writes through it.

## Getting the client

`SemiontProvider` puts the module-scoped `SemiontBrowser` singleton into
context. `useSemiont()` returns that browser. The browser exposes
`activeSession$` — an observable of the current `SemiontSession` (or `null`
when no KB session is active). The session's `.client` is the
`SemiontClient`, which carries the `browse` / `mark` / `bind` / … namespaces.

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function useClient() {
  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  return session?.client; // SemiontClient | undefined
}
```

`useObservable()` accepts `null`/`undefined` and is a no-op in that case, so
`client?.browse.resources(...)` is safe before a session exists — the hook
returns `undefined` until both the session and the first cache emission land.

## Reading data

Each `browse.*` method returns a `CacheObservable`. Subscribe with
`useObservable()`; the first value comes from cache (or `undefined` while it
loads), and the component re-renders as the read-through cache revalidates.

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function ResourceList() {
  const client = useObservable(useSemiont().activeSession$)?.client;
  const resources = useObservable(client?.browse.resources({ limit: 20 }));

  if (!resources) return <div>Loading…</div>;

  return (
    <ul>
      {resources.map(resource => (
        <li key={resource['@id']}>{resource.name}</li>
      ))}
    </ul>
  );
}
```

**Available reads** (all return `CacheObservable<…>`):

- `client.browse.resource(rId)` — a single resource descriptor
- `client.browse.resources(filters?)` — list / search resources
- `client.browse.annotations(rId)` — a resource's annotations
- `client.browse.annotation(rId, annotationId)` — a single annotation
- `client.browse.entityTypes()` — known entity types
- `client.browse.tagSchemas()` — tag schemas
- `client.browse.referencedBy(rId)` — resources referencing this one
- `client.browse.events(rId)` — a resource's event log

Subscribing to a per-resource read such as `client.browse.annotations(rId)`
(or `client.browse.resource(rId)`) is also what **acquires the resource's SSE
scope** — there is no separate `subscribeToResource`/`addChannels` call. When
the last subscriber unmounts, the scope is released.

### Search (`createSearchPipeline`)

There is no dedicated search read — search is `browse.resources({ search })`
driven by a debounced input. `createSearchPipeline` (re-exported here from
`@semiont/sdk`) encapsulates the debounce + distinct + switchMap +
loading-state shape so components don't reassemble it by hand:

```tsx
import {
  useSemiont,
  useObservable,
  createSearchPipeline,
} from '@semiont/react-ui';
import { useState, useEffect } from 'react';
import type { components } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

function MySearchUI() {
  const client = useObservable(useSemiont().activeSession$)?.client;
  const [pipeline] = useState(() =>
    createSearchPipeline<ResourceDescriptor>(
      (q) => client!.browse.resources({ search: q, limit: 20 }),
    ),
  );
  useEffect(() => () => pipeline.dispose(), [pipeline]);

  const query = useObservable(pipeline.query$) ?? '';
  const state = useObservable(pipeline.state$);
  const results = state?.results ?? [];
  const isSearching = state?.isSearching ?? false;

  return (
    <input
      value={query}
      onChange={(e) => pipeline.setQuery(e.target.value)}
    />
    // …render `results` and `isSearching`
  );
}
```

The pipeline is created once per mount via `useState`'s lazy initializer and
torn down on unmount via `useEffect` cleanup. The component holds no React
state for the query — `pipeline.query$` is the source of truth, surfaced via
`useObservable`.

**Why a helper instead of `useMemo` + inline RxJS?** The pipeline is a
stateful long-lived object (a Subject + an Observable graph). Inlining it and
stabilizing with `useMemo` is defensive plumbing against React re-runs, and
it's easy to break — a fresh object returned on each render busts the deps and
restarts the pipeline on every keystroke. The helper lives outside the render
lifecycle entirely.

**For non-trivial result mapping** (e.g. adapting `ResourceDescriptor` to a
modal-specific shape), put the mapping inside the fetch closure with `map()`.
The closure can return `undefined` to signal "still loading" — see
`SearchModal.tsx` and `ResourceSearchModal.tsx` for working examples.

`createSearchPipeline` is unit-testable without React: pass a stub fetch
function, push values into `setQuery`, assert on emissions from `state$`. See
`packages/react-ui/src/lib/__tests__/search-pipeline.test.ts`.

## Writing data

Mutations are direct method calls on the typed namespaces. They emit on the
session bus, and the SDK invalidates the affected cache keys — any live
`browse.*` query subscribed via `useObservable()` re-emits on its own. There
is no manual `invalidate`/`refetch` step in the component.

```tsx
function ResourceActions({ rUri }) {
  const client = useObservable(useSemiont().activeSession$)?.client;

  const archive = () => client?.mark.archive(rUri);
  const remove = (annotationId) => client?.mark.delete(rUri, annotationId);
  const linkReference = (annotationId, targetResourceId) =>
    client?.bind.body(rUri, annotationId, [
      { op: 'add', item: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' } },
    ]);

  return <button onClick={archive}>Archive</button>;
}
```

The write namespaces (`mark`, `bind`, `gather`, `beckon`, `match`, `yield`)
are the same on every host — browser, CLI, worker, tests — because they live
in the SDK. react-ui just calls them.

## Events

Two buses exist, and `useEventSubscription` subscribes to both so components
don't need to know which scope a channel is on:

- **App / shell bus** — on `SemiontBrowser` (panel, shell, tabs, nav,
  settings; events that must work without a KB session).
- **Session bus** — on `SemiontClient` (`mark:*`, `beckon:*`, `gather:*`,
  `match:*`, `bind:*`, `yield:*`, `browse:*`; events tied to a live KB).

```tsx
import { useEventSubscription, useEventSubscriptions } from '@semiont/react-ui';

function SparkleOnCreate() {
  useEventSubscription('mark:create-ok', ({ annotationId }) => {
    triggerSparkleAnimation(annotationId);
  });
  return null;
}

function ShellWiring() {
  useEventSubscriptions({
    'mark:create-ok': ({ annotationId }) => handleCreated(annotationId),
    'panel:toggle': ({ panel }) => console.log('toggled', panel),
  });
  return null;
}
```

The ref-wrapped handler means your handler can change every render without
re-subscribing; the hook re-subscribes only when the channel set changes.

For lower-level access you can reach the buses directly:
`semiont.emit/on/stream` on the browser, and `session.client.emit/on/stream`
on the client. Most components should prefer the hooks.

Note: with this model you do **not** wire backend events to manual cache
invalidation. The SDK's read-through cache already invalidates on the relevant
bus events; `useEventSubscription` is for UI reactions (animations, focus,
navigation), not for keeping `browse.*` reads fresh.

## Error handling

`browse.*` reads surface their errors through the observable. Transport-level
errors (including `APIError`, the status-coded `SemiontError` subclass) are
published on the session's error stream — `session.errors$`, republished from
`client.transport.errors$`.

You generally do **not** subscribe to `errors$` yourself for auth UX. The SDK
already routes `401` / `403` from that stream into the active session's
`SessionSignals` (`notifySessionExpired` / `notifyPermissionDenied`). The
`<SessionExpiredModal />` and `<PermissionDeniedModal />` components — mounted
once in your provider tree (see the README quick start) — read those signals
and render. Mount the modals and session-expiry/permission handling is done.

Handle the remaining cases (404, validation, etc.) where you read or write —
inspect the value/error from the `browse.*` observable, or branch on the
`await`ed result / thrown `APIError` from a write call.

`APIError` and the transport classes (`HttpTransport`, `HttpContentTransport`)
are exported from `@semiont/http-transport`. The `components` type comes from
`@semiont/core`. Everything else — the client, session, browser, namespaces,
cache, and `createSearchPipeline` — comes from `@semiont/sdk`.

## Testing

See [TESTING.md](TESTING.md) for the full testing guide. To stub a read, mock
the `BrowseNamespace` method (now exported from `@semiont/sdk`) to return an
observable:

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';
import { BrowseNamespace } from '@semiont/sdk';
import { of } from 'rxjs';

it('renders resources', async () => {
  vi.spyOn(BrowseNamespace.prototype, 'resources').mockReturnValue(
    of([{ '@id': 'r1', name: 'Test' } as any]),
  );

  renderWithProviders(<ResourceList />);

  await screen.findByText('Test');
});
```

## See Also

- [SERVICE-HOOK-COMPONENT.md](SERVICE-HOOK-COMPONENT.md) — the three-layer Service → Hook → Component pattern
- [`packages/sdk/docs/CACHE-SEMANTICS.md`](../../sdk/docs/CACHE-SEMANTICS.md) — read-through cache freshness and invalidation contract
- [EVENTS.md](EVENTS.md) — event-driven architecture and channels
- [SESSION.md](SESSION.md) — `SemiontProvider` / session lifecycle
- [TESTING.md](TESTING.md) — testing components that read and write through the client
- [@semiont/sdk](../../sdk) — `SemiontBrowser`, `SemiontClient`, the read-through cache, and `BrowseNamespace`
