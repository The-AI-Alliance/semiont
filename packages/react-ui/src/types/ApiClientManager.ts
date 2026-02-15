import type { SemiontApiClient } from '@semiont/api-client';

/**
 * API client management type
 * Apps must provide a valid API client instance
 * Authentication must be handled before rendering components that require API access
 */
export type ApiClientManager = SemiontApiClient;
