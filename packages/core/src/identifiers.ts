/**
 * Branded identifier types for compile-time type safety.
 *
 * These types prevent mixing up resource IDs, annotation IDs, and user IDs
 * at compile time while having zero runtime overhead.
 *
 * URI types (ResourceUri, AnnotationUri) are in @semiont/http-transport
 * since they deal with HTTP URIs returned by the API.
 */

// Branded type definitions for IDs only
export type ResourceId = string & { readonly __brand: 'ResourceId' };
export type AnnotationId = string & { readonly __brand: 'AnnotationId' };
export type UserId = string & { readonly __brand: 'UserId' };

// Type guards with runtime validation
export function isResourceId(value: string): value is ResourceId {
  return !value.includes('/');
}

export function isAnnotationId(value: string): value is AnnotationId {
  return !value.includes('/');
}

// Factory functions with runtime validation
export function resourceId(id: string): ResourceId {
  if (id.includes('/')) {
    throw new TypeError(`Expected ResourceId, got URI: ${id}`);
  }
  return id as ResourceId;
}

export function annotationId(id: string): AnnotationId {
  if (id.includes('/')) {
    throw new TypeError(`Expected AnnotationId, got URI: ${id}`);
  }
  return id as AnnotationId;
}

/**
 * Brand a DID as the identity of whoever caused something.
 *
 * Validates, like its two siblings — a branded type whose constructor accepts
 * anything is a comment with extra syntax. Every value that reaches here is a
 * `did:` URI: the bus stamps `_userId` with the authenticated DID, events are
 * attributed to it, and `userToDid`/`agentToDid` are what produce them.
 *
 * It rejects the shape this identity USED to have. A bare `user-123` was a row
 * id in a table that no longer exists, and a bare email is not an identity
 * either — it is one input to `userToDid`.
 *
 * This is the entry-boundary brander (see `.plans/BRAND-UPSTREAM.md`): brand
 * once where a string arrives, not at every bus hop after.
 */
export function userId(id: string): UserId {
  if (!id.startsWith('did:')) {
    throw new TypeError(`Expected a DID, got: ${id}`);
  }
  return id as UserId;
}
