/**
 * Authentication Helpers
 *
 * Reusable authentication utilities for demo scripts.
 */

import type { SemiontApiClient } from '@semiont/api-client';
import { accessToken, email } from '@semiont/api-client';
import { printInfo, printSuccess } from './display';

export interface AuthConfig {
  email?: string;
  accessToken?: string;
}

/**
 * Authenticate with the backend using email or access token
 */
export async function authenticate(client: SemiontApiClient, config: AuthConfig): Promise<void> {
  if (config.accessToken) {
    printInfo('Using provided access token...');
    client.setAccessToken(accessToken(config.accessToken));
    printSuccess('Access token configured');
  } else if (config.email) {
    printInfo(`Authenticating as ${config.email}...`);
    await client.authenticateLocal(email(config.email));
    printSuccess(`Authenticated successfully`);
  } else {
    throw new Error('Either email or accessToken must be provided');
  }
}
