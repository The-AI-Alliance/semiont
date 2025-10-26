/**
 * HTTP Client Utilities
 *
 * Reusable fetch wrapper for making authenticated HTTP requests.
 * Used by both frontend (via TanStack Query) and backend (direct calls).
 */

import { APIError } from './errors';

/**
 * Configuration for HTTP client
 */
export interface HttpClientConfig {
  baseUrl: string;
  token?: string;
}

/**
 * Fetch helper with authentication and error handling
 *
 * @param endpoint - API endpoint (e.g., '/api/documents')
 * @param options - Standard fetch options
 * @param token - Optional authentication token
 * @returns Typed response data
 * @throws APIError on HTTP errors
 */
export async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string,
  baseUrl: string = ''
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers || {}) as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = baseUrl ? `${baseUrl}${endpoint}` : endpoint;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as any;
    throw new APIError(response.status, errorData, errorData.message);
  }

  // Handle 204 No Content responses
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Create a configured fetch function with a base URL
 * Useful for creating client-specific fetch instances
 *
 * @param baseUrl - Base URL for all requests (e.g., 'http://localhost:4000')
 * @returns Configured fetch function
 */
export function createFetchAPI(baseUrl: string) {
  return function <T>(
    endpoint: string,
    options: RequestInit = {},
    token?: string
  ): Promise<T> {
    return fetchAPI<T>(endpoint, options, token, baseUrl);
  };
}
