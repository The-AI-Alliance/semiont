import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { paths } from '@semiont/api-client';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : T extends { responses: { 201: { content: { 'application/json': infer R } } } } ? R : never;
type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

type Document = ResponseContent<paths['/resources']['get']>['resources'][number];
type CreateResourceRequest = RequestContent<paths['/resources']['post']>;
type CreateResourceResponse = paths['/resources']['post']['responses'][201]['content']['application/json'];
type UpdateResourceRequest = RequestContent<paths['/resources/{id}']['patch']>;
type GetResourceResponse = paths['/resources/{id}']['get']['responses'][200]['content']['application/ld+json'];
type ListResourcesResponse = ResponseContent<paths['/resources']['get']>;
type ReferencedBy = paths['/resources/{id}/referenced-by']['get']['responses'][200]['content']['application/json']['referencedBy'][number];
type GetResourceByTokenResponse = paths['/api/resources/token/{token}']['get']['responses'][200]['content']['application/json'];
type CreateResourceFromTokenRequest = RequestContent<paths['/api/resources/create-from-token']['post']>;
type CreateResourceFromTokenResponse = paths['/api/resources/create-from-token']['post']['responses'][201]['content']['application/json'];
type CloneResourceWithTokenResponse = paths['/resources/{id}/clone-with-token']['post']['responses'][200]['content']['application/json'];
type GetAnnotationsResponse = paths['/resources/{id}/annotations']['get']['responses'][200]['content']['application/json'];

export const resources = {
  list: {
    useQuery: (limit?: number, archived?: boolean) => {
      const { data: session } = useSession();
      const params = new URLSearchParams();
      if (limit !== undefined) params.append('limit', limit.toString());
      if (archived !== undefined) params.append('archived', archived.toString());
      const queryString = params.toString() ? `?${params.toString()}` : '';

      return useQuery({
        queryKey: QUERY_KEYS.documents.all(limit, archived),
        queryFn: () => fetchAPI<ListResourcesResponse>(`/resources${queryString}`, {}, session?.backendToken),
        enabled: !!session?.backendToken && !!session?.user?.isAdmin,
      });
    },
  },

  get: {
    useQuery: (id: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.detail(id),
        queryFn: () => fetchAPI<GetResourceResponse>(`/resources/${encodeURIComponent(id)}`, {}, session?.backendToken),
        enabled: !!session?.backendToken && !!id,
      });
    },
  },

  create: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (data: CreateResourceRequest) =>
          fetchAPI<CreateResourceResponse>('/resources', {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken),
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.all() });
        },
      });
    },
  },

  update: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, data }: { id: string; data: UpdateResourceRequest }) =>
          fetchAPI<Document>(`/resources/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(data),
          }, session?.backendToken),
        onSuccess: (_, variables) => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.id) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.all() });
        },
      });
    },
  },

  search: {
    useQuery: (query: string, limit: number = 10) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.search(query, limit),
        queryFn: () => fetchAPI<ListResourcesResponse>(
          `/resources?q=${encodeURIComponent(query)}&limit=${limit}`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && query.length > 0,
      });
    },
  },

  referencedBy: {
    useQuery: (id: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.referencedBy(id),
        queryFn: () => fetchAPI<{ referencedBy: ReferencedBy[] }>(
          `/resources/${id}/referenced-by`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!id,
      });
    },
  },

  generateCloneToken: {
    useMutation: () => {
      const { data: session } = useSession();

      return useMutation({
        mutationFn: (id: string) =>
          fetchAPI<CloneResourceWithTokenResponse>(`/resources/${id}/clone-with-token`, {
            method: 'POST',
          }, session?.backendToken),
      });
    },
  },

  getByToken: {
    useQuery: (token: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.byToken(token),
        queryFn: () => fetchAPI<GetResourceByTokenResponse>(
          `/api/resources/token/${token}`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!token,
      });
    },
  },

  createFromToken: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (data: CreateResourceFromTokenRequest) =>
          fetchAPI<CreateResourceFromTokenResponse>(`/api/resources/create-from-token`, {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken),
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.all() });
        },
      });
    },
  },

  events: {
    useQuery: (id: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.events(id),
        queryFn: () => fetchAPI<{ events: any[] }>(
          `/resources/${id}/events`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!id,
      });
    },
  },

  annotations: {
    useQuery: (documentId: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.annotations(documentId),
        queryFn: () => fetchAPI<GetAnnotationsResponse>(
          `/resources/${documentId}/annotations`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!documentId,
      });
    },
  },
};
