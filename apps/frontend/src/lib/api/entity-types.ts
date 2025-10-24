/**
 * Entity Types API
 */

import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { paths } from '@semiont/api-client';
type AddEntityTypeResponse = paths['/api/entity-types']['post']['responses'][200]['content']['application/json'];

export const entityTypes = {
  all: {
    useQuery: (options?: Omit<UseQueryOptions<{ entityTypes: string[] }>, 'queryKey' | 'queryFn'>) => {
      const { data: session } = useSession();
      return useQuery({
        queryKey: QUERY_KEYS.entityTypes.all(),
        queryFn: () => fetchAPI<{ entityTypes: string[] }>('/api/entity-types', {}, session?.backendToken),
        // All authenticated users can read entity types for creating annotations
        enabled: !!session?.backendToken,
        ...options, // Allow overriding defaults with custom options
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
