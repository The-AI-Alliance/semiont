'use client';

/**
 * React Query hooks for Semiont API
 *
 * Direct wrappers around SemiontApiClient with no intermediate layers.
 * Each hook returns an object with useQuery and/or useMutation methods.
 *
 * Pattern:
 * - useApiClient() provides authenticated client instance from ApiClientContext
 * - useResources() provides resource operations
 * - useAnnotations() provides annotation operations
 * - useEntityTypes() provides entity type operations
 * - useAdmin() provides admin operations
 */

import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import {
  type ResourceId,
  type AnnotationId,
  type ContentFormat,
  searchQuery,
  cloneToken,
  entityType,
  userDID,
  accessToken,
} from '@semiont/core';
import { SemiontApiClient, decodeWithCharset } from '@semiont/api-client';
import { QUERY_KEYS } from './query-keys';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';

/**
 * Convert raw token (string | null) to AccessToken | undefined
 */
function toAccessToken(token: string | null) {
  return token ? accessToken(token) : undefined;
}

/**
 * Resource operations
 */
export function useResources() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    list: {
      useQuery: (options?: { limit?: number; archived?: boolean; query?: string }) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.all(options?.limit, options?.archived),
          queryFn: () => client!.listResources(options?.limit, options?.archived, options?.query ? searchQuery(options.query) : undefined, { auth: toAccessToken(token) }),
          enabled: !!client,
        }),
    },

    get: {
      useQuery: (id: ResourceId, options?: Omit<UseQueryOptions, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.detail(id),
          queryFn: () => client!.getResource(id, { auth: toAccessToken(token) }),
          enabled: !!client && !!id,
          ...options,
        }),
    },

    events: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.events(id),
          queryFn: () => client!.getResourceEvents(id, { auth: toAccessToken(token) }),
          enabled: !!client && !!id,
        }),
    },

    annotations: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.annotations(id),
          queryFn: () => client!.getResourceAnnotations(id, { auth: toAccessToken(token) }),
          enabled: !!client && !!id,
        }),
    },

    referencedBy: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.referencedBy(id),
          queryFn: () => client!.getResourceReferencedBy(id, { auth: toAccessToken(token) }),
          enabled: !!client && !!id,
        }),
    },

    representation: {
      useQuery: (id: ResourceId, mediaType: string) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.representation(id),
          queryFn: async () => {
            const { data } = await client!.getResourceRepresentation(id, {
              accept: mediaType as ContentFormat,
              auth: toAccessToken(token),
            });
            return decodeWithCharset(data, mediaType);
          },
          enabled: !!client && !!id && !!mediaType,
        }),
    },

    search: {
      useQuery: (query: string, limit: number) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.search(query, limit),
          queryFn: () => client!.listResources(limit, undefined, searchQuery(query), { auth: toAccessToken(token) }),
          enabled: !!client && !!query,
        }),
    },

    create: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['createResource']>[0]) => {
            if (!client) {
              throw new Error('Not authenticated - please sign in to create resources');
            }
            return client.createResource(data, { auth: toAccessToken(token) });
          },
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        });
      },
    },

    update: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({ id, data }: { id: ResourceId; data: Parameters<SemiontApiClient['updateResource']>[1] }) => {
            if (!client) throw new Error('Not authenticated');
            return client.updateResource(id, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.detail(variables.id) });
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        });
      },
    },

    generateCloneToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (id: ResourceId) => {
            if (!client) throw new Error('Not authenticated');
            return client.generateCloneToken(id, { auth: toAccessToken(token) });
          },
        });
      },
    },

    getByToken: {
      useQuery: (cloneTokenStr: string) => {
        const authToken = useAuthToken();
        return useQuery({
          queryKey: ['resources', 'token', cloneTokenStr],
          queryFn: () => client!.getResourceByToken(cloneToken(cloneTokenStr), { auth: toAccessToken(authToken) }),
          enabled: !!client && !!cloneTokenStr,
        });
      },
    },

    createFromToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['createResourceFromToken']>[0]) => {
            if (!client) throw new Error('Not authenticated');
            return client.createResourceFromToken(data, { auth: toAccessToken(token) });
          },
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        });
      },
    },
  };
}

/**
 * Annotation operations
 */
export function useAnnotations() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    get: {
      useQuery: (id: AnnotationId) =>
        useQuery({
          queryKey: ['annotations', id],
          queryFn: () => client!.getAnnotation(id, { auth: toAccessToken(token) }),
          enabled: !!client && !!id,
        }),
    },

    getResourceAnnotation: {
      useQuery: (resourceId: ResourceId, annotationId: AnnotationId) =>
        useQuery({
          queryKey: ['annotations', resourceId, annotationId],
          queryFn: () => client!.getResourceAnnotation(resourceId, annotationId, { auth: toAccessToken(token) }),
          enabled: !!client && !!resourceId && !!annotationId,
        }),
    },

    history: {
      useQuery: (resourceId: ResourceId, annotationId: AnnotationId) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.history(resourceId, annotationId),
          queryFn: () => client!.getAnnotationHistory(resourceId, annotationId, { auth: toAccessToken(token) }),
          enabled: !!client && !!resourceId && !!annotationId,
        }),
    },

    create: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({
            resourceId,
            data,
          }: {
            resourceId: ResourceId;
            data: Parameters<SemiontApiClient['createAnnotation']>[1];
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.createAnnotation(resourceId, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.annotations(variables.resourceId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(variables.resourceId) });
          },
        });
      },
    },

    delete: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (variables: {
            resourceId: ResourceId;
            annotationId: AnnotationId;
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.deleteAnnotation(variables.resourceId, variables.annotationId, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            const queryKey = QUERY_KEYS.resources.annotations(variables.resourceId);
            const currentData = queryClient.getQueryData<{ resource: any; annotations: any[] }>(queryKey);

            if (currentData) {
              queryClient.setQueryData(queryKey, {
                ...currentData,
                annotations: currentData.annotations.filter(ann => ann.id !== variables.annotationId)
              });
            } else {
              queryClient.invalidateQueries({ queryKey });
            }

            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(variables.resourceId) });
            queryClient.invalidateQueries({ queryKey: ['annotations', variables.annotationId] });
          },
        });
      },
    },

    updateBody: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({
            resourceId,
            annotationId,
            data,
          }: {
            resourceId: ResourceId;
            annotationId: AnnotationId;
            data: Parameters<SemiontApiClient['updateAnnotationBody']>[2];
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.updateAnnotationBody(resourceId, annotationId, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            queryClient.invalidateQueries({ queryKey: ['annotations', variables.annotationId] });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.annotations(variables.resourceId) });

            if (variables.data.operations) {
              for (const op of variables.data.operations) {
                if (op.op === 'add' && op.item && typeof op.item === 'object') {
                  if ('type' in op.item && op.item.type === 'SpecificResource' && 'source' in op.item && op.item.source) {
                    const targetResourceId = op.item.source as ResourceId;
                    queryClient.invalidateQueries({
                      queryKey: QUERY_KEYS.resources.referencedBy(targetResourceId)
                    });
                  }
                }
              }
            }

            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(variables.resourceId) });
          },
        });
      },
    },

    llmContext: {
      useQuery: (resourceId: ResourceId, annotationId: AnnotationId, options?: { contextWindow?: number }) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.llmContext(resourceId, annotationId),
          queryFn: () => client!.getAnnotationLLMContext(resourceId, annotationId, { ...options, auth: toAccessToken(token) }),
          enabled: !!client && !!resourceId && !!annotationId,
          staleTime: 5 * 60 * 1000, // 5 minutes - context doesn't change often
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
  const token = useAuthToken();

  type EntityTypesResponse = Awaited<ReturnType<SemiontApiClient['listEntityTypes']>>;

  return {
    list: {
      useQuery: (options?: Omit<UseQueryOptions<EntityTypesResponse>, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.entityTypes.all(),
          queryFn: () => client!.listEntityTypes({ auth: toAccessToken(token) }),
          enabled: !!client,
          ...options,
        }),
    },

    add: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (type: string) => {
            if (!client) throw new Error('Not authenticated');
            return client.addEntityType(entityType(type), { auth: toAccessToken(token) });
          },
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.entityTypes.all() });
          },
        });
      },
    },

    addBulk: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (types: string[]) => {
            if (!client) throw new Error('Not authenticated');
            return client.addEntityTypesBulk(types.map(entityType), { auth: toAccessToken(token) });
          },
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.entityTypes.all() });
          },
        });
      },
    },
  };
}

/**
 * Admin operations
 */
export function useAdmin() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    users: {
      list: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.all(),
            queryFn: () => client!.listUsers({ auth: toAccessToken(token) }),
            enabled: !!client,
          }),
      },

      stats: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.stats(),
            queryFn: () => client!.getUserStats({ auth: toAccessToken(token) }),
            enabled: !!client,
          }),
      },

      update: {
        useMutation: () => {
          const token = useAuthToken();
          return useMutation({
            mutationFn: ({ id, data }: { id: string; data: Parameters<SemiontApiClient['updateUser']>[1] }) => {
              if (!client) throw new Error('Not authenticated');
              return client.updateUser(userDID(id), data, { auth: toAccessToken(token) });
            },
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.all() });
              queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.stats() });
            },
          });
        },
      },
    },

    oauth: {
      config: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.oauth.config(),
            queryFn: () => client!.getOAuthConfig({ auth: toAccessToken(token) }),
            enabled: !!client,
          }),
      },
    },

    exchange: {
      backup: {
        useMutation: () =>
          useMutation({
            mutationFn: async () => {
              if (!client) throw new Error('Not authenticated');
              const response = await client.backupKnowledgeBase({ auth: toAccessToken(token) });
              if (!response.ok) {
                throw new Error(`Backup failed: ${response.status} ${response.statusText}`);
              }
              const blob = await response.blob();
              const contentDisposition = response.headers.get('Content-Disposition');
              const filename = contentDisposition?.match(/filename="(.+?)"/)?.[1]
                ?? `semiont-backup-${Date.now()}.tar.gz`;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              a.click();
              URL.revokeObjectURL(url);
              return { filename, size: blob.size };
            },
          }),
      },

      restore: {
        useMutation: () =>
          useMutation({
            mutationFn: async ({
              file,
              onProgress,
            }: {
              file: File;
              onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
            }) => {
              if (!client) throw new Error('Not authenticated');
              return client.restoreKnowledgeBase(file, {
                auth: toAccessToken(token),
                onProgress,
              });
            },
          }),
      },

    },
  };
}

/**
 * Moderation operations (moderator or admin role required)
 */
export function useModeration() {
  const client = useApiClient();
  const token = useAuthToken();

  return {
    exchange: {
      export: {
        useMutation: () =>
          useMutation({
            mutationFn: async (params?: { includeArchived?: boolean }) => {
              if (!client) throw new Error('Not authenticated');
              const response = await client.exportKnowledgeBase(params, { auth: toAccessToken(token) });
              if (!response.ok) {
                throw new Error(`Export failed: ${response.status} ${response.statusText}`);
              }
              const blob = await response.blob();
              const contentDisposition = response.headers.get('Content-Disposition');
              const filename = contentDisposition?.match(/filename="(.+?)"/)?.[1]
                ?? `semiont-export-${Date.now()}.tar.gz`;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              a.click();
              URL.revokeObjectURL(url);
              return { filename, size: blob.size };
            },
          }),
      },

      import: {
        useMutation: () =>
          useMutation({
            mutationFn: async ({
              file,
              onProgress,
            }: {
              file: File;
              onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
            }) => {
              if (!client) throw new Error('Not authenticated');
              return client.importKnowledgeBase(file, {
                auth: toAccessToken(token),
                onProgress,
              });
            },
          }),
      },
    },
  };
}

/**
 * Authentication and user operations via API
 */
export function useAuthApi() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    me: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.users.me(),
          queryFn: () => client!.getMe({ auth: toAccessToken(token) }),
          enabled: !!client,
        }),
    },

    acceptTerms: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: () => {
            if (!client) throw new Error('Not authenticated');
            return client.acceptTerms({ auth: toAccessToken(token) });
          },
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.users.me() });
          },
        });
      },
    },

    generateMCPToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: () => {
            if (!client) throw new Error('Not authenticated');
            return client.generateMCPToken({ auth: toAccessToken(token) });
          },
        });
      },
    },

    logout: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: () => {
            if (!client) throw new Error('Not authenticated');
            return client.logout({ auth: toAccessToken(token) });
          },
          onSuccess: () => {
            // Clear all queries on logout
            queryClient.clear();
          },
        });
      },
    },
  };
}

/**
 * Health check and system status
 */
export function useHealth() {
  const client = useApiClient();
  const token = useAuthToken();

  return {
    check: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.health(),
          queryFn: () => client!.healthCheck(), // Public endpoint - no auth required
          enabled: !!client,
        }),
    },

    status: {
      useQuery: (refetchInterval?: number) =>
        useQuery({
          queryKey: QUERY_KEYS.status(),
          queryFn: () => client!.getStatus({ auth: toAccessToken(token) }), // Requires authentication
          enabled: !!client,
          ...(refetchInterval && { refetchInterval }),
        }),
    },
  };
}
