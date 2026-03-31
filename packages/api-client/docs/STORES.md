# Observable Stores

`SemiontApiClient` owns two observable stores that provide reactive, lazily-populated caches of backend entity data. They are the read-path complement to the HTTP methods: instead of calling `client.browseAnnotations(id)` and managing state yourself, you subscribe to `client.stores.annotations.listForResource(id)` and receive a live stream that stays current as the workspace changes.

## Overview

| Store | Accessed via | What it caches |
|---|---|---|
| `ResourceStore` | `client.stores.resources` | Resource descriptors (detail + lists) |
| `AnnotationStore` | `client.stores.annotations` | Annotation lists per resource + individual annotation details |

Both stores are:

- **Framework-agnostic** — pure TypeScript + RxJS, no DOM, no React
- **Lazily populated** — no fetches happen until something subscribes
- **EventBus-reactive** — update automatically when backend events arrive via SSE, with no manual cache invalidation

## Why stores exist

The HTTP client (`browseResource`, `browseAnnotations`, etc.) returns a one-shot `Promise`. If the backend state changes — an annotation is added, a resource is archived — callers must decide when to re-fetch. In a UI this means wiring up SSE callbacks to `setState` or `queryClient.invalidateQueries`, duplicating logic everywhere.

The stores remove that wiring. They subscribe to the workspace `EventBus` at construction time. When a domain event arrives (e.g. `mark:added` from the SSE stream), the store invalidates and re-fetches the relevant entry. Any Observable subscriber sees the new value without doing anything.

## Accessing stores

Stores are constructed with the client and are accessible as named properties:

```typescript
const client = new SemiontApiClient({ baseUrl, eventBus });

// ResourceStore
client.stores.resources.get(id)                        // Observable<ResourceDetail | undefined>
client.stores.resources.list({ limit: 20 })            // Observable<ResourceListResponse | undefined>

// AnnotationStore
client.stores.annotations.listForResource(resourceId)  // Observable<AnnotationsListResponse | undefined>
client.stores.annotations.get(resourceId, annotationId) // Observable<AnnotationDetail | undefined>
```

The `eventBus` field in `SemiontApiClientConfig` is **required**. A client without an EventBus cannot drive reactive store updates.

## Token management

Stores make authenticated HTTP requests. Because the auth token can change (login, refresh), each store has a mutable token getter:

```typescript
// Call once near the workspace root when auth changes
const getter = () => token ? accessToken(token) : undefined;
client.stores.resources.setTokenGetter(getter);
client.stores.annotations.setTokenGetter(getter);
```

In React, `useStoreTokenSync()` from `@semiont/react-ui` handles this automatically. Outside React, call `setTokenGetter` whenever the token changes.

## ResourceStore

**Location**: `packages/api-client/src/stores/resource-store.ts`

Caches resource descriptors in two separate `BehaviorSubject` maps:

- `detail$` — `Map<ResourceId, ResourceDetail>` — individual resource detail responses
- `list$` — `Map<string, ResourceListResponse>` — list responses keyed by serialized options

### EventBus subscriptions

| Event | Action |
|---|---|
| `yield:created` | Fetch new resource into detail cache; invalidate all lists |
| `yield:updated` | Invalidate and re-fetch the updated resource; invalidate all lists |
| `mark:archived` | Invalidate detail + lists for the archived resource |
| `mark:unarchived` | Invalidate detail + lists for the unarchived resource |
| `mark:entity-tag-added` | Invalidate detail for the affected resource |
| `mark:entity-tag-removed` | Invalidate detail for the affected resource |

### API

```typescript
// Subscribe to a single resource — triggers fetch on first subscribe if not cached
client.stores.resources.get(id: ResourceId): Observable<ResourceDetail | undefined>

// Subscribe to a resource list — triggers fetch on first subscribe
client.stores.resources.list(options?: { limit?: number; archived?: boolean }): Observable<ResourceListResponse | undefined>

// Manually invalidate — invalidates and re-fetches
client.stores.resources.invalidateDetail(id: ResourceId): void
client.stores.resources.invalidateLists(): void
```

`invalidateDetail` and `invalidateLists` are public so write-path code (mutations) can force a refresh without needing to construct a domain event. Prefer EventBus emissions for multi-subscriber coordination; use direct invalidation when only the local client needs to know (e.g. immediately after a `yieldResource` call).

## AnnotationStore

**Location**: `packages/api-client/src/stores/annotation-store.ts`

Caches annotation data in two `BehaviorSubject` maps:

- `list$` — `Map<ResourceId, AnnotationsListResponse>` — annotations per resource
- `detail$` — `Map<AnnotationId, AnnotationDetail>` — individual annotation details

### EventBus subscriptions

| Event | Action |
|---|---|
| `mark:added` | Invalidate and re-fetch the annotation list for the affected resource |
| `mark:removed` | Invalidate list for affected resource; remove detail from cache |
| `mark:body-updated` | Invalidate list for affected resource; invalidate detail |
| `mark:deleted` | Remove annotation from detail cache (no re-fetch) |
| `mark:entity-tag-added` | Invalidate list for affected resource |
| `mark:entity-tag-removed` | Invalidate list for affected resource |

`mark:added`, `mark:removed`, and `mark:body-updated` are backend domain events that arrive via SSE. `mark:deleted` is a local UI event emitted when the user deletes an annotation via the HTTP client.

### API

```typescript
// Subscribe to all annotations for a resource
client.stores.annotations.listForResource(resourceId: ResourceId): Observable<AnnotationsListResponse | undefined>

// Subscribe to a single annotation detail
client.stores.annotations.get(resourceId: ResourceId, annotationId: AnnotationId): Observable<AnnotationDetail | undefined>

// Manually invalidate
client.stores.annotations.invalidateList(resourceId: ResourceId): void
client.stores.annotations.invalidateDetail(annotationId: AnnotationId): void
```

## Using stores in React

`useObservable` from `@semiont/react-ui` bridges an Observable into React state:

```typescript
import { useObservable } from '@semiont/react-ui';
import { useApiClient } from '@semiont/react-ui';

function AnnotationList({ resourceId }: { resourceId: ResourceId }) {
  const client = useApiClient();
  const data = useObservable(client.stores.annotations.listForResource(resourceId));
  const annotations = data?.annotations ?? [];
  // re-renders whenever the store emits a new value
}
```

Call `useStoreTokenSync()` once at the workspace root (inside both `ApiClientProvider` and `AuthTokenProvider`) to keep the stores' token getters current:

```typescript
function WorkspaceRoot() {
  useStoreTokenSync(); // keeps stores authenticated
  useGlobalEvents();   // opens SSE stream that feeds EventBus
  return <Outlet />;
}
```

## Relationship to the EventBus

Both stores are constructed with the workspace `EventBus` and subscribe at construction time. This is why `eventBus` is required in `SemiontApiClientConfig` rather than optional: the stores are inert without a bus to drive them.

The SSE client (`client.sse.*`) routes backend domain events onto the same bus. The typical data flow is:

```
Backend → SSE stream → EventBus → Store subscription → BehaviorSubject.next() → Observable subscriber
```

Write operations complete the loop:

```
UI mutation → HTTP call → onSuccess → emit EventBus event (or call store.invalidate*)
                                    ↓
                               Store reacts → re-fetches → Observable subscriber
```

## What the stores do not cover

The stores cover the entities that change most frequently and have the most EventBus/SSE coverage: resources and annotations. They do not cover:

- **Resource events log** (`GET /resources/{id}/events`) — no store; use `resources.events.useQuery(id)` from `api-hooks`
- **referencedBy** (`GET /resources/{id}/referenced-by`) — no store; use `resources.referencedBy.useQuery(id)`
- **Entity types** — no store; use `entityTypes.list.useQuery()`
- **Admin and auth endpoints** — no store; use their respective React Query hooks
- **Media tokens** — short-lived, not worth caching reactively

These are retained as React Query queries in `@semiont/react-ui`'s `api-hooks.ts`.
