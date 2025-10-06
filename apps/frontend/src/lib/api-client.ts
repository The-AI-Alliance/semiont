/**
 * Frontend API Client
 *
 * Pure TanStack Query hooks that use types from @semiont/core-types.
 * NO hand-written type definitions - all types imported from core-types.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import type {
  // Annotation types
  Annotation,
  CreateAnnotationRequest,
  CreateAnnotationResponse,
  GetHighlightsResponse,
  GetReferencesResponse,
  DeleteAnnotationResponse,
  GenerateDocumentFromSelectionRequest,
  GenerateDocumentFromSelectionResponse,
  ResolveSelectionRequest,
  ResolveSelectionResponse,

  // Document types
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

  // Admin types
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserRequest,
  OAuthProvider,
  OAuthConfigResponse,

  // Auth types
  AcceptTermsResponse,

  // Tag types
  AddEntityTypeResponse,
  AddReferenceTypeResponse,
} from '@semiont/core-types';

// Re-export types for convenience
export type {
  Document,
  Annotation,
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserRequest,
  OAuthProvider,
  OAuthConfigResponse,
};

// API Error class
export { APIError } from './api-error';

// Query keys for React Query cache management
export { QUERY_KEYS } from './query-keys';
import { QUERY_KEYS } from './query-keys';
import { APIError } from './api-error';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Fetch helper with authentication
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers || {}) as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new APIError(response.status, errorData, errorData.message);
  }

  return response.json();
}

/**
 * Health Check API
 */
const health = {
  useQuery: () => {
    return useQuery({
      queryKey: QUERY_KEYS.health(),
      queryFn: () => fetchAPI<{ status: string }>('/api/health'),
    });
  },
};

/**
 * Auth API
 */
const auth = {
  me: {
    useQuery: () => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.auth.me(),
        queryFn: () => fetchAPI<any>('/api/auth/me', {}, session?.backendToken),
        enabled: !!session?.backendToken && !!session?.user?.isAdmin,
      });
    },
  },
  acceptTerms: {
    useMutation: () => {
      const { data: session } = useSession();
      return useMutation({
        mutationFn: () =>
          fetchAPI<AcceptTermsResponse>('/api/users/accept-terms', {
            method: 'POST',
          }, session?.backendToken),
      });
    },
  },
  logout: {
    useMutation: () => {
      const { data: session } = useSession();
      return useMutation({
        mutationFn: () => fetchAPI<void>('/api/auth/logout', { method: 'POST' }, session?.backendToken),
      });
    },
  },
  google: {
    useMutation: () => {
      return useMutation({
        mutationFn: (data: { access_token: string }) =>
          fetchAPI<{ success: boolean; user: any; token: string; isNewUser: boolean }>('/api/tokens/google', {
            method: 'POST',
            body: JSON.stringify(data),
          }),
      });
    },
  },
};

/**
 * Admin API
 */
const admin = {
  users: {
    all: {
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.users.all(),
          queryFn: () => fetchAPI<AdminUsersResponse>('/api/admin/users', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
    stats: {
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.users.stats(),
          queryFn: () => fetchAPI<AdminUserStatsResponse>('/api/admin/users/stats', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
    update: {
      useMutation: () => {
        const { data: session } = useSession();
        const queryClient = useQueryClient();
        return useMutation({
          mutationFn: ({ id, data }: { id: string; data: UpdateUserRequest }) =>
            fetchAPI<{ success: boolean; user: AdminUser }>(`/api/admin/users/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(data),
            }, session?.backendToken),
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.all() });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.admin.users.stats() });
          },
        });
      },
    },
    delete: {
      useMutation: () => {
        const { data: session } = useSession();
        const queryClient = useQueryClient();
        return useMutation({
          mutationFn: (id: string) =>
            fetchAPI<{ success: boolean; message: string }>(`/api/admin/users/${id}`, {
              method: 'DELETE',
            }, session?.backendToken),
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
      useQuery: () => {
        const { data: session } = useSession();
        return useQuery({
          queryKey: QUERY_KEYS.admin.oauth.config(),
          queryFn: () => fetchAPI<OAuthConfigResponse>('/api/admin/oauth/config', {}, session?.backendToken),
          enabled: !!session?.backendToken && !!session?.user?.isAdmin,
        });
      },
    },
  },
};

/**
 * Entity Types API
 */
const entityTypes = {
  all: {
    useQuery: () => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.entityTypes.all(),
        queryFn: () => fetchAPI<{ entityTypes: string[] }>('/api/entity-types', {}, session?.backendToken),
        enabled: !!session?.backendToken && !!session?.user?.isAdmin,
      });
    },
  },
  create: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (tag: string) =>
          fetchAPI<AddEntityTypeResponse>('/api/entity-types', {
            method: 'POST',
            body: JSON.stringify({ tag }),
          }, session?.backendToken),
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.entityTypes.all() });
        },
      });
    },
  },
};

/**
 * Reference Types API
 */
const referenceTypes = {
  all: {
    useQuery: () => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.referenceTypes.all(),
        queryFn: () => fetchAPI<{ referenceTypes: string[] }>('/api/reference-types', {}, session?.backendToken),
        enabled: !!session?.backendToken && !!session?.user?.isAdmin,
      });
    },
  },
  create: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (tag: string) =>
          fetchAPI<AddReferenceTypeResponse>('/api/reference-types', {
            method: 'POST',
            body: JSON.stringify({ tag }),
          }, session?.backendToken),
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.referenceTypes.all() });
        },
      });
    },
  },
};

/**
 * Documents API
 */
const documents = {
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

/**
 * Annotations API
 */
const annotations = {
  create: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: (data: CreateAnnotationRequest) =>
          fetchAPI<CreateAnnotationResponse>('/api/annotations', {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken),
        onSuccess: (response) => {
          const documentId = response.annotation.documentId;
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(documentId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(documentId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(documentId) });
        },
      });
    },
  },

  saveAsHighlight: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ documentId, exact, position }: {
          documentId: string;
          exact: string;
          position: { start: number; end: number };
        }) => {
          const data: CreateAnnotationRequest = {
            documentId,
            exact,
            selector: {
              type: 'text_span',
              offset: position.start,
              length: position.end - position.start,
            },
            type: 'highlight',
          };

          return fetchAPI<CreateAnnotationResponse>('/api/annotations', {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        onSuccess: (response) => {
          const documentId = response.annotation.documentId;
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(documentId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(documentId) });
        },
      });
    },
  },

  delete: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, documentId }: { id: string; documentId?: string }) =>
          fetchAPI<DeleteAnnotationResponse>(`/api/annotations/${id}`, {
            method: 'DELETE',
          }, session?.backendToken),
        onSuccess: (_, variables) => {
          if (variables.documentId) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.documentId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(variables.documentId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(variables.documentId) });
          }
        },
      });
    },
  },

  generate: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, data }: { id: string; data: GenerateDocumentFromSelectionRequest }) =>
          fetchAPI<GenerateDocumentFromSelectionResponse>(`/api/annotations/${id}/generate-document`, {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken),
        onSuccess: (response) => {
          if (response.document?.id) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.all() });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(response.document.id) });
          }
          if (response.annotation?.documentId) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(response.annotation.documentId) });
          }
        },
      });
    },
  },

  resolve: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, documentId }: { id: string; documentId: string }) =>
          fetchAPI<ResolveSelectionResponse>(`/api/annotations/${id}/resolve`, {
            method: 'PUT',
            body: JSON.stringify({ documentId }),
          }, session?.backendToken),
        onSuccess: (response) => {
          if (response.annotation?.documentId) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(response.annotation.documentId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(response.annotation.documentId) });
          }
          if (response.targetDocument?.id) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.referencedBy(response.targetDocument.id) });
          }
        },
      });
    },
  },
};

/**
 * Main API object
 */
export const api = {
  health,
  auth,
  admin,
  entityTypes,
  referenceTypes,
  documents,
  annotations,
};
