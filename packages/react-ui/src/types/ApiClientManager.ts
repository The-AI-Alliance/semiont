import type { SemiontApiClient } from '@semiont/api-client';

/**
 * API client management interface
 * Apps implement this to provide API client instances based on authentication state
 */
export interface ApiClientManager {
  /**
   * API client instance
   * null when user is not authenticated or session is invalid
   */
  client: SemiontApiClient | null;
}
