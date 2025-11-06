/**
 * Branded identifier types for compile-time type safety.
 *
 * These types prevent mixing up resource IDs, annotation IDs, and user IDs
 * at compile time while having zero runtime overhead.
 *
 * URI types (ResourceUri, AnnotationUri) are in @semiont/api-client
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

export function userId(id: string): UserId {
  return id as UserId;
}
