import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { paths } from '@semiont/api-client';

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : T extends { responses: { 201: { content: { 'application/json': infer R } } } } ? R : never;
type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

type Document = ResponseContent<paths['/api/documents']['get']>['documents'][number];
type CreateResourceRequest = RequestContent<paths['/api/documents']['post']>;
type CreateDocumentResponse = paths['/api/documents']['post']['responses'][201]['content']['application/json'];
type UpdateDocumentRequest = RequestContent<paths['/documents/{id}']['patch']>;
type GetDocumentResponse = paths['/documents/{id}']['get']['responses'][200]['content']['application/ld+json'];
type ListDocumentsResponse = ResponseContent<paths['/api/documents']['get']>;
type ReferencedBy = paths['/api/documents/{id}/referenced-by']['get']['responses'][200]['content']['application/json']['referencedBy'][number];
type GetDocumentByTokenResponse = paths['/api/documents/token/{token}']['get']['responses'][200]['content']['application/json'];
type CreateDocumentFromTokenRequest = RequestContent<paths['/api/documents/create-from-token']['post']>;
type CreateDocumentFromTokenResponse = paths['/api/documents/create-from-token']['post']['responses'][201]['content']['application/json'];
type CloneDocumentWithTokenResponse = paths['/api/documents/{id}/clone-with-token']['post']['responses'][200]['content']['application/json'];
type GetAnnotationsResponse = paths['/api/documents/{id}/annotations']['get']['responses'][200]['content']['application/json'];

export const documents = {
  list: {
    useQuery: (limit?: number, archived?: boolean) => {
      const { data: session } = useSession();
      const params = new URLSearchParams();
      if (limit !== undefined) params.append('limit', limit.toString());
      if (archived !== undefined) params.append('archived', archived.toString());
      const queryString = params.toString() ? `?${params.toString()}` : '';

      return useQuery({
        queryKey: QUERY_KEYS.documents.all(limit, archived),
        queryFn: () => fetchAPI<ListDocumentsResponse>(`/api/documents${queryString}`, {}, session?.backendToken),
        enabled: !!session?.backendToken && !!session?.user?.isAdmin,
      });
    },
  },

  get: {
    useQuery: (id: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.detail(id),
        queryFn: () => fetchAPI<GetDocumentResponse>(`/documents/${encodeURIComponent(id)}`, {}, session?.backendToken),
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
          fetchAPI<CreateDocumentResponse>('/api/documents', {
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
        mutationFn: ({ id, data }: { id: string; data: UpdateDocumentRequest }) =>
          fetchAPI<Document>(`/documents/${id}`, {
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
        queryFn: () => fetchAPI<{ documents: Document[] }>(
          `/api/documents/search?q=${encodeURIComponent(query)}&limit=${limit}`,
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
          `/api/documents/${id}/referenced-by`,
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
          fetchAPI<CloneDocumentWithTokenResponse>(`/api/documents/${id}/clone-with-token`, {
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
        queryFn: () => fetchAPI<GetDocumentByTokenResponse>(
          `/api/documents/token/${token}`,
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
        mutationFn: (data: CreateDocumentFromTokenRequest) =>
          fetchAPI<CreateDocumentFromTokenResponse>(`/api/documents/create-from-token`, {
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
          `/api/documents/${id}/events`,
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
          `/api/documents/${documentId}/annotations`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!documentId,
      });
    },
  },
};
