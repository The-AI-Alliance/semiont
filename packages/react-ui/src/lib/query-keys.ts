/**
 * Centralized query keys for React Query
 * Following TanStack Query best practices for type-safe cache invalidation
 * @see https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
 *
 * Keys use semantic names (not URL paths) and are properly typed with 'as const'
 */

import type { ResourceId, AnnotationId } from '@semiont/core';

export const QUERY_KEYS = {
  users: {
    me: () => ['users', 'me'] as const,
  },

  health: () => ['health'] as const,
  status: () => ['status'] as const,

  resources: {
    all: (limit?: number, archived?: boolean) => ['resources', { limit, archived }] as const,
    detail: (id: ResourceId) => ['resources', id] as const,
    byToken: (token: string) => ['resources', 'by-token', token] as const,
    events: (id: ResourceId) => ['resources', id, 'events'] as const,
    annotations: (id: ResourceId) => ['resources', id, 'annotations'] as const,
    referencedBy: (id: ResourceId) => ['resources', id, 'referenced-by'] as const,
    representation: (id: ResourceId) => ['resources', id, 'representation'] as const,
    mediaToken: (id: ResourceId) => ['resources', id, 'media-token'] as const,
  },

  annotations: {
    detail: (id: AnnotationId) => ['annotations', id] as const,
    history: (resourceId: ResourceId, annotationId: AnnotationId) => ['annotations', resourceId, annotationId, 'history'] as const,
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
};
