/**
 * Branded identifier types for compile-time type safety.
 *
 * These types prevent mixing up resource IDs, resource URIs, annotation IDs,
 * and annotation URIs at compile time while having zero runtime overhead.
 */

// Branded type definitions
export type ResourceId = string & { readonly __brand: 'ResourceId' };
export type ResourceUri = string & { readonly __brand: 'ResourceUri' };
export type AnnotationId = string & { readonly __brand: 'AnnotationId' };
export type AnnotationUri = string & { readonly __brand: 'AnnotationUri' };
export type UserId = string & { readonly __brand: 'UserId' };

// Type guards with runtime validation
export function isResourceUri(value: string): value is ResourceUri {
  return value.startsWith('http://') || value.startsWith('https://');
}

export function isResourceId(value: string): value is ResourceId {
  return !value.includes('/');
}

export function isAnnotationUri(value: string): value is AnnotationUri {
  return value.startsWith('http://') || value.startsWith('https://');
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

export function resourceUri(uri: string): ResourceUri {
  if (!isResourceUri(uri)) {
    throw new TypeError(`Expected ResourceUri, got: ${uri}`);
  }
  return uri as ResourceUri;
}

export function annotationId(id: string): AnnotationId {
  if (id.includes('/')) {
    throw new TypeError(`Expected AnnotationId, got URI: ${id}`);
  }
  return id as AnnotationId;
}

export function annotationUri(uri: string): AnnotationUri {
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    throw new TypeError(`Expected AnnotationUri, got: ${uri}`);
  }
  return uri as AnnotationUri;
}

export function userId(id: string): UserId {
  return id as UserId;
}
