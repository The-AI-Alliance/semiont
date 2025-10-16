/**
 * Documents API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type {
  Document,
  CreateDocumentRequest,
  CreateDocumentResponse,
  UpdateDocumentRequest,
  GetDocumentResponse,
  ListDocumentsResponse,
  ReferencedBy,
  GetDocumentByTokenResponse,
  CreateDocumentFromTokenRequest,
  CreateDocumentFromTokenResponse,
  CloneDocumentWithTokenResponse,
  GetHighlightsResponse,
  GetReferencesResponse,
} from './types';

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
        queryFn: () => fetchAPI<GetDocumentResponse>(`/api/documents/${id}`, {}, session?.backendToken),
        enabled: !!session?.backendToken && !!id,
      });
    },
  },

  create: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (data: CreateDocumentRequest) =>
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
          fetchAPI<Document>(`/api/documents/${id}`, {
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

  highlights: {
    useQuery: (documentId: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.highlights(documentId),
        queryFn: () => fetchAPI<GetHighlightsResponse>(
          `/api/documents/${documentId}/highlights`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!documentId,
      });
    },
  },

  references: {
    useQuery: (documentId: string) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.documents.references(documentId),
        queryFn: () => fetchAPI<GetReferencesResponse>(
          `/api/documents/${documentId}/references`,
          {},
          session?.backendToken
        ),
        enabled: !!session?.backendToken && !!documentId,
      });
    },
  },
};
