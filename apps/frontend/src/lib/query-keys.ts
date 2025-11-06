/**
 * Centralized query keys for React Query
 * Following TanStack Query best practices for type-safe cache invalidation
 * @see https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
 *
 * Keys use semantic names (not URL paths) and are properly typed with 'as const'
 */

import type { ResourceUri, AnnotationUri, ResourceAnnotationUri } from '@semiont/api-client';

export const QUERY_KEYS = {
  users: {
    me: () => ['users', 'me'] as const,
  },

  health: () => ['health'] as const,
  status: () => ['status'] as const,

  resources: {
    all: (limit?: number, archived?: boolean) => ['resources', { limit, archived }] as const,
    detail: (rUri: ResourceUri) => ['resources', rUri] as const,
    byToken: (token: string) => ['resources', 'by-token', token] as const,
    search: (query: string, limit: number) => ['resources', 'search', { query, limit }] as const,
    events: (rUri: ResourceUri) => ['resources', rUri, 'events'] as const,
    annotations: (rUri: ResourceUri) => ['resources', rUri, 'annotations'] as const,
    referencedBy: (rUri: ResourceUri) => ['resources', rUri, 'referenced-by'] as const,
  },

  annotations: {
    detail: (aUri: AnnotationUri) => ['annotations', aUri] as const,
    history: (aUri: ResourceAnnotationUri) => ['annotations', aUri, 'history'] as const,
  },

  entityTypes: {
    all: () => ['entity-types'] as const,
  },

  admin: {
    users: {
      all: () => ['admin', 'users'] as const,
      stats: () => ['admin', 'users', 'stats'] as const,
    },
    oauth: {
      config: () => ['admin', 'oauth', 'config'] as const,
    },
  },

  // Legacy alias for backward compatibility during migration
  // TODO: Remove after all components migrate to QUERY_KEYS.resources
  documents: {
    all: (limit?: number, archived?: boolean) => ['resources', { limit, archived }] as const,
    detail: (rUri: ResourceUri) => ['resources', rUri] as const,
    byToken: (token: string) => ['resources', 'by-token', token] as const,
    search: (query: string, limit: number) => ['resources', 'search', { query, limit }] as const,
    events: (rUri: ResourceUri) => ['resources', rUri, 'events'] as const,
    annotations: (rUri: ResourceUri) => ['resources', rUri, 'annotations'] as const,
    referencedBy: (rUri: ResourceUri) => ['resources', rUri, 'referenced-by'] as const,
  },
};
