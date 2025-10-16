/**
 * Fetch wrapper for frontend API calls
 * Simple fetch wrapper with authentication and error handling
 */

import { env } from '../env';
import { APIError } from './types';

/**
 * Fetch helper with authentication
 */
export async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers || {}) as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = env.NEXT_PUBLIC_API_URL ? `${env.NEXT_PUBLIC_API_URL}${endpoint}` : endpoint;

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as any;
    throw new APIError(
      errorData.message || `HTTP ${response.status}: ${response.statusText}`,
      response.status,
      response.statusText,
      errorData
    );
  }

  // Handle 204 No Content responses
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
