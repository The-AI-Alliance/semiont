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
  SemiontApiClient,
  type ResourceUri,
  type AnnotationUri,
  type ResourceAnnotationUri,
  searchQuery,
  cloneToken,
  entityType,
  userDID,
  accessToken
} from '@semiont/api-client';
import { extractResourceUriFromAnnotationUri, uriToAnnotationId } from '@semiont/core';
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
          queryKey: QUERY_KEYS.documents.all(options?.limit, options?.archived),
          queryFn: () => client!.listResources(options?.limit, options?.archived, options?.query ? searchQuery(options.query) : undefined, { auth: toAccessToken(token) }),
          enabled: !!client,
        }),
    },

    get: {
      useQuery: (rUri: ResourceUri, options?: Omit<UseQueryOptions, 'queryKey' | 'queryFn'>) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.detail(rUri),
          queryFn: () => client!.getResource(rUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!rUri,
          ...options,
        }),
    },

    events: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.events(rUri),
          queryFn: () => client!.getResourceEvents(rUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!rUri,
        }),
    },

    annotations: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.annotations(rUri),
          queryFn: () => client!.getResourceAnnotations(rUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!rUri,
        }),
    },

    referencedBy: {
      useQuery: (rUri: ResourceUri) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.referencedBy(rUri),
          queryFn: () => client!.getResourceReferencedBy(rUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!rUri,
        }),
    },

    search: {
      useQuery: (query: string, limit: number) =>
        useQuery({
          queryKey: QUERY_KEYS.documents.search(query, limit),
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
          mutationFn: ({ rUri, data }: { rUri: ResourceUri; data: Parameters<SemiontApiClient['updateResource']>[1] }) => {
            if (!client) throw new Error('Not authenticated');
            return client.updateResource(rUri, data, { auth: toAccessToken(token) });
          },
          onSuccess: (_data, variables) => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.rUri) });
            queryClient.invalidateQueries({ queryKey: ['documents'] });
          },
        });
      },
    },

    generateCloneToken: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (rUri: ResourceUri) => {
            if (!client) throw new Error('Not authenticated');
            return client.generateCloneToken(rUri, { auth: toAccessToken(token) });
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
      useQuery: (annotationUri: AnnotationUri) =>
        useQuery({
          queryKey: ['annotations', annotationUri],
          queryFn: () => client!.getAnnotation(annotationUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!annotationUri,
        }),
    },

    getResourceAnnotation: {
      useQuery: (annotationUri: ResourceAnnotationUri) =>
        useQuery({
          queryKey: ['annotations', annotationUri],
          queryFn: () => client!.getResourceAnnotation(annotationUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!annotationUri,
        }),
    },

    history: {
      useQuery: (annotationUri: ResourceAnnotationUri) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.history(annotationUri),
          queryFn: () => client!.getAnnotationHistory(annotationUri, { auth: toAccessToken(token) }),
          enabled: !!client && !!annotationUri,
        }),
    },

    create: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({
            rUri,
            data,
          }: {
            rUri: ResourceUri;
            data: Parameters<SemiontApiClient['createAnnotation']>[1];
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.createAnnotation(rUri, data, { auth: toAccessToken(token) });
          },
          onSuccess: (response, variables) => {
            const queryKey = QUERY_KEYS.documents.annotations(variables.rUri);
            const currentData = queryClient.getQueryData<{ resource: any; annotations: any[] }>(queryKey);

            if (currentData && response.annotation) {
              queryClient.setQueryData(queryKey, {
                ...currentData,
                annotations: [...currentData.annotations, response.annotation]
              });
            } else {
              queryClient.invalidateQueries({ queryKey });
            }

            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(variables.rUri) });
          },
        });
      },
    },

    delete: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: (variables: {
            annotationUri: ResourceAnnotationUri;
            resourceUri: ResourceUri;
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.deleteAnnotation(variables.annotationUri, { auth: toAccessToken(token) });
          },
          onSuccess: (_, variables) => {
            const queryKey = QUERY_KEYS.documents.annotations(variables.resourceUri);
            const currentData = queryClient.getQueryData<{ resource: any; annotations: any[] }>(queryKey);

            if (currentData) {
              const annotationId = uriToAnnotationId(variables.annotationUri);

              queryClient.setQueryData(queryKey, {
                ...currentData,
                annotations: currentData.annotations.filter(ann => ann.id !== annotationId)
              });
            } else {
              queryClient.invalidateQueries({ queryKey });
            }

            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(variables.resourceUri) });
            queryClient.invalidateQueries({ queryKey: ['annotations', variables.annotationUri] });
          },
        });
      },
    },

    updateBody: {
      useMutation: () => {
        const token = useAuthToken();
        return useMutation({
          mutationFn: ({
            annotationUri,
            data,
          }: {
            annotationUri: ResourceAnnotationUri;
            data: Parameters<SemiontApiClient['updateAnnotationBody']>[1];
          }) => {
            if (!client) throw new Error('Not authenticated');
            return client.updateAnnotationBody(annotationUri, data, { auth: toAccessToken(token) });
          },
          onSuccess: (response, variables) => {
            const singleQueryKey = ['annotations', variables.annotationUri];
            if (response.annotation) {
              queryClient.setQueryData(singleQueryKey, response.annotation);
            } else {
              queryClient.invalidateQueries({ queryKey: singleQueryKey });
            }

            const resourceUri = extractResourceUriFromAnnotationUri(variables.annotationUri);
            const listQueryKey = QUERY_KEYS.documents.annotations(resourceUri);
            const currentList = queryClient.getQueryData<{ resource: any; annotations: any[] }>(listQueryKey);

            if (currentList && response.annotation) {
              queryClient.setQueryData(listQueryKey, {
                ...currentList,
                annotations: currentList.annotations.map(ann =>
                  ann.id === response.annotation.id ? response.annotation : ann
                )
              });
            } else {
              queryClient.invalidateQueries({ queryKey: listQueryKey });
            }

            if (variables.data.operations) {
              for (const op of variables.data.operations) {
                if (op.op === 'add' && op.item && typeof op.item === 'object') {
                  if ('type' in op.item && op.item.type === 'SpecificResource' && 'source' in op.item && op.item.source) {
                    const targetResourceUri = op.item.source as ResourceUri;
                    queryClient.invalidateQueries({
                      queryKey: QUERY_KEYS.documents.referencedBy(targetResourceUri)
                    });
                  }
                }
              }
            }

            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.events(resourceUri) });
          },
        });
      },
    },

    llmContext: {
      useQuery: (resourceUri: ResourceUri, annotationId: string, options?: { contextWindow?: number }) =>
        useQuery({
          queryKey: QUERY_KEYS.annotations.llmContext(resourceUri, annotationId),
          queryFn: () => client!.getAnnotationLLMContext(resourceUri, annotationId, { ...options, auth: toAccessToken(token) }),
          enabled: !!client && !!resourceUri && !!annotationId,
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
