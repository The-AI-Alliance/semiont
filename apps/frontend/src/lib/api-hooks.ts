/**
 * React Query hooks for Semiont API
 *
 * Direct wrappers around SemiontApiClient with no intermediate layers.
 * Each hook returns an object with useQuery and/or useMutation methods.
 *
 * Pattern:
 * - useApiClient() provides authenticated client instance
 * - useResources() provides resource operations
 * - useAnnotations() provides annotation operations
 * - useEntityTypes() provides entity type operations
 * - useAdmin() provides admin operations
 */

import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  SemiontApiClient,
  type ResourceUri,
  type AnnotationUri,
  type ResourceAnnotationUri,
  baseUrl,
  accessToken,
  searchQuery,
  cloneToken,
  entityType,
  userDID
} from '@semiont/api-client';
import { NEXT_PUBLIC_API_URL } from './env';
import { QUERY_KEYS } from './query-keys';

/**
 * Get authenticated API client instance
 * Returns null if not authenticated
 */
export function useApiClient(): SemiontApiClient | null {
  const { data: session } = useSession();

  if (!session?.backendToken) {
    return null;
  }

  return new SemiontApiClient({
    baseUrl: baseUrl(NEXT_PUBLIC_API_URL),
    accessToken: accessToken(session.backendToken),
    // Use no timeout in test environment to avoid AbortController issues with ky + vitest
    ...(process.env.NODE_ENV !== 'test' && { timeout: 30000 }),
  });
}

/**
 * Resource operations
 */
export function useResources() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return {
    list: {
      useQuery: (options?: { limit?: number; archived?: boolean; query?: string }) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.all(options?.limit, options?.archived),
          queryFn: () => client!.listResources(options?.limit, options?.archived, options?.query ? searchQuery(options.query) : undefined),
          enabled: !!client,
        }),
    },

    get: {
      useQuery: (rUri: ResourceUri, options?: Omit<UseQueryOptions, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.detail(rUri),
          queryFn: () => client!.getResource(rUri),
          enabled: !!client && !!rUri,
          ...options,
        }),
    },

    events: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.events(rUri),
          queryFn: () => client!.getResourceEvents(rUri),
          enabled: !!client && !!rUri,
        }),
    },

    annotations: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.annotations(rUri),
          queryFn: () => client!.getResourceAnnotations(rUri),
          enabled: !!client && !!rUri,
        }),
    },

    referencedBy: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.referencedBy(rUri),
          queryFn: () => client!.getResourceReferencedBy(rUri),
          enabled: !!client && !!rUri,
        }),
    },

    search: {
      useQuery: (query: string, limit: number) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.search(query, limit),
          queryFn: () => client!.listResources(limit, undefined, searchQuery(query)),
          enabled: !!client && !!query,
        }),
    },

    create: {
      useMutation: () =>
        useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['createResource']>[0]) => client!.createResource(data),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        }),
    },

    update: {
      useMutation: () =>
        useMutation({
          mutationFn: ({ rUri, data }: { rUri: ResourceUri; data: Parameters<SemiontApiClient['updateResource']>[1] }) =>
            client!.updateResource(rUri, data),
          onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.rUri) });
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        }),
    },

    generateCloneToken: {
      useMutation: () =>
        useMutation({
          mutationFn: (rUri: ResourceUri) => client!.generateCloneToken(rUri),
        }),
    },

    getByToken: {
      useQuery: (token: string) =>
        useQuery({
          queryKey: ['resources', 'token', token],
          queryFn: () => client!.getResourceByToken(cloneToken(token)),
          enabled: !!client && !!token,
        }),
    },

    createFromToken: {
      useMutation: () =>
        useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['createResourceFromToken']>[0]) =>
            client!.createResourceFromToken(data),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        }),
    },
  };
}

/**
 * Annotation operations
 */
export function useAnnotations() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return {
    get: {
      useQuery: (annotationUri: AnnotationUri) =>
        useQuery({
          queryKey: ['annotations', annotationUri],
          queryFn: () => client!.getAnnotation(annotationUri),
          enabled: !!client && !!annotationUri,
        }),
    },

    getResourceAnnotation: {
      useQuery: (annotationUri: ResourceAnnotationUri) =>
        useQuery({
          queryKey: ['annotations', annotationUri],
          queryFn: () => client!.getResourceAnnotation(annotationUri),
          enabled: !!client && !!annotationUri,
        }),
    },

    history: {
      useQuery: (annotationUri: ResourceAnnotationUri) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.history(annotationUri),
          queryFn: () => client!.getAnnotationHistory(annotationUri),
          enabled: !!client && !!annotationUri,
        }),
    },

    create: {
      useMutation: () =>
        useMutation({
          mutationFn: ({
            rUri,
            data,
          }: {
            rUri: ResourceUri;
            data: Parameters<SemiontApiClient['createAnnotation']>[1];
          }) => client!.createAnnotation(rUri, data),
          onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(variables.rUri) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(variables.rUri) });
          },
        }),
    },

    delete: {
      useMutation: () =>
        useMutation({
          mutationFn: (annotationUri: ResourceAnnotationUri) => client!.deleteAnnotation(annotationUri),
          onSuccess: () => {
            // Invalidate all annotation and event queries
            queryClient.invalidateQueries({ queryKey: ['documents'] });
            queryClient.invalidateQueries({ queryKey: ['annotations'] });
          },
        }),
    },

    updateBody: {
      useMutation: () =>
        useMutation({
          mutationFn: ({
            annotationUri,
            data,
          }: {
            annotationUri: ResourceAnnotationUri;
            data: Parameters<SemiontApiClient['updateAnnotationBody']>[1];
          }) => client!.updateAnnotationBody(annotationUri, data),
          onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: ['annotations', variables.annotationUri] });
            // Also invalidate resource annotations list
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        }),
    },

    generateResource: {
      useMutation: () =>
        useMutation({
          mutationFn: ({
            annotationUri,
            data,
          }: {
            annotationUri: ResourceAnnotationUri;
            data: Parameters<SemiontApiClient['generateResourceFromAnnotation']>[1];
          }) => client!.generateResourceFromAnnotation(annotationUri, data),
          onSuccess: () => {
            // Invalidate documents list since a new resource was created
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        }),
    },
  };
}

/**
 * Entity type operations
 */
export function useEntityTypes() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  type EntityTypesResponse = Awaited<ReturnType<SemiontApiClient['listEntityTypes']>>;

  return {
    list: {
      useQuery: (options?: Omit<UseQueryOptions<EntityTypesResponse>, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.entityTypes.all(),
          queryFn: () => client!.listEntityTypes(),
          enabled: !!client,
          ...options,
        }),
    },

    add: {
      useMutation: () =>
        useMutation({
          mutationFn: (type: string) => client!.addEntityType(entityType(type)),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.entityTypes.all() });
          },
        }),
    },

    addBulk: {
      useMutation: () =>
        useMutation({
          mutationFn: (types: string[]) => client!.addEntityTypesBulk(types.map(entityType)),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.entityTypes.all() });
          },
        }),
    },
  };
}

/**
 * Admin operations
 */
export function useAdmin() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return {
    users: {
      list: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.all(),
            queryFn: () => client!.listUsers(),
            enabled: !!client,
          }),
      },

      stats: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.stats(),
            queryFn: () => client!.getUserStats(),
            enabled: !!client,
          }),
      },

      update: {
        useMutation: () =>
          useMutation({
            mutationFn: ({ id, data }: { id: string; data: Parameters<SemiontApiClient['updateUser']>[1] }) =>
              client!.updateUser(userDID(id), data),
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.all() });
              queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.stats() });
            },
          }),
      },
    },

    oauth: {
      config: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.oauth.config(),
            queryFn: () => client!.getOAuthConfig(),
            enabled: !!client,
          }),
      },
    },
  };
}

/**
 * Authentication and user operations
 */
export function useAuth() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  return {
    me: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.users.me(),
          queryFn: () => client!.getMe(),
          enabled: !!client,
        }),
    },

    acceptTerms: {
      useMutation: () =>
        useMutation({
          mutationFn: () => client!.acceptTerms(),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.users.me() });
          },
        }),
    },

    generateMCPToken: {
      useMutation: () =>
        useMutation({
          mutationFn: () => client!.generateMCPToken(),
        }),
    },

    logout: {
      useMutation: () =>
        useMutation({
          mutationFn: () => client!.logout(),
          onSuccess: () => {
            // Clear all queries on logout
            queryClient.clear();
          },
        }),
    },
  };
}

/**
 * Health check and system status
 */
export function useHealth() {
  const client = useApiClient();

  return {
    check: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.health(),
          queryFn: () => client!.healthCheck(),
          enabled: !!client,
        }),
    },

    status: {
      useQuery: (refetchInterval?: number) =>
        useQuery({
          queryKey: QUERY_KEYS.status(),
          queryFn: () => client!.getStatus(),
          enabled: !!client,
          ...(refetchInterval && { refetchInterval }),
        }),
    },
  };
}
