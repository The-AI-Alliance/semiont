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

/**
 * The scope a system event is logged under — a fact about the knowledge base
 * rather than about any resource: the entity-type and tag-schema vocabulary,
 * and who the people in the record are.
 *
 * Typed as a `ResourceId` because that is how it is USED. The event log is
 * keyed by resource and this is the key system events take: `getEvents` takes
 * it, `appendEvent` falls back to it when an event names no resource, sharding
 * skips it, and the projections it produces live in a directory named after
 * it (`projections/__system__/`). Being a branded string it also passes
 * straight to `path.join`, so the one constant covers both readings — the same
 * way a resource's own projections live under its own id.
 *
 * **Tests that pin the on-disk layout keep the literal, deliberately.** They
 * are the gate on this value: production code says `SYSTEM_SCOPE` so that
 * nothing spells it a seventeenth time, and a test asserting
 * `events/__system__/` fails if the constant is ever changed — which it must,
 * because every deployed knowledge base has that directory on disk.
 */
export const SYSTEM_SCOPE = '__system__' as ResourceId;
