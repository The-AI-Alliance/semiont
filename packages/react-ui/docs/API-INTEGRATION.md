# API Integration

Guide to working with the Semiont API using `@semiont/react-ui` hooks.

## Overview

The library provides **React Query hooks** for all Semiont API operations. These hooks:

- ✅ Handle authentication automatically (via ApiClientContext)
- ✅ Manage loading, error, and success states
- ✅ Cache responses intelligently
- ✅ Retry failed requests (configurable)
- ✅ Invalidate related queries on mutations
- ✅ Are fully type-safe with TypeScript

## Setup

### 1. Configure API Client Provider

```tsx
import { ApiClientProvider } from '@semiont/react-ui';
import { SemiontApiClient, baseUrl, accessToken } from '@semiont/api-client';

function useApiClientManager() {
  const { data: session } = useSession(); // Your auth system

  const client = useMemo(() => {
    if (!session?.backendToken) return null;

    return new SemiontApiClient({
      baseUrl: baseUrl(''), // Relative URLs for browser
      accessToken: accessToken(session.backendToken),
      timeout: 30000
    });
  }, [session?.backendToken]);

  return { client };
}

// In your app
<ApiClientProvider apiClientManager={apiClientManager}>
  {children}
</ApiClientProvider>
```

### 2. Configure React Query

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dispatch401Error, dispatch403Error } from '@semiont/react-ui';
import { APIError } from '@semiont/api-client';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof APIError) {
        if (error.status === 401) {
          dispatch401Error('Your session has expired');
        } else if (error.status === 403) {
          dispatch403Error('Permission denied');
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
function ResourceDetail({ rUri }) {
  const resources = useResources();
  const { data: resource } = resources.get.useQuery(rUri);

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
function EditResource({ rUri }) {
  const resources = useResources();
  const { mutate } = resources.update.useMutation();

  const handleSave = (updates) => {
    mutate({
      rUri,
      data: { name: updates.name }
    });
  };

  return <button onClick={() => handleSave({ name: 'New Name' })}>Save</button>;
}
```

**Available Operations:**
- `resources.list.useQuery()` - List resources
- `resources.get.useQuery(rUri)` - Get single resource
- `resources.search.useQuery(query, limit)` - Search resources
- `resources.events.useQuery(rUri)` - Get resource events
- `resources.annotations.useQuery(rUri)` - Get resource annotations
- `resources.referencedBy.useQuery(rUri)` - Get referencing resources
- `resources.create.useMutation()` - Create resource
- `resources.update.useMutation()` - Update resource
- `resources.generateCloneToken.useMutation()` - Generate clone token
- `resources.getByToken.useQuery(token)` - Get resource by token
- `resources.createFromToken.useMutation()` - Clone resource

---

### useAnnotations()

Manage annotations on resources

**Get Annotations:**

```tsx
import { useAnnotations } from '@semiont/react-ui';

function AnnotationsList({ rUri }) {
  const resources = useResources();
  const { data: annotations } = resources.annotations.useQuery(rUri);

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
function AddAnnotation({ rUri }) {
  const annotations = useAnnotations();
  const { mutate } = annotations.create.useMutation();

  const addHighlight = () => {
    mutate({
      rUri,
      data: {
        type: 'Annotation',
        motivation: 'highlighting',
        target: {
          source: rUri,
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
function DeleteAnnotationButton({ annotationUri }) {
  const annotations = useAnnotations();
  const { mutate } = annotations.delete.useMutation();

  return (
    <button onClick={() => mutate(annotationUri)}>
      Delete
    </button>
  );
}
```

**Available Operations:**
- `annotations.get.useQuery(annotationUri)` - Get annotation
- `annotations.getResourceAnnotation.useQuery(annotationUri)` - Get resource annotation
- `annotations.history.useQuery(annotationUri)` - Get annotation history
- `annotations.llmContext.useQuery(resourceUri, annotationId, options)` - Get LLM context
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

// Document queries
QUERY_KEYS.documents.all(limit, archived)
QUERY_KEYS.documents.detail(rUri)
QUERY_KEYS.documents.events(rUri)
QUERY_KEYS.documents.annotations(rUri)
QUERY_KEYS.documents.search(query, limit)

// Annotation queries
QUERY_KEYS.annotations.history(annotationUri)
QUERY_KEYS.annotations.llmContext(resourceUri, annotationId)

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
          dispatch401Error('Session expired');
        } else if (error.status === 403) {
          dispatch403Error('Permission denied');
        }
      }
    },
  }),
});
```

### Per-Query Error Handling

```tsx
const { data, error } = resources.get.useQuery(rUri, {
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
function ToggleFavorite({ rUri }) {
  const resources = useResources();
  const queryClient = useQueryClient();
  const { mutate } = resources.update.useMutation();

  const toggle = () => {
    mutate({
      rUri,
      data: { isFavorite: !currentValue }
    }, {
      // Optimistically update the cache
      onMutate: async (variables) => {
        await queryClient.cancelQueries({
          queryKey: QUERY_KEYS.documents.detail(rUri)
        });

        const previous = queryClient.getQueryData(
          QUERY_KEYS.documents.detail(rUri)
        );

        queryClient.setQueryData(
          QUERY_KEYS.documents.detail(rUri),
          (old) => ({ ...old, isFavorite: variables.data.isFavorite })
        );

        return { previous };
      },
      // Rollback on error
      onError: (err, variables, context) => {
        queryClient.setQueryData(
          QUERY_KEYS.documents.detail(rUri),
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
import { SemiontApiClient } from '@semiont/api-client';

it('should fetch resources', async () => {
  const mockClient = new SemiontApiClient({ ... });
  vi.spyOn(mockClient, 'listResources').mockResolvedValue({
    resources: [{ id: 'r1', name: 'Test' }]
  });

  renderWithProviders(<ResourceList />, {
    apiClientManager: { client: mockClient }
  });

  await screen.findByText('Test');
});
```

## Best Practices

### ✅ Do: Enable queries conditionally

```tsx
const { data } = resources.get.useQuery(rUri, {
  enabled: !!rUri && isAuthenticated
});
```

### ✅ Do: Invalidate related queries

```tsx
const { mutate } = annotations.create.useMutation();

mutate(data, {
  onSuccess: () => {
    queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.documents.annotations(rUri)
    });
  }
});
```

### ✅ Do: Use React Query devtools (development)

```tsx
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

<QueryClientProvider client={queryClient}>
  {children}
  <ReactQueryDevtools initialIsOpen={false} />
</QueryClientProvider>
```

### ❌ Don't: Call useApiClient() directly in components

```tsx
// WRONG
const client = useApiClient();
const resources = await client.listResources();

// CORRECT
const resources = useResources();
const { data } = resources.list.useQuery();
```

### ❌ Don't: Ignore loading states

```tsx
// WRONG
const { data } = resources.list.useQuery();
return <div>{data.map(...)}</div>; // ❌ data might be undefined

// CORRECT
const { data, isLoading } = resources.list.useQuery();
if (isLoading) return <Spinner />;
return <div>{data?.map(...) ?? []}</div>;
```

### ✅ Do: Use event-based cache invalidation

```tsx
// ❌ OLD: Manual cache invalidation after mutations
const { mutate } = annotations.create.useMutation();

mutate(data, {
  onSuccess: () => {
    // Manual refetch after every mutation
    queryClient.invalidateQueries({ queryKey: ['annotations', rUri] });
  }
});

// ✅ NEW: Event-based cache invalidation (automatic)
import { useMakeMeaningEvents } from '@semiont/react-ui';

function AnnotationCacheSync({ rUri }: { rUri: ResourceUri }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Backend events automatically trigger cache invalidation
    const handleAnnotationAdded = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    eventBus.on('annotation:added', handleAnnotationAdded);
    return () => eventBus.off('annotation:added', handleAnnotationAdded);
  }, [eventBus, queryClient, rUri]);

  return null;
}

// No more manual invalidation in mutation callbacks!
const { mutate } = annotations.create.useMutation();
mutate(data); // Cache updates automatically via events
```

**Benefits:**

- ✅ Zero manual `refetch()` calls in mutation callbacks
- ✅ Automatic cache updates from backend SSE events
- ✅ Real-time updates when other users make changes
- ✅ Consistent cache state across all components

See [EVENTS.md](EVENTS.md) for complete event-driven architecture documentation.

---

## Event-Based Cache Invalidation

The library uses **event-driven cache invalidation** instead of manual refetch calls. Backend events flow through the `MakeMeaningEventBusProvider` and automatically trigger React Query cache updates.

### Backend Events

These events are emitted by the backend via SSE and automatically invalidate relevant caches:

**Detection Events:**
- `detection:started` → Show detection progress
- `detection:progress` → Update progress indicators
- `detection:entity-found` → Invalidate annotations cache
- `detection:completed` → Invalidate annotations cache
- `detection:failed` → Show error notification

**Generation Events:**
- `generation:started` → Show generation progress
- `generation:progress` → Update progress indicators
- `generation:resource-created` → Invalidate resources list
- `generation:completed` → Invalidate resources list

**Annotation Events:**
- `annotation:added` → Invalidate annotations cache
- `annotation:removed` → Invalidate annotations cache
- `annotation:updated` → Invalidate annotation detail cache

**Entity Tag Events:**
- `entity-tag:added` → Invalidate annotations cache
- `entity-tag:removed` → Invalidate annotations cache

**Resource Events:**
- `resource:archived` → Invalidate resource cache
- `resource:unarchived` → Invalidate resource cache

### Setup Event-Based Invalidation

Wrap resource pages with `MakeMeaningEventBusProvider` and subscribe to events:

```tsx
import { MakeMeaningEventBusProvider, useMakeMeaningEvents } from '@semiont/react-ui';
import { useQueryClient } from '@tanstack/react-query';

// 1. Wrap resource page with event bus provider
export default function ResourcePage({ params }: { params: { id: string } }) {
  const rUri = resourceUri(params.id);

  return (
    <MakeMeaningEventBusProvider rUri={rUri}>
      <ResourceCacheSync rUri={rUri} />
      <ResourceViewerPage rUri={rUri} />
    </MakeMeaningEventBusProvider>
  );
}

// 2. Create cache sync component that subscribes to events
function ResourceCacheSync({ rUri }: { rUri: ResourceUri }) {
  const eventBus = useMakeMeaningEvents();
  const queryClient = useQueryClient();

  useEffect(() => {
    // Annotation events
    const handleAnnotationChange = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    // Detection events
    const handleDetectionComplete = () => {
      queryClient.invalidateQueries(['annotations', rUri]);
    };

    // Resource events
    const handleResourceChange = () => {
      queryClient.invalidateQueries(['resources', rUri]);
    };

    // Subscribe to all relevant events
    eventBus.on('annotation:added', handleAnnotationChange);
    eventBus.on('annotation:removed', handleAnnotationChange);
    eventBus.on('annotation:updated', handleAnnotationChange);
    eventBus.on('detection:completed', handleDetectionComplete);
    eventBus.on('resource:archived', handleResourceChange);
    eventBus.on('resource:unarchived', handleResourceChange);

    return () => {
      // Cleanup all subscriptions
      eventBus.off('annotation:added', handleAnnotationChange);
      eventBus.off('annotation:removed', handleAnnotationChange);
      eventBus.off('annotation:updated', handleAnnotationChange);
      eventBus.off('detection:completed', handleDetectionComplete);
      eventBus.off('resource:archived', handleResourceChange);
      eventBus.off('resource:unarchived', handleResourceChange);
    };
  }, [eventBus, queryClient, rUri]);

  return null;
}
```

### Migration from Manual Invalidation

**Before (Manual Refetch):**

```tsx
// ❌ OLD: Manual cache invalidation in every mutation
const { mutate: createAnnotation } = annotations.create.useMutation();
const { mutate: deleteAnnotation } = annotations.delete.useMutation();
const { mutate: updateAnnotation } = annotations.updateBody.useMutation();

// Each mutation manually invalidates cache
createAnnotation(data, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rUri]);
  }
});

deleteAnnotation(annotationUri, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rUri]);
  }
});

updateAnnotation(data, {
  onSuccess: () => {
    queryClient.invalidateQueries(['annotations', rUri]);
  }
});
```

**After (Event-Based):**

```tsx
// ✅ NEW: Zero manual invalidation, events handle it
const { mutate: createAnnotation } = annotations.create.useMutation();
const { mutate: deleteAnnotation } = annotations.delete.useMutation();
const { mutate: updateAnnotation } = annotations.updateBody.useMutation();

// Just call mutations - events handle cache invalidation automatically
createAnnotation(data);
deleteAnnotation(annotationUri);
updateAnnotation(data);

// Backend emits events → EventBus → ResourceCacheSync → Cache invalidated
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
2. **Backend** emits `annotation:added` event via SSE
3. **EventBus** receives event and broadcasts to all subscribers
4. **User B's cache** automatically invalidates via event subscription
5. **User B sees update** without manual refresh

This architecture is the foundation for P2P real-time collaboration.

## See Also

- [EVENTS.md](EVENTS.md) - Event-driven architecture and event-based cache invalidation
- [PROVIDERS.md](PROVIDERS.md) - ApiClientProvider setup
- [TESTING.md](TESTING.md) - Testing API hooks
- [@semiont/api-client](../../api-client) - API client documentation
