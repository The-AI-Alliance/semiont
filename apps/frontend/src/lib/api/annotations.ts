import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import { getTargetSource } from '@semiont/api-client';
import type { paths } from '@semiont/api-client';
import { NEXT_PUBLIC_API_URL } from '../env';

type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

type CreateAnnotationRequest = RequestContent<paths['/api/annotations']['post']>;
type CreateAnnotationResponse = paths['/api/annotations']['post']['responses'][201]['content']['application/json'];
type DeleteAnnotationRequest = { resourceId: string };
type DeleteAnnotationResponse = { success: boolean };
type GenerateResourceFromAnnotationRequest = RequestContent<paths['/api/annotations/{id}/generate-resource']['post']>;
type GenerateResourceFromAnnotationResponse = paths['/api/annotations/{id}/generate-resource']['post']['responses'][201]['content']['application/json'];
type UpdateAnnotationBodyRequest = RequestContent<paths['/api/annotations/{id}/body']['put']>;
type UpdateAnnotationBodyResponse = paths['/api/annotations/{id}/body']['put']['responses'][200]['content']['application/json'];

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
          const resourceId = getTargetSource(response.annotation.target);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(resourceId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceId) });
        },
      });
    },
  },

  saveAsHighlight: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ resourceId, exact, position }: {
          resourceId: string;
          exact: string;
          position: { start: number; end: number };
        }) => {
          const data: CreateAnnotationRequest = {
            target: {
              source: `${NEXT_PUBLIC_API_URL}/resources/${resourceId}`, // Full URI using BACKEND_URL
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: position.start,
                  end: position.end,
                },
                {
                  type: 'TextQuoteSelector',
                  exact,
                },
              ],
            },
            // Empty body array for highlights
            body: [],
            motivation: 'highlighting',
          };

          return fetchAPI<CreateAnnotationResponse>('/api/annotations', {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        onSuccess: (response) => {
          const resourceId = getTargetSource(response.annotation.target);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(resourceId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceId) });
        },
      });
    },
  },

  delete: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, resourceId }: { id: string } & DeleteAnnotationRequest) => {
          const body: DeleteAnnotationRequest = { resourceId };
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<DeleteAnnotationResponse>(`/api/annotations/${encodedId}`, {
            method: 'DELETE',
            body: JSON.stringify(body),
          }, session?.backendToken);
        },
        onSuccess: (_, variables) => {
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.resourceId) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(variables.resourceId) });
        },
      });
    },
  },

  generate: {
    useMutation: () => {
      const { data: session } = useSession();

      return useMutation({
        mutationFn: ({ id, data }: { id: string; data: GenerateResourceFromAnnotationRequest }) => {
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<GenerateResourceFromAnnotationResponse>(`/api/annotations/${encodedId}/generate-resource`, {
            method: 'POST',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        // Note: This endpoint returns async job response { jobId, status, type, created }
        // Query invalidation handled by job completion polling, not here
      });
    },
  },

  updateBody: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, data }: { id: string; data: UpdateAnnotationBodyRequest }) => {
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<UpdateAnnotationBodyResponse>(`/api/annotations/${encodedId}/body`, {
            method: 'PUT',
            body: JSON.stringify(data),
          }, session?.backendToken);
        },
        onSuccess: (response, variables) => {
          if (response.annotation?.target) {
            const targetSource = getTargetSource(response.annotation.target);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(targetSource) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(targetSource) });
          }
          // Also invalidate the resource specified in the request
          if (variables.data.resourceId) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(variables.data.resourceId) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.referencedBy(variables.data.resourceId) });
          }
        },
      });
    },
  },
};
