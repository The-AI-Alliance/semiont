import type { ResourceUri } from '@semiont/core';

/**
 * Cache Manager Interface
 *
 * Framework-agnostic interface for cache invalidation.
 * Apps provide implementations via CacheProvider.
 *
 * This abstraction allows react-ui to trigger cache invalidation
 * without depending on a specific data fetching library (React Query, SWR, Apollo, etc.)
 *
 * Example implementation (React Query):
 * ```typescript
 * function useCacheManager(): CacheManager {
 *   const queryClient = useQueryClient();
 *
 *   return {
 *     invalidateAnnotations: (rUri) => {
 *       queryClient.invalidateQueries({ queryKey: ['annotations', rUri] });
 *     },
 *     invalidateEvents: (rUri) => {
 *       queryClient.invalidateQueries({ queryKey: ['documents', 'events', rUri] });
 *     }
 *   };
 * }
 * ```
 *
 * Example implementation (SWR):
 * ```typescript
 * function useCacheManager(): CacheManager {
 *   const { mutate } = useSWRConfig();
 *
 *   return {
 *     invalidateAnnotations: (rUri) => {
 *       mutate((key) => Array.isArray(key) && key[0] === 'annotations' && key[1] === rUri);
 *     },
 *     invalidateEvents: (rUri) => {
 *       mutate((key) => Array.isArray(key) && key[0] === 'events' && key[1] === rUri);
 *     }
 *   };
 * }
 * ```
 */
export interface CacheManager {
  /**
   * Invalidate annotation cache for a resource
   * @param rUri - Resource URI
   * @returns Promise or void (synchronous invalidation is acceptable)
   */
  invalidateAnnotations: (rUri: ResourceUri) => void | Promise<void>;

  /**
   * Invalidate events cache for a resource
   * @param rUri - Resource URI
   * @returns Promise or void (synchronous invalidation is acceptable)
   */
  invalidateEvents: (rUri: ResourceUri) => void | Promise<void>;
}
