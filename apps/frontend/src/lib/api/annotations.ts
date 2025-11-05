import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import { getTargetSource, resourceUri } from '@semiont/api-client';
import type { paths, ResourceUri } from '@semiont/api-client';

type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

type CreateAnnotationRequest = RequestContent<paths['/resources/{id}/annotations']['post']>;
type CreateAnnotationResponse = paths['/resources/{id}/annotations']['post']['responses'][201]['content']['application/json'];
type DeleteAnnotationRequest = { rUri: ResourceUri };
type DeleteAnnotationResponse = { success: boolean };
type GenerateResourceFromAnnotationRequest = RequestContent<paths['/resources/{resourceId}/annotations/{annotationId}/generate-resource']['post']>;
type GenerateResourceFromAnnotationResponse = paths['/resources/{resourceId}/annotations/{annotationId}/generate-resource']['post']['responses'][201]['content']['application/json'];
type UpdateAnnotationBodyRequest = RequestContent<paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']>;
type UpdateAnnotationBodyResponse = paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']['responses'][200]['content']['application/json'];

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
          const resourceUri = getTargetSource(response.annotation.target);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(resourceUri) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceUri) });
        },
      });
    },
  },

  saveAsHighlight: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ rUri, exact, position }: {
          rUri: ResourceUri;
          exact: string;
          position: { start: number; end: number };
        }) => {
          const data: CreateAnnotationRequest = {
            target: {
              source: rUri, // Full URI
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
          const resourceUri = getTargetSource(response.annotation.target);
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(resourceUri) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceUri) });
        },
      });
    },
  },

  delete: {
    useMutation: () => {
      const { data: session } = useSession();
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: ({ id, rUri }: { id: string } & DeleteAnnotationRequest) => {
          const body: DeleteAnnotationRequest = { rUri };
          // URL-encode the annotation ID since it's a full URI with slashes and colons
          const encodedId = encodeURIComponent(id);
          return fetchAPI<DeleteAnnotationResponse>(`/api/annotations/${encodedId}`, {
            method: 'DELETE',
            body: JSON.stringify(body),
          }, session?.backendToken);
        },
        onSuccess: (_, variables) => {
          const rUriValue = variables.rUri;
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(rUriValue) });
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(rUriValue) });
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
            const resourceUri = getTargetSource(response.annotation.target);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(resourceUri) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.annotations(resourceUri) });
          }
          // Also invalidate the resource specified in the request
          if (variables.data.resourceId) {
            const rUri = resourceUri(variables.data.resourceId);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.detail(rUri) });
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.documents.referencedBy(rUri) });
          }
        },
      });
    },
  },
};
