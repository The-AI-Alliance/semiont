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
  resourceId as resourceIdBrand,
  annotationId as annotationIdBrand,
} from '@semiont/core';
import { SemiontApiClient, decodeWithCharset } from '@semiont/api-client';
import { QUERY_KEYS } from './query-keys';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import { useEventBus } from '../contexts/EventBusContext';

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
  const semiont = useApiClient();
  const token = useAuthToken();
  // eventBus used for yield:updated emission in update mutation
  const eventBus = useEventBus();

  return {
    list: {
      useQuery: (options?: { limit?: number; archived?: boolean; query?: string }) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.all(options?.limit, options?.archived),
          queryFn: () => semiont!.browseResources(options?.limit, options?.archived, options?.query ? searchQuery(options.query) : undefined, { auth: toAccessToken(token) }),
          enabled: !!semiont,
        }),
    },

    get: {
      useQuery: (id: ResourceId, options?: Omit<UseQueryOptions, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.detail(id),
          queryFn: () => semiont!.browseResource(id, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
          ...options,
        }),
    },

    events: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.events(id),
          queryFn: () => semiont!.getResourceEvents(id, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
        }),
    },

    annotations: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.annotations(id),
          queryFn: () => semiont!.browseAnnotations(id, undefined, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
        }),
    },

    referencedBy: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.referencedBy(id),
          queryFn: () => semiont!.browseReferences(id, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
        }),
    },

    representation: {
      useQuery: (id: ResourceId, mediaType: string) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.representation(id),
          queryFn: async () => {
            const { data } = await semiont!.getResourceRepresentation(id, {
              accept: mediaType as ContentFormat,
              auth: toAccessToken(token),
            });
            return decodeWithCharset(data, mediaType);
          },
          enabled: !!semiont && !!id && !!mediaType,
        }),
    },

    mediaToken: {
      useQuery: (id: ResourceId) =>
        useQuery({
          queryKey: QUERY_KEYS.resources.mediaToken(id),
          queryFn: () => semiont!.getMediaToken(id, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
          staleTime: 4 * 60 * 1000,
        }),
    },

    create: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['yieldResource']>[0]) => {
            if (!semiont) {
              throw new Error('Not authenticated - please sign in to create resources');
            }
            return semiont.yieldResource(data, { auth: toAccessToken(token) });
          },
          onSuccess: (result) => {
            // Fetch new resource into store and invalidate lists
            semiont.browse.invalidateResourceDetail(resourceIdBrand(result.resourceId));
            semiont.browse.invalidateResourceLists();
          },
        });
      },
    },

    update: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({ id, data }: { id: ResourceId; data: Parameters<SemiontApiClient['updateResource']>[1] }) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.updateResource(id, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_data, variables) => {
            eventBus.get('yield:update-ok').next({ resourceId: variables.id });
          },
        });
      },
    },

    generateCloneToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (id: ResourceId) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.generateCloneToken(id, { auth: toAccessToken(token) });
          },
        });
      },
    },

    getByToken: {
      useQuery: (cloneTokenStr: string) => {
        const authToken = useAuthToken();
        return useQuery({
          queryKey: ['resources', 'token', cloneTokenStr],
          queryFn: () => semiont!.getResourceByToken(cloneToken(cloneTokenStr), { auth: toAccessToken(authToken) }),
          enabled: !!semiont && !!cloneTokenStr,
        });
      },
    },

    createFromToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (data: Parameters<SemiontApiClient['createResourceFromToken']>[0]) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.createResourceFromToken(data, { auth: toAccessToken(token) });
          },
          onSuccess: (result) => {
            semiont.browse.invalidateResourceDetail(resourceIdBrand(result.resourceId));
            semiont.browse.invalidateResourceLists();
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
  const semiont = useApiClient();
  const queryClient = useQueryClient(); // retained for events log invalidation (no store yet)
  const token = useAuthToken();

  return {
    get: {
      useQuery: (id: AnnotationId) =>
        useQuery({
          queryKey: ['annotations', id],
          queryFn: () => semiont!.getAnnotation(id, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!id,
        }),
    },

    browseAnnotation: {
      useQuery: (resourceId: ResourceId, annotationId: AnnotationId) =>
        useQuery({
          queryKey: ['annotations', resourceId, annotationId],
          queryFn: () => semiont!.browseAnnotation(resourceId, annotationId, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!resourceId && !!annotationId,
        }),
    },

    history: {
      useQuery: (resourceId: ResourceId, annotationId: AnnotationId) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.history(resourceId, annotationId),
          queryFn: () => semiont!.getAnnotationHistory(resourceId, annotationId, { auth: toAccessToken(token) }),
          enabled: !!semiont && !!resourceId && !!annotationId,
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
            data: Parameters<SemiontApiClient['markAnnotation']>[1];
          }) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.markAnnotation(resourceId, data, { auth: toAccessToken(token) });
          },
          onSuccess: (result, variables) => {
            /// BrowseNamespace reacts to mark:added SSE event automatically.
            // Explicitly invalidate the annotation detail and events log.
            semiont.browse.invalidateAnnotationDetail(annotationIdBrand(result.annotationId));
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
            if (!semiont) throw new Error('Not authenticated');
            return semiont.deleteAnnotation(variables.resourceId, variables.annotationId, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            // BrowseNamespace reacts to mark:removed SSE event automatically.
            // Explicitly remove from detail cache and invalidate events log.
            semiont.browse.invalidateAnnotationDetail(variables.annotationId);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(variables.resourceId) });
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
            data: Parameters<SemiontApiClient['bindAnnotation']>[2];
          }) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.bindAnnotation(resourceId, annotationId, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            // BrowseNamespace reacts to mark:body-updated SSE event automatically.
            // Invalidate annotation detail and events log; invalidate referencedBy for linked targets.
            semiont.browse.invalidateAnnotationDetail(variables.annotationId);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resources.events(variables.resourceId) });

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
          },
        });
      },
    },
  };
}

/**
 * Entity type operations
 */
export function useEntityTypes() {
  const semiont = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  type EntityTypesResponse = Awaited<ReturnType<SemiontApiClient['listEntityTypes']>>;

  return {
    list: {
      useQuery: (options?: Omit<UseQueryOptions<EntityTypesResponse>, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.entityTypes.all(),
          queryFn: () => semiont!.listEntityTypes({ auth: toAccessToken(token) }),
          enabled: !!semiont,
          ...options,
        }),
    },

    add: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (type: string) => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.addEntityType(entityType(type), { auth: toAccessToken(token) });
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
            if (!semiont) throw new Error('Not authenticated');
            return semiont.addEntityTypesBulk(types.map(entityType), { auth: toAccessToken(token) });
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
  const semiont = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    users: {
      list: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.all(),
            queryFn: () => semiont!.listUsers({ auth: toAccessToken(token) }),
            enabled: !!semiont,
          }),
      },

      stats: {
        useQuery: () =>
          useQuery({
            queryKey: QUERY_KEYS.admin.users.stats(),
            queryFn: () => semiont!.getUserStats({ auth: toAccessToken(token) }),
            enabled: !!semiont,
          }),
      },

      update: {
        useMutation: () => {
          const token = useAuthToken();
          return useMutation({
            mutationFn: ({ id, data }: { id: string; data: Parameters<SemiontApiClient['updateUser']>[1] }) => {
              if (!semiont) throw new Error('Not authenticated');
              return semiont.updateUser(userDID(id), data, { auth: toAccessToken(token) });
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
            queryFn: () => semiont!.getOAuthConfig({ auth: toAccessToken(token) }),
            enabled: !!semiont,
          }),
      },
    },

    exchange: {
      backup: {
        useMutation: () =>
          useMutation({
            mutationFn: async () => {
              if (!semiont) throw new Error('Not authenticated');
              const response = await semiont.backupKnowledgeBase({ auth: toAccessToken(token) });
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
              if (!semiont) throw new Error('Not authenticated');
              return semiont.restoreKnowledgeBase(file, {
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
  const semiont = useApiClient();
  const token = useAuthToken();

  return {
    exchange: {
      export: {
        useMutation: () =>
          useMutation({
            mutationFn: async (params?: { includeArchived?: boolean }) => {
              if (!semiont) throw new Error('Not authenticated');
              const response = await semiont.exportKnowledgeBase(params, { auth: toAccessToken(token) });
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
              if (!semiont) throw new Error('Not authenticated');
              return semiont.importKnowledgeBase(file, {
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
  const semiont = useApiClient();
  const queryClient = useQueryClient();
  const token = useAuthToken();

  return {
    me: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.users.me(),
          queryFn: () => semiont!.getMe({ auth: toAccessToken(token) }),
          enabled: !!semiont,
        }),
    },

    acceptTerms: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: () => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.acceptTerms({ auth: toAccessToken(token) });
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
            if (!semiont) throw new Error('Not authenticated');
            return semiont.generateMCPToken({ auth: toAccessToken(token) });
          },
        });
      },
    },

    logout: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: () => {
            if (!semiont) throw new Error('Not authenticated');
            return semiont.logout({ auth: toAccessToken(token) });
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
  const semiont = useApiClient();
  const token = useAuthToken();

  return {
    check: {
      useQuery: () =>
        useQuery({
          queryKey: QUERY_KEYS.health(),
          queryFn: () => semiont!.healthCheck(), // Public endpoint - no auth required
          enabled: !!semiont,
        }),
    },

    status: {
      useQuery: (refetchInterval?: number) =>
        useQuery({
          queryKey: QUERY_KEYS.status(),
          queryFn: () => semiont!.getStatus({ auth: toAccessToken(token) }), // Requires authentication
          enabled: !!semiont,
          ...(refetchInterval && { refetchInterval }),
        }),
    },
  };
}
