/**
 * Branded URI types for compile-time type safety.
 *
 * These types are in api-client because they deal with HTTP URIs
 * returned by the API, not internal IDs.
 */

// Branded type definitions for URIs
export type ResourceUri = string & { readonly __brand: 'ResourceUri' };
export type AnnotationUri = string & { readonly __brand: 'AnnotationUri' };

// Type guards with runtime validation
export function isResourceUri(value: string): value is ResourceUri {
  return value.startsWith('http://') || value.startsWith('https://');
}

export function isAnnotationUri(value: string): value is AnnotationUri {
  return value.startsWith('http://') || value.startsWith('https://');
}

// Factory functions with runtime validation
export function resourceUri(uri: string): ResourceUri {
  if (!isResourceUri(uri)) {
    throw new TypeError(`Expected ResourceUri, got: ${uri}`);
  }
  return uri as ResourceUri;
}

export function annotationUri(uri: string): AnnotationUri {
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    throw new TypeError(`Expected AnnotationUri, got: ${uri}`);
  }
  return uri as AnnotationUri;
}

// Extract short IDs from URIs - returns plain strings
export function extractResourceId(uri: ResourceUri | string): string {
  const parts = (uri as string).split('/');
  const id = parts[parts.length - 1];
  if (!id) {
    throw new Error(`Cannot extract resource ID from URI: ${uri}`);
  }
  return id;
}

export function extractAnnotationId(uri: AnnotationUri | string): string {
  const parts = (uri as string).split('/');
  const id = parts[parts.length - 1];
  if (!id) {
    throw new Error(`Cannot extract annotation ID from URI: ${uri}`);
  }
  return id;
}
