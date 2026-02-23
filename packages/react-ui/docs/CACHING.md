# Caching Architecture

**Last Updated:** February 12, 2026

---

## Overview

The `@semiont/react-ui` package uses three coordinated systems:

1. **React Query** - Server state management and caching
2. **Event Bus** - Component coordination without prop drilling
3. **API Client** - HTTP operations with typed responses

This document explains how they work together and patterns for optimal performance.

---

## React Query Cache Strategy

### Cache Keys

All cache keys are centralized in [lib/query-keys.ts](../src/lib/query-keys.ts):

```typescript
QUERY_KEYS.documents.all()                    // All resources
QUERY_KEYS.documents.detail(resourceUri)      // Single resource
QUERY_KEYS.documents.annotations(resourceUri) // Resource annotations
QUERY_KEYS.documents.events(resourceUri)      // Resource events
QUERY_KEYS.documents.referencedBy(resourceUri)// Referenced by list
```

### Two Cache Update Strategies

**1. Invalidate (Refetch from Server)**
```typescript
queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.all() });
```
Use when:
- API doesn't return the updated object
- Multiple caches need synchronization
- Complex relationships between entities

**2. Direct Update (Use API Response)**
```typescript
queryClient.setQueryData(queryKey, newData);
```
Use when:
- API returns the full updated object
- Cache structure is simple (list or object)
- No cross-entity side effects

---

## Mutation Patterns

### Pattern 1: Create with Direct Cache Update

**File:** [lib/api-hooks.ts:205-219](../src/lib/api-hooks.ts#L205-L219)

```typescript
useMutation({
  mutationFn: (data) => client.createAnnotation(resourceUri, data),
  onSuccess: (response, variables) => {
    const queryKey = QUERY_KEYS.documents.annotations(variables.rUri);
    const currentData = queryClient.getQueryData(queryKey);

    if (currentData && response.annotation) {
      // Update cache with returned annotation
      queryClient.setQueryData(queryKey, {
        ...currentData,
        annotations: [...currentData.annotations, response.annotation]
      });
    } else {
      // Fallback: refetch if cache is missing
      queryClient.invalidateQueries({ queryKey });
    }
  }
})
```

**Benefits:**
- Eliminates refetch (66% faster)
- Instant UI update
- Uses server's authoritative data

### Pattern 2: Delete with Surgical Cache Update

**File:** [lib/api-hooks.ts:233-250](../src/lib/api-hooks.ts#L233-L250)

```typescript
useMutation({
  mutationFn: (variables) => client.deleteAnnotation(variables.annotationUri),
  onSuccess: (_, variables) => {
    const queryKey = QUERY_KEYS.documents.annotations(variables.resourceUri);
    const currentData = queryClient.getQueryData(queryKey);

    if (currentData) {
      const annotationId = variables.annotationUri.split('/').pop();
      // Filter out deleted annotation
      queryClient.setQueryData(queryKey, {
        ...currentData,
        annotations: currentData.annotations.filter(ann => ann.id !== annotationId)
      });
    } else {
      queryClient.invalidateQueries({ queryKey });
    }
  }
})
```

**Benefits:**
- No broad invalidation
- Instant removal from UI
- Targeted cache updates only

### Pattern 3: Update with Replacement

**File:** [lib/api-hooks.ts:268-305](../src/lib/api-hooks.ts#L268-L305)

```typescript
useMutation({
  mutationFn: (variables) => client.updateAnnotationBody(variables.annotationUri, variables.data),
  onSuccess: (response, variables) => {
    // 1. Update single annotation cache
    queryClient.setQueryData(['annotations', variables.annotationUri], response.annotation);

    // 2. Update resource annotations list
    const resourceUri = extractResourceUriFromAnnotationUri(variables.annotationUri);
    const listQueryKey = QUERY_KEYS.documents.annotations(resourceUri);
    const currentList = queryClient.getQueryData(listQueryKey);

    if (currentList && response.annotation) {
      // Replace annotation in list
      queryClient.setQueryData(listQueryKey, {
        ...currentList,
        annotations: currentList.annotations.map(ann =>
          ann.id === response.annotation.id ? response.annotation : ann
        )
      });
    }

    // 3. Handle cross-resource side effects
    // (e.g., invalidate referencedBy for added references)
  }
})
```

**Benefits:**
- No mass invalidation
- Handles cross-resource updates correctly
- 50% fewer network requests

---

## Event Bus Integration

### When to Use Events vs Cache Updates

**Use Events for:**
- UI coordination (hover, selection, panel toggle)
- User interactions that don't modify server state
- Cross-component communication

**Use Cache Updates for:**
- Server state changes (CRUD operations)
- Data synchronization
- Triggering component re-renders with new data

### Example: Annotation Creation Flow

```typescript
// 1. User clicks "Save" → Event emitted
eventBus.emit('annotate:create, { motivation, selector, body });

// 2. Event handler calls API mutation
const mutation = useAnnotations().create.useMutation();
await mutation.mutateAsync({ rUri, data });

// 3. Mutation updates cache directly (no refetch)
queryClient.setQueryData(queryKey, newAnnotations);

// 4. Components re-render with updated data (automatic via React Query)
```

**Key insight:** Events trigger actions, cache updates trigger renders.

---

## Anti-Patterns to Avoid

### ❌ Broad Invalidation
```typescript
// BAD: Invalidates ALL resources
queryClient.invalidateQueries({ queryKey: ['documents'] });
```

**Why it's bad:** Forces every open resource to refetch unnecessarily.

**Fix:** Target specific resource:
```typescript
// GOOD: Invalidates only affected resource
queryClient.invalidateQueries({
  queryKey: QUERY_KEYS.documents.annotations(resourceUri)
});
```

### ❌ Ignoring API Response
```typescript
// BAD: Throws away API response, then refetches
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey });
}
```

**Fix:** Use the response:
```typescript
// GOOD: Uses returned data directly
onSuccess: (response) => {
  if (response.annotation) {
    queryClient.setQueryData(queryKey, response.annotation);
  }
}
```

### ❌ Missing Fallback
```typescript
// BAD: Assumes cache exists
queryClient.setQueryData(queryKey, newData);
```

**Fix:** Always provide fallback:
```typescript
// GOOD: Handles cache miss
if (currentData) {
  queryClient.setQueryData(queryKey, newData);
} else {
  queryClient.invalidateQueries({ queryKey });
}
```

---

## Performance Metrics

### Before Optimizations
- Annotation creation: ~300ms (POST + GET + re-render)
- Network requests: 2 per operation
- Mass invalidation caused unrelated resources to refetch

### After Optimizations
- Annotation creation: ~100ms (POST + re-render)
- Network requests: 1 per operation
- Surgical updates only affect changed resources

**Impact:** 66% faster operations, 50% fewer network requests

---

## References

- [React Query Cache Management](https://tanstack.com/query/latest/docs/react/guides/caching)
- [lib/api-hooks.ts](../src/lib/api-hooks.ts) - Mutation implementations
- [lib/query-keys.ts](../src/lib/query-keys.ts) - Cache key definitions
- [contexts/EventBusContext.tsx](../src/contexts/EventBusContext.tsx) - Event coordination
