/**
 * Fetch wrapper for frontend API calls
 * Wraps SDK fetchAPI with frontend-specific API_URL
 */

import { fetchAPI as sdkFetchAPI } from '@semiont/sdk';
import { env } from '../env';

/**
 * Fetch helper with authentication - wraps SDK fetchAPI with frontend API_URL
 */
export async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  return sdkFetchAPI<T>(endpoint, options, token, env.NEXT_PUBLIC_API_URL);
}
