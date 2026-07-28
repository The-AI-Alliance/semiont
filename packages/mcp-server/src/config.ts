/**
 * Startup configuration.
 *
 * The server needs exactly two environment variables and refuses to start
 * without either. Reading them through a function (rather than at module
 * scope in `index.ts`) keeps the contract assertable without booting the
 * stdio server.
 */

import { baseUrl, accessToken, type BaseUrl, type AccessToken } from '@semiont/core';

export interface McpConfig {
  apiUrl: BaseUrl;
  token: AccessToken;
}

export function readConfig(env: NodeJS.ProcessEnv): McpConfig {
  if (!env.SEMIONT_API_URL) {
    throw new Error('SEMIONT_API_URL environment variable is required');
  }
  if (!env.SEMIONT_ACCESS_TOKEN) {
    throw new Error('SEMIONT_ACCESS_TOKEN environment variable is required');
  }
  return {
    apiUrl: baseUrl(env.SEMIONT_API_URL),
    token: accessToken(env.SEMIONT_ACCESS_TOKEN),
  };
}
