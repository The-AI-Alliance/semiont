/**
 * Branded string types for compile-time type safety
 *
 * These types are zero-cost at runtime but prevent mixing
 * different string types at compile time.
 */
import type { components } from './types';
export type Motivation = components['schemas']['Motivation'];
export type ContentFormat = components['schemas']['ContentFormat'];
export type Email = string & {
    readonly __brand: 'Email';
};
export type AuthCode = string & {
    readonly __brand: 'AuthCode';
};
export type GoogleCredential = string & {
    readonly __brand: 'GoogleCredential';
};
export type AccessToken = string & {
    readonly __brand: 'AccessToken';
};
export type RefreshToken = string & {
    readonly __brand: 'RefreshToken';
};
export type MCPToken = string & {
    readonly __brand: 'MCPToken';
};
export type CloneToken = string & {
    readonly __brand: 'CloneToken';
};
export type JobId = string & {
    readonly __brand: 'JobId';
};
export type UserDID = string & {
    readonly __brand: 'UserDID';
};
export type EntityType = string & {
    readonly __brand: 'EntityType';
};
export type SearchQuery = string & {
    readonly __brand: 'SearchQuery';
};
export type BaseUrl = string & {
    readonly __brand: 'BaseUrl';
};
export declare function email(value: string): Email;
export declare function authCode(value: string): AuthCode;
export declare function googleCredential(value: string): GoogleCredential;
export declare function accessToken(value: string): AccessToken;
export declare function refreshToken(value: string): RefreshToken;
export declare function mcpToken(value: string): MCPToken;
export declare function cloneToken(value: string): CloneToken;
export declare function jobId(value: string): JobId;
export declare function userDID(value: string): UserDID;
export declare function entityType(value: string): EntityType;
export declare function searchQuery(value: string): SearchQuery;
export declare function baseUrl(value: string): BaseUrl;
export type ResourceUri = string & {
    readonly __brand: 'ResourceUri';
};
export type AnnotationUri = string & {
    readonly __brand: 'AnnotationUri';
};
export type ResourceAnnotationUri = string & {
    readonly __brand: 'ResourceAnnotationUri';
};
export declare function resourceUri(uri: string): ResourceUri;
export declare function annotationUri(uri: string): AnnotationUri;
export declare function resourceAnnotationUri(uri: string): ResourceAnnotationUri;
