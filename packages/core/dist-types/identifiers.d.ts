/**
 * Branded identifier types for compile-time type safety.
 *
 * These types prevent mixing up resource IDs, annotation IDs, and user IDs
 * at compile time while having zero runtime overhead.
 *
 * URI types (ResourceUri, AnnotationUri) are in @semiont/http-transport
 * since they deal with HTTP URIs returned by the API.
 */
export type ResourceId = string & {
    readonly __brand: 'ResourceId';
};
export type AnnotationId = string & {
    readonly __brand: 'AnnotationId';
};
export type UserId = string & {
    readonly __brand: 'UserId';
};
export declare function isResourceId(value: string): value is ResourceId;
export declare function isAnnotationId(value: string): value is AnnotationId;
export declare function resourceId(id: string): ResourceId;
export declare function annotationId(id: string): AnnotationId;
export declare function userId(id: string): UserId;
