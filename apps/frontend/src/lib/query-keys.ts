/**
 * Centralized query keys for React Query
 * Following TanStack Query best practices for type-safe cache invalidation
 * @see https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
 */
export const QUERY_KEYS = {
  auth: {
    me: () => ['/api/auth/me'],
  },
  health: () => ['/api/health'],
  admin: {
    users: {
      all: () => ['/api/admin/users'],
      stats: () => ['/api/admin/users/stats'],
    },
    oauth: {
      config: () => ['/api/admin/oauth/config'],
    },
  },
  entityTypes: {
    all: () => ['/api/entity-types'],
  },
  documents: {
    all: (limit?: number, archived?: boolean) => ['/api/documents', limit, archived],
    detail: (id: string) => ['/api/documents', id],
    byToken: (token: string) => ['/api/documents/by-token', token],
    search: (query: string, limit: number) => ['/api/documents/search', query, limit],
    referencedBy: (id: string) => ['/api/documents', id, 'referenced-by'],
    events: (id: string) => ['/api/documents', id, 'events'],
    annotations: (documentId: string) => ['/api/documents', documentId, 'annotations'],
  },
};
