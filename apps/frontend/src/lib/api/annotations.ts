/**
 * Annotations API
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type {
  CreateAnnotationRequest,
  CreateAnnotationResponse,
  DeleteAnnotationRequest,
  DeleteAnnotationResponse,
  GenerateDocumentFromAnnotationRequest,
  GenerateDocumentFromAnnotationResponse,
  ResolveAnnotationResponse,
} from './types';

export const annotations = {
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
          const documentId = response.annotation.target.source;
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
            target: {
              source: documentId,
              selector: {
                type: 'TextPositionSelector',
                exact,
                offset: position.start,
                length: position.end - position.start,
              },
            },
            body: {
              type: 'TextualBody',
            },
          };

          return fetchAPI<CreateAnnotationResponse>('/api/annotations', {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        onSuccess: (response) => {
          const documentId = response.annotation.target.source;
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
        mutationFn: ({ id, documentId }: { id: string } & DeleteAnnotationRequest) => {
          const body: DeleteAnnotationRequest = { documentId };
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<DeleteAnnotationResponse>(`/api/annotations/${encodedId}`, {
            method: 'DELETE',
            body: JSON.stringify(body),
          }, session?.backendToken);
        },
        onSuccess: (_, variables) => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.documentId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(variables.documentId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(variables.documentId) });
        },
      });
    },
  },

  generate: {
    useMutation: () => {
      const { data: session } = useSession();

      return useMutation({
        mutationFn: ({ id, data }: { id: string; data: GenerateDocumentFromAnnotationRequest }) => {
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<GenerateDocumentFromAnnotationResponse>(`/api/annotations/${encodedId}/generate-document`, {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        // Note: This endpoint returns async job response { jobId, status, type, created }
        // Query invalidation handled by job completion polling, not here
      });
    },
  },

  resolve: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, documentId }: { id: string; documentId: string }) => {
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<ResolveAnnotationResponse>(`/api/annotations/${encodedId}/resolve`, {
            method: 'PUT',
            body: JSON.stringify({ documentId }),
          }, session?.backendToken);
        },
        onSuccess: (response) => {
          if (response.annotation?.target.source) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(response.annotation.target.source) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.references(response.annotation.target.source) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.highlights(response.annotation.target.source) });
          }
          if (response.targetDocument?.id) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.referencedBy(response.targetDocument.id) });
          }
        },
      });
    },
  },
};
