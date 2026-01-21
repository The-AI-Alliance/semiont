import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CacheManager } from '@semiont/react-ui';
import type { ResourceUri } from '@semiont/api-client';

/**
 * Frontend implementation of CacheManager using React Query
 *
 * Usage:
 * ```typescript
 * const cacheManager = useCacheManager();
 * <CacheProvider cacheManager={cacheManager}>
 *   <YourComponents />
 * </CacheProvider>
 * ```
 */
export function useCacheManager(): CacheManager {
  const queryClient = useQueryClient();

  return useMemo(() => ({
    invalidateAnnotations: (rUri: ResourceUri) => {
      queryClient.invalidateQueries({ queryKey: ['resources', rUri, 'annotations'] });
    },
    invalidateEvents: (rUri: ResourceUri) => {
      queryClient.invalidateQueries({ queryKey: ['resources', rUri, 'events'] });
    }
  }), [queryClient]);
}
