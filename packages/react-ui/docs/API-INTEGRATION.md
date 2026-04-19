# API Integration

Guide to working with the Semiont API using `@semiont/react-ui` hooks.

## Overview

The library provides **React Query hooks** for all Semiont API operations. These hooks:

- Handle authentication automatically (via ApiClientContext)
- Manage loading, error, and success states
- Cache responses intelligently
- Retry failed requests (configurable)
- Invalidate related queries on mutations
- Are fully type-safe with TypeScript

## Setup

### 1. Configure API Client Provider

`ApiClientProvider` must be nested inside `EventBusProvider` and
`AuthTokenProvider`. Pass the backend URL; the provider reads the
auth token from `AuthTokenContext` as a `BehaviorSubject` and wires
it into the client automatically.

```tsx
import {
  ApiClientProvider,
  AuthTokenProvider,
  EventBusProvider,
} from '@semiont/react-ui';

function App() {
  const { data: session } = useSession(); // Your auth system

  return (
    <EventBusProvider>
      <AuthTokenProvider token={session?.backendToken ?? null}>
        <ApiClientProvider baseUrl="/">
          {children}
        </ApiClientProvider>
      </AuthTokenProvider>
    </EventBusProvider>
  );
}
```

The client uses an observable `token$: BehaviorSubject<AccessToken | null>`
internally — when the token transitions from null to a real value, the
bus SSE connection starts. Token rotation (e.g. after refresh) propagates
automatically.

### 2. Configure React Query

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { notifySessionExpired, notifyPermissionDenied } from '@semiont/react-ui';
import { APIError } from '@semiont/api-client';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof APIError) {
        if (error.status === 401) {
          notifySessionExpired('Your session has expired');
        } else if (error.status === 403) {
          notifyPermissionDenied('Permission denied');
        }
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry auth errors or client errors
        if (error instanceof APIError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 3;
      },
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

<QueryClientProvider client={queryClient}>
  {children}
</QueryClientProvider>
```

## API Hooks

### useResources()

Manage resources (documents, files, etc.)

**List Resources:**

```tsx
import { useResources } from '@semiont/react-ui';

function ResourceList() {
  const resources = useResources();
  const { data, isLoading, error } = resources.list.useQuery({
    limit: 20,
    archived: false,
    query: 'search term' // Optional search
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.map(resource => (
        <li key={resource.id}>{resource.name}</li>
      ))}
    </ul>
  );
}
```

**Get Single Resource:**

```tsx
function ResourceDetail({ rId }) {
  const resources = useResources();
  const { data: resource } = resources.get.useQuery(rId);

  return <div>{resource?.name}</div>;
}
```

**Create Resource:**

```tsx
function CreateResourceForm() {
  const resources = useResources();
  const { mutate, isPending } = resources.create.useMutation();

  const handleSubmit = (formData) => {
    mutate({
      name: formData.name,
      mediaType: 'text/plain',
      content: formData.content
    }, {
      onSuccess: (newResource) => {
        console.log('Created:', newResource.id);
        navigate(`/resource/${newResource.id}`);
      },
      onError: (error) => {
        alert(`Failed: ${error.message}`);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" />
      <button disabled={isPending}>
        {isPending ? 'Creating...' : 'Create'}
      </button>
    </form>
  );
}
```

**Update Resource:**

```tsx
function EditResource({ rId }) {
  const resources = useResources();
  const { mutate } = resources.update.useMutation();

  const handleSave = (updates) => {
    mutate({
      id: rId,
      data: { name: updates.name }
    });
  };

  return <button onClick={() => handleSave({ name: 'New Name' })}>Save</button>;
}
```

**Available Operations:**
- `resources.list.useQuery()` - List resources
- `resources.get.useQuery(rId)` - Get single resource
- `resources.events.useQuery(rId)` - Get resource events
- `resources.annotations.useQuery(rId)` - Get resource annotations
- `resources.referencedBy.useQuery(rId)` - Get referencing resources
- `resources.create.useMutation()` - Create resource
- `resources.update.useMutation()` - Update resource
- `resources.generateCloneToken.useMutation()` - Generate clone token
- `resources.getByToken.useQuery(token)` - Get resource by token
- `resources.createFromToken.useMutation()` - Clone resource

**Search:** there is no React Query hook for resource search. Search is consumed
directly through the api-client's Observable surface using `createSearchPipeline`,
which encapsulates the debounce + distinct + switchMap + loading-state shape:

```tsx
import {
  useApiClient,
  useObservable,
  createSearchPipeline,
} from '@semiont/react-ui';
import { useState, useEffect } from 'react';
import type { components } from '@semiont/core';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

function MySearchUI() {
  const semiont = useApiClient();
  const [pipeline] = useState(() =>
    createSearchPipeline<ResourceDescriptor>(
      (q) => semiont.browse.resources({ search: q, limit: 20 }),
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
    // ... render `results` and `isSearching`
  );
}
```

The pipeline is created once per component mount via `useState`'s lazy
initializer and torn down on unmount via `useEffect` cleanup. The component
holds no React state for the search query — `pipeline.query$` is the source
of truth, surfaced via `useObservable`.

**Why a helper instead of `useMemo` + RxJS inline?** The pipeline is a
stateful long-lived object (a Subject + an Observable graph). Inlining it in
the component body and stabilizing it with `useMemo` is defensive plumbing
against React re-runs, and it's easy to break by accident — a fresh object
returned from a hook on each render busts the deps and restarts the
pipeline on every keystroke. The helper sidesteps this by living outside
the React render lifecycle entirely.

**For non-trivial result mapping** (e.g., adapting `ResourceDescriptor` to a
modal-specific shape), put the mapping inside the fetch closure with
`map()`. The closure can return `undefined` to signal "still loading" — see
`SearchModal.tsx` and `ResourceSearchModal.tsx` for working examples.

`createSearchPipeline` is unit-testable without React: pass a stub fetch
function, push values into `setQuery`, assert on emissions from `state$`.
See `packages/react-ui/src/lib/__tests__/search-pipeline.test.ts`.

---

### useAnnotations()

Manage annotations on resources

**Get Annotations:**

```tsx
import { useAnnotations } from '@semiont/react-ui';

function AnnotationsList({ rId }) {
  const resources = useResources();
  const { data: annotations } = resources.annotations.useQuery(rId);

  return (
    <ul>
      {annotations?.map(ann => (
        <li key={ann.id}>{ann.body.value}</li>
      ))}
    </ul>
  );
}
```

**Create Annotation:**

```tsx
function AddAnnotation({ rId }) {
  const annotations = useAnnotations();
  const { mutate } = annotations.create.useMutation();

  const addHighlight = () => {
    mutate({
      resourceId: rId,
      data: {
        type: 'Annotation',
        motivation: 'highlighting',
        target: {
          source: rId,
          selector: {
            type: 'TextPositionSelector',
            start: 0,
            end: 10
          }
        },
        body: {
          type: 'TextualBody',
          value: 'Important passage',
          purpose: 'commenting'
        }
      }
    });
  };

  return <button onClick={addHighlight}>Highlight</button>;
}
```

**Delete Annotation:**

```tsx
function DeleteAnnotationButton({ resourceId, annotationId }) {
  const annotations = useAnnotations();
  const { mutate } = annotations.delete.useMutation();

  return (
    <button onClick={() => mutate(resourceId, annotationId)}>
      Delete
    </button>
  );
}
```

**Available Operations:**
- `annotations.get.useQuery(annotationId)` - Get annotation
- `annotations.getResourceAnnotation.useQuery(resourceId, annotationId)` - Get resource annotation
- `annotations.history.useQuery(resourceId, annotationId)` - Get annotation history
- `annotations.llmContext.useQuery(resourceId, annotationId, options)` - Get LLM context
- `annotations.create.useMutation()` - Create annotation
- `annotations.delete.useMutation()` - Delete annotation
- `annotations.updateBody.useMutation()` - Update annotation body

---

### useEntityTypes()

Manage entity types for annotation

**List Entity Types:**

```tsx
import { useEntityTypes } from '@semiont/react-ui';

function EntityTypesList() {
  const entityTypes = useEntityTypes();
  const { data: types } = entityTypes.list.useQuery();

  return (
    <ul>
      {types?.map(type => (
        <li key={type}>{type}</li>
      ))}
    </ul>
  );
}
```

**Add Entity Type:**

```tsx
function AddEntityType() {
  const entityTypes = useEntityTypes();
  const { mutate } = entityTypes.add.useMutation();

  const handleAdd = (typeName) => {
    mutate(typeName);
  };

  return <button onClick={() => handleAdd('Person')}>Add Person Type</button>;
}
```

**Add Multiple Types:**

```tsx
function ImportEntityTypes({ types }) {
  const entityTypes = useEntityTypes();
  const { mutate } = entityTypes.addBulk.useMutation();

  return (
    <button onClick={() => mutate(types)}>
      Import {types.length} types
    </button>
  );
}
```

**Available Operations:**
- `entityTypes.list.useQuery()` - List all entity types
- `entityTypes.add.useMutation()` - Add single entity type
- `entityTypes.addBulk.useMutation()` - Add multiple entity types

---

### useAdmin()

Admin operations (requires admin role)

**List Users:**

```tsx
import { useAdmin } from '@semiont/react-ui';

function UsersList() {
  const admin = useAdmin();
  const { data: users } = admin.users.list.useQuery();

  return (
    <ul>
      {users?.map(user => (
        <li key={user.did}>{user.name}</li>
      ))}
    </ul>
  );
}
```

**Get User Stats:**

```tsx
function UserStats() {
  const admin = useAdmin();
  const { data: stats } = admin.users.stats.useQuery();

  return <div>Total Users: {stats?.totalUsers}</div>;
}
```

**Update User:**

```tsx
function ToggleUserAdmin({ userId, isAdmin }) {
  const admin = useAdmin();
  const { mutate } = admin.users.update.useMutation();

  return (
    <button onClick={() => mutate({
      id: userId,
      data: { isAdmin: !isAdmin }
    })}>
      {isAdmin ? 'Revoke Admin' : 'Make Admin'}
    </button>
  );
}
```

**Available Operations:**
- `admin.users.list.useQuery()` - List users
- `admin.users.stats.useQuery()` - Get user statistics
- `admin.users.update.useMutation()` - Update user
- `admin.oauth.config.useQuery()` - Get OAuth configuration

---

### useAuthApi()

Authentication and user operations

**Get Current User:**

```tsx
import { useAuthApi } from '@semiont/react-ui';

function UserProfile() {
  const auth = useAuthApi();
  const { data: user } = auth.me.useQuery();

  return <div>Welcome, {user?.name}</div>;
}
```

**Accept Terms of Service:**

```tsx
function AcceptTerms() {
  const auth = useAuthApi();
  const { mutate, isPending } = auth.acceptTerms.useMutation();

  return (
    <button onClick={() => mutate()} disabled={isPending}>
      Accept Terms
    </button>
  );
}
```

**Generate MCP Token:**

```tsx
function GenerateMCPToken() {
  const auth = useAuthApi();
  const { mutate, data: token } = auth.generateMCPToken.useMutation();

  return (
    <div>
      <button onClick={() => mutate()}>Generate Token</button>
      {token && <code>{token}</code>}
    </div>
  );
}
```

**Logout:**

```tsx
function LogoutButton() {
  const auth = useAuthApi();
  const { mutate } = auth.logout.useMutation();

  return (
    <button onClick={() => mutate()}>
      Logout
    </button>
  );
}
```

**Available Operations:**
- `auth.me.useQuery()` - Get current user
- `auth.acceptTerms.useMutation()` - Accept terms of service
- `auth.generateMCPToken.useMutation()` - Generate MCP API token
- `auth.logout.useMutation()` - Logout

---

### useHealth()

System health checks

```tsx
import { useHealth } from '@semiont/react-ui';

function HealthCheck() {
  const health = useHealth();
  const { data } = health.check.useQuery();

  return <div>Status: {data?.status}</div>;
}

function SystemStatus() {
  const health = useHealth();
  const { data } = health.status.useQuery(5000); // Refetch every 5s

  return <div>Uptime: {data?.uptime}s</div>;
}
```

**Available Operations:**
- `health.check.useQuery()` - Health check
- `health.status.useQuery(refetchInterval?)` - System status

---

## Query Keys

All queries use consistent key patterns for cache management:

```typescript
import { QUERY_KEYS } from '@semiont/react-ui';

// Resource queries
QUERY_KEYS.resources.all(limit, archived)
QUERY_KEYS.resources.detail(rId)
QUERY_KEYS.resources.events(rId)
QUERY_KEYS.resources.annotations(rId)
QUERY_KEYS.resources.search(query, limit)

// Annotation queries
QUERY_KEYS.annotations.history(resourceId, annotationId)
QUERY_KEYS.annotations.llmContext(resourceId, annotationId)

// Entity type queries
QUERY_KEYS.entityTypes.all()

// Admin queries
QUERY_KEYS.admin.users.all()
QUERY_KEYS.admin.users.stats()
QUERY_KEYS.admin.oauth.config()

// User queries
QUERY_KEYS.users.me()

// Health queries
QUERY_KEYS.health()
QUERY_KEYS.status()
```

## Error Handling

### Global Error Handling

Configured in QueryClient:

```tsx
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof APIError) {
        if (error.status === 401) {
          notifySessionExpired('Session expired');
        } else if (error.status === 403) {
          notifyPermissionDenied('Permission denied');
        }
      }
    },
  }),
});
```

### Per-Query Error Handling

```tsx
const { data, error } = resources.get.useQuery(rId, {
  onError: (error) => {
    if (error instanceof APIError) {
      if (error.status === 404) {
        navigate('/not-found');
      }
    }
  },
});
```

### Per-Mutation Error Handling

```tsx
const { mutate } = resources.create.useMutation();

mutate(data, {
  onSuccess: (resource) => {
    toast.success('Resource created');
  },
  onError: (error) => {
    if (error instanceof APIError) {
      toast.error(`Failed: ${error.message}`);
    }
  },
});
```

## Optimistic Updates

```tsx
function ToggleFavorite({ rId }) {
  const resources = useResources();
  const queryClient = useQueryClient();
  const { mutate } = resources.update.useMutation();

  const toggle = () => {
    mutate({
      id: rId,
      data: { isFavorite: !currentValue }
    }, {
      // Optimistically update the cache
      onMutate: async (variables) => {
        await queryClient.cancelQueries({
          queryKey: QUERY_KEYS.resources.detail(rId)
        });

        const previous = queryClient.getQueryData(
          QUERY_KEYS.resources.detail(rId)
        );

        queryClient.setQueryData(
          QUERY_KEYS.resources.detail(rId),
          (old) => ({ ...old, isFavorite: variables.data.isFavorite })
        );

        return { previous };
      },
      // Rollback on error
      onError: (err, variables, context) => {
        queryClient.setQueryData(
          QUERY_KEYS.resources.detail(rId),
          context.previous
        );
      },
    });
  };

  return <button onClick={toggle}>Toggle Favorite</button>;
}
```

## Pagination

```tsx
function PaginatedResourceList() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const resources = useResources();
  const { data, isLoading } = resources.list.useQuery({
    limit: limit,
    // Note: API may not support offset-based pagination
    // Adjust based on actual API capabilities
  });

  return (
    <div>
      <ResourceList items={data} />
      <button onClick={() => setPage(p => p - 1)} disabled={page === 1}>
        Previous
      </button>
      <button onClick={() => setPage(p => p + 1)}>
        Next
      </button>
    </div>
  );
}
```

## Testing API Hooks

See [TESTING.md](TESTING.md) for comprehensive testing guide.

```tsx
import { renderWithProviders } from '@semiont/react-ui/test-utils';
import { BrowseNamespace } from '@semiont/api-client';
import { of } from 'rxjs';

it('should fetch resources', async () => {
  vi.spyOn(BrowseNamespace.prototype, 'resources').mockReturnValue(
    of([{ id: 'r1', name: 'Test' } as any]),
  );

  renderWithProviders(<ResourceList />);

  await screen.findByText('Test');
});
```

## Best Practices

### Do: Enable queries conditionally

```tsx
const { data } = resources.get.useQuery(rId, {
  enabled: !!rId && isAuthenticated
});
```

### Do: Invalidate related queries

```tsx
const { mutate } = annotations.create.useMutation();

mutate(data, {
  onSuccess: () => {
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.resources.annotations(rId)
    });
  }
});
```

### Do: Use React Query devtools (development)

```tsx
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

<QueryClientProvider client={queryClient}>
  {children}
  <ReactQueryDevtools initialIsOpen={false} />
</QueryClientProvider>
```

### Don't: Call useApiClient() directly in components

```tsx
// WRONG
const client = useApiClient();
const resources = await client.listResources();

// CORRECT
const resources = useResources();
const { data } = resources.list.useQuery();
```

### Don't: Ignore loading states

```tsx
// WRONG
const { data } = resources.list.useQuery();
return <div>{data.map(...)}</div>; // data might be undefined

// CORRECT
const { data, isLoading } = resources.list.useQuery();
if (isLoading) return <Spinner />;
return <div>{data?.map(...) ?? []}</div>;
```

### Do: Use event-based cache invalidation

```tsx
// OLD: Manual cache invalidation after mutations
const { mutate } = annotations.create.useMutation();

mutate(data, {
  onSuccess: () => {
    // Manual refetch after every mutation
    queryClient.invalidateQueries({ queryKey: ['annotations', rId] });
  }
});

// NEW: Event-based cache invalidation (automatic)
import { useMakeMeaningEvents } from '@semiont/react-ui';

function AnnotationCacheSync({ rId }: { rId: ResourceId }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Backend events automatically trigger cache invalidation
    const handleAnnotationAdded = () => {
      queryClient.invalidateQueries(['annotations', rId]);
    };

    eventBus.on('mark:added', handleAnnotationAdded);
    return () => eventBus.off('mark:added', handleAnnotationAdded);
  }, [eventBus, queryClient, rId]);

  return null;
}

// No more manual invalidation in mutation callbacks!
const { mutate } = annotations.create.useMutation();
mutate(data); // Cache updates automatically via events
```

**Benefits:**

- Zero manual `refetch()` calls in mutation callbacks
- Automatic cache updates from backend SSE events
- Real-time updates when other users make changes
- Consistent cache state across all components

See [EVENTS.md](EVENTS.md) for complete event-driven architecture documentation.

---

## Event-Based Cache Invalidation

The library uses **event-driven cache invalidation** instead of manual refetch calls. Backend events flow through the `MakeMeaningEventBusProvider` and automatically trigger React Query cache updates.

### Backend Events

These events are emitted by the backend via SSE and automatically invalidate relevant caches:

**Detection Events:**
- `detection:started` - Show detection progress
- `detection:progress` - Update progress indicators
- `detection:entity-found` - Invalidate annotations cache
- `detection:completed` - Invalidate annotations cache
- `detection:failed` - Show error notification

**Generation Events:**
- `generation:started` - Show generation progress
- `generation:progress` - Update progress indicators
- `generation:resource-created` - Invalidate resources list
- `generation:completed` - Invalidate resources list

**Annotation Events:**
- `mark:added` - Invalidate annotations cache
- `mark:removed` - Invalidate annotations cache
- `mark:body-updated` - Invalidate annotation detail cache

**Entity Tag Events:**
- `entity-tag:added` - Invalidate annotations cache
- `entity-tag:removed` - Invalidate annotations cache

**Resource Events:**
- `mark:archived` - Invalidate resource cache
- `mark:unarchived` - Invalidate resource cache

### Setup Event-Based Invalidation

Wrap resource pages with `MakeMeaningEventBusProvider` and subscribe to events:

```tsx
import { MakeMeaningEventBusProvider, useMakeMeaningEvents } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';

// 1. Wrap resource page with event bus provider
export default function ResourcePage({ params }: { params: { id: string } }) {
  const rId = resourceId(params.id);

  return (
    <MakeMeaningEventBusProvider rId={rId}>
      <ResourceCacheSync rId={rId} />
      <ResourceViewerPage rId={rId} />
    </MakeMeaningEventBusProvider>
  );
}

// 2. Create cache sync component that subscribes to events
function ResourceCacheSync({ rId }: { rId: ResourceId }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Annotation events
    const handleAnnotationChange = () => {
      queryClient.invalidateQueries(['annotations', rId]);
    };

    // Detection events
    const handleDetectionComplete = () => {
      queryClient.invalidateQueries(['annotations', rId]);
    };

    // Resource events
    const handleResourceChange = () => {
      queryClient.invalidateQueries(['resources', rId]);
    };

    // Subscribe to all relevant events
    eventBus.on('mark:added', handleAnnotationChange);
    eventBus.on('mark:removed', handleAnnotationChange);
    eventBus.on('mark:body-updated', handleAnnotationChange);
    eventBus.on('detection:completed', handleDetectionComplete);
    eventBus.on('mark:archived', handleResourceChange);
    eventBus.on('mark:unarchived', handleResourceChange);

    return () => {
      // Cleanup all subscriptions
      eventBus.off('mark:added', handleAnnotationChange);
      eventBus.off('mark:removed', handleAnnotationChange);
      eventBus.off('mark:body-updated', handleAnnotationChange);
      eventBus.off('detection:completed', handleDetectionComplete);
      eventBus.off('mark:archived', handleResourceChange);
      eventBus.off('mark:unarchived', handleResourceChange);
    };
  }, [eventBus, queryClient, rId]);

  return null;
}
```

### Migration from Manual Invalidation

**Before (Manual Refetch):**

```tsx
// OLD: Manual cache invalidation in every mutation
const { mutate: createAnnotation } = annotations.create.useMutation();
const { mutate: deleteAnnotation } = annotations.delete.useMutation();
const { mutate: updateAnnotation } = annotations.updateBody.useMutation();

// Each mutation manually invalidates cache
createAnnotation(data, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rId]);
  }
});

deleteAnnotation(resourceId, annotationId, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rId]);
  }
});

updateAnnotation(data, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rId]);
  }
});
```

**After (Event-Based):**

```tsx
// NEW: Zero manual invalidation, events handle it
const { mutate: createAnnotation } = annotations.create.useMutation();
const { mutate: deleteAnnotation } = annotations.delete.useMutation();
const { mutate: updateAnnotation } = annotations.updateBody.useMutation();

// Just call mutations - events handle cache invalidation automatically
createAnnotation(data);
deleteAnnotation(resourceId, annotationId);
updateAnnotation(data);

// Backend emits events -> EventBus -> ResourceCacheSync -> Cache invalidated
```

**Key Differences:**

- **Before:** Every mutation needs `onSuccess` callback with manual `invalidateQueries()`
- **After:** Mutations have no `onSuccess` callbacks, events automatically invalidate cache
- **Before:** Developers must remember to invalidate cache in every mutation
- **After:** Cache invalidation happens automatically via events (can't forget)
- **Before:** No real-time updates when other users make changes
- **After:** Real-time updates via SSE events from backend

### Real-Time Collaboration

Event-based cache invalidation enables real-time collaboration:

1. **User A** creates an annotation
2. **Backend** emits `mark:added` event via SSE
3. **EventBus** receives event and broadcasts to all subscribers
4. **User B's cache** automatically invalidates via event subscription
5. **User B sees update** without manual refresh

This architecture is the foundation for P2P real-time collaboration.

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and event-based cache invalidation
- [PROVIDERS.md](PROVIDERS.md) - ApiClientProvider setup
- [TESTING.md](TESTING.md) - Testing API hooks
- [@semiont/api-client](../../api-client) - API client documentation
