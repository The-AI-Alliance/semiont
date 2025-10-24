/**
 * Frontend API Client
 *
 * Pure TanStack Query hooks for API calls.
 * Domain-based organization for better maintainability.
 */

// Re-export query keys
export { QUERY_KEYS } from '../query-keys';

// API Error class (frontend-specific, not in OpenAPI spec)
export class APIError extends Error {
  public status: number;
  public statusText: string;
  public details: unknown;
  public data: unknown;

  constructor(
    message: string,
    status: number = 500,
    statusText: string = 'Internal Server Error',
    details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
    this.data = details;
  }
}

// Export React Query hooks (domain-based)
export { health } from './health';
export { auth } from './auth';
export { admin } from './admin';
export { entityTypes } from './entity-types';
export { documents } from './documents';
export { annotations } from './annotations';
