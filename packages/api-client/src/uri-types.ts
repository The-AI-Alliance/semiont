/**
 * Branded URI types for compile-time type safety.
 *
 * These types are in api-client because they deal with HTTP URIs
 * returned by the API, not internal IDs.
 */

// Branded type definitions for URIs
export type ResourceUri = string & { readonly __brand: 'ResourceUri' };
export type AnnotationUri = string & { readonly __brand: 'AnnotationUri' };

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
