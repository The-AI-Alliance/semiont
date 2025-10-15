/**
 * Health Check API
 */

import { useQuery } from '@tanstack/react-query';
import { fetchAPI } from './fetch-wrapper';
import { QUERY_KEYS } from '../query-keys';

export const health = {
  useQuery: () => {
    return useQuery({
      queryKey: QUERY_KEYS.health(),
      queryFn: () => fetchAPI<{ status: string }>('/api/health'),
    });
  },
};
