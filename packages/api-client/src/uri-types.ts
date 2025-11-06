/**
 * Branded URI types for compile-time type safety.
 *
 * These types are in api-client because they deal with HTTP URIs
 * returned by the API, not internal IDs.
 */

// Branded type definitions for URIs
export type ResourceUri = string & { readonly __brand: 'ResourceUri' };

// W3C flat format for content negotiation: http://localhost:4000/annotations/{id}
export type AnnotationUri = string & { readonly __brand: 'AnnotationUri' };

// Nested format for CRUD operations: http://localhost:4000/resources/{resourceId}/annotations/{annotationId}
export type ResourceAnnotationUri = string & { readonly __brand: 'ResourceAnnotationUri' };

// Factory functions with runtime validation
export function resourceUri(uri: string): ResourceUri {
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
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

export function resourceAnnotationUri(uri: string): ResourceAnnotationUri {
  if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
    throw new TypeError(`Expected ResourceAnnotationUri, got: ${uri}`);
  }
  // Additional validation: must contain /resources/ and /annotations/
  if (!uri.includes('/resources/') || !uri.includes('/annotations/')) {
    throw new TypeError(`Expected nested ResourceAnnotationUri format, got: ${uri}`);
  }
  return uri as ResourceAnnotationUri;
}
