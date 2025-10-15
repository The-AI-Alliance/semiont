/**
 * Entity Types API
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';
import type { AddEntityTypeResponse } from '@semiont/sdk';

export const entityTypes = {
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
