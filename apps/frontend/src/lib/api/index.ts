/**
 * Frontend API Client
 *
 * Shared utilities for the frontend API layer.
 * React Query hooks are in domain-specific files (annotations.ts, documents.ts, etc.)
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
