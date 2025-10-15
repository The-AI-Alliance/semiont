/**
 * Frontend API Client
 *
 * Pure TanStack Query hooks that use types from @semiont/sdk.
 * Domain-based organization for better maintainability.
 */

// Re-export types for convenience
export type {
  Document,
  Annotation,
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserRequest,
  OAuthProvider,
  OAuthConfigResponse,
} from '@semiont/sdk';

// Re-export API Error class and query keys
export { APIError } from '@semiont/sdk';
export { QUERY_KEYS } from '../query-keys';

// Export individual domain APIs
export { health } from './health';
export { auth } from './auth';
export { admin } from './admin';
export { entityTypes } from './entity-types';
export { documents } from './documents';
export { annotations } from './annotations';

// Import for main API object
import { health } from './health';
import { auth } from './auth';
import { admin } from './admin';
import { entityTypes } from './entity-types';
import { documents } from './documents';
import { annotations } from './annotations';

/**
 * Main API object - for backward compatibility
 * Prefer importing individual domains directly for better tree-shaking
 */
export const api = {
  health,
  auth,
  admin,
  entityTypes,
  documents,
  annotations,
};
