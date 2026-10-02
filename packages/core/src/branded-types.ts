/**
 * Branded string types for compile-time type safety
 *
 * These types are zero-cost at runtime but prevent mixing
 * different string types at compile time.
 */

import type { components } from './types';

// ============================================================================
// OPENAPI-GENERATED TYPES (use directly from spec)
// ============================================================================

export type Motivation = components['schemas']['Motivation'];
export type ContentFormat = components['schemas']['ContentFormat'];

// ============================================================================
// AUTHENTICATION & TOKENS
// ============================================================================

export type Email = string & { readonly __brand: 'Email' };
export type AuthCode = string & { readonly __brand: 'AuthCode' };
export type AccessToken = string & { readonly __brand: 'AccessToken' };
export type MCPToken = string & { readonly __brand: 'MCPToken' };
export type CloneToken = string & { readonly __brand: 'CloneToken' };

// ============================================================================
// SYSTEM IDENTIFIERS
// ============================================================================

export type EntityType = string & { readonly __brand: 'EntityType' };
export type SearchQuery = string & { readonly __brand: 'SearchQuery' };
export type BaseUrl = string & { readonly __brand: 'BaseUrl' };

// ============================================================================
// HELPER FUNCTIONS (minimal validation, just branding)
// ============================================================================

export function email(value: string): Email { return value as Email; }
export function authCode(value: string): AuthCode { return value as AuthCode; }
export function accessToken(value: string): AccessToken { return value as AccessToken; }
export function mcpToken(value: string): MCPToken { return value as MCPToken; }
export function cloneToken(value: string): CloneToken { return value as CloneToken; }
export function entityType(value: string): EntityType { return value as EntityType; }
export function searchQuery(value: string): SearchQuery { return value as SearchQuery; }
export function baseUrl(value: string): BaseUrl { return value as BaseUrl; }

// Motivation is an OpenAPI enum — use its values directly, no helper needed.
// ContentFormat is a free-form MIME string whose base type must be a
// SupportedMediaType; validation lives in media-types.ts, not in a brand.
