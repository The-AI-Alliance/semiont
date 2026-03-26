/**
 * Authenticated API Client Factory
 *
 * Single point of entry for CLI commands that need to talk to the live backend.
 * Handles credential resolution, token acquisition, and caching.
 *
 * Credential resolution order:
 *   1. SEMIONT_USER / SEMIONT_PASSWORD environment variables
 *   2. [environments.<name>.auth] email / password in ~/.semiontconfig
 *   3. Error — no silent fallbacks
 *
 * Token cache: ~/.local/state/semiont/{project}/auth-token.json (mode 0600)
 * The backend issues opaque tokens with no expiry in the response; we cache for
 * TOKEN_CACHE_TTL_MS and re-authenticate when stale.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SemiontProject } from '@semiont/core/node';
import { SemiontApiClient } from '@semiont/api-client';
import {
  email as toEmail,
  accessToken as toAccessToken,
  baseUrl as toBaseUrl,
  type AccessToken,
} from '@semiont/core';
import { loadEnvironmentConfig } from './config-loader.js';

export interface AuthenticatedClient {
  client: SemiontApiClient;
  token: AccessToken;
}

interface TokenCache {
  token: string;
  cachedAt: string;
  email: string;
}

/** Re-authenticate after 1 hour */
const TOKEN_CACHE_TTL_MS = 3_600_000;

function tokenCachePath(project: SemiontProject): string {
  return path.join(project.stateDir, 'auth-token.json');
}

function readTokenCache(cachePath: string): TokenCache | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(raw) as TokenCache;
  } catch {
    return null;
  }
}

function writeTokenCache(cachePath: string, cache: TokenCache): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function isTokenValid(cache: TokenCache): boolean {
  const cachedAt = new Date(cache.cachedAt).getTime();
  return Date.now() < cachedAt + TOKEN_CACHE_TTL_MS;
}

/**
 * Create an authenticated SemiontApiClient for the given project and environment.
 * Caches the token in the XDG state directory and re-authenticates when stale.
 */
export async function createAuthenticatedClient(
  projectRoot: string,
  environment: string,
): Promise<AuthenticatedClient> {
  const envConfig = loadEnvironmentConfig(projectRoot, environment);

  const rawBaseUrl = envConfig.services?.backend?.publicURL;
  if (!rawBaseUrl) {
    throw new Error(
      `services.backend.publicURL is not set for environment '${environment}' in ~/.semiontconfig`
    );
  }

  const client = new SemiontApiClient({ baseUrl: toBaseUrl(rawBaseUrl) });

  // Resolve email
  const emailStr = process.env.SEMIONT_USER
    ?? (envConfig as any).auth?.email
    ?? null;

  if (!emailStr) {
    throw new Error(
      `No auth email configured. Set SEMIONT_USER or add:\n` +
      `  [environments.${environment}.auth]\n  email = "you@example.com"\n` +
      `to ~/.semiontconfig`
    );
  }

  // Return cached token if still valid for this email
  const project = new SemiontProject(projectRoot);
  const cachePath = tokenCachePath(project);
  const cached = readTokenCache(cachePath);

  if (cached && cached.email === emailStr && isTokenValid(cached)) {
    return { client, token: toAccessToken(cached.token) };
  }

  // Need to re-authenticate — require password
  const passwordStr = process.env.SEMIONT_PASSWORD
    ?? (envConfig as any).auth?.password
    ?? null;

  if (!passwordStr) {
    throw new Error(
      `No auth password configured. Set SEMIONT_PASSWORD or add:\n` +
      `  password = "..."\n` +
      `to [environments.${environment}.auth] in ~/.semiontconfig`
    );
  }

  const authResult = await client.authenticatePassword(toEmail(emailStr), passwordStr);
  const newCache: TokenCache = {
    token: authResult.token,
    cachedAt: new Date().toISOString(),
    email: emailStr,
  };
  writeTokenCache(cachePath, newCache);
  return { client, token: toAccessToken(newCache.token) };
}
