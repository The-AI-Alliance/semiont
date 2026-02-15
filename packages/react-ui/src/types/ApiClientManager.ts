import type { SemiontApiClient } from '@semiont/api-client';

/**
 * API client management type
 * Apps implement hooks that return API client instances based on authentication state
 *
 * Returns null when user is not authenticated or session is invalid
 */
export type ApiClientManager = SemiontApiClient | null;
