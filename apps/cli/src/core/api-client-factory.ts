/**
 * API Client Factory
 *
 * Two entry points:
 *
 *   acquireToken(bus, email, password) — called by `semiont login`
 *     Authenticates against the backend and writes the token to the store.
 *
 *   loadCachedClient(bus) — called by every API command
 *     Reads the cached token for the given bus URL.
 *     Throws a user-facing error if absent or expired — run `semiont login`.
 *
 * Token store: $XDG_STATE_HOME/semiont/auth/<slug>.json  (mode 0600)
 * TTL: 24 hours. Slug derived from bus URL (scheme stripped, separators normalized).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SemiontApiClient } from '@semiont/api-client';
import {
  email as toEmail,
  accessToken as toAccessToken,
  baseUrl as toBaseUrl,
  type AccessToken,
  EventBus,
} from '@semiont/core';

export interface AuthenticatedClient {
  semiont: SemiontApiClient;
  token: AccessToken;
}

interface TokenCache {
  bus: string;
  email: string;
  token: string;
  cachedAt: string;
}

/** Re-authenticate after 24 hours */
const TOKEN_CACHE_TTL_MS = 86_400_000;

// ─── Path helpers ────────────────────────────────────────────────────────────

function authStoreDir(): string {
  const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'semiont', 'auth');
}

/**
 * Convert a bus URL to a safe filename slug.
 * https://api.acme.com  →  api.acme.com
 * http://localhost:4000 →  localhost-4000
 */
export function busSlug(rawUrl: string): string {
  return rawUrl
    .replace(/^https?:\/\//, '')   // strip scheme
    .replace(/\/+$/, '')            // strip trailing slashes
    .replace(/[:/]/g, '-')          // colons and slashes → dashes
    .toLowerCase();
}

function tokenCachePath(rawBusUrl: string): string {
  return path.join(authStoreDir(), `${busSlug(rawBusUrl)}.json`);
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
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function isTokenValid(cache: TokenCache): boolean {
  const cachedAt = new Date(cache.cachedAt).getTime();
  return Date.now() < cachedAt + TOKEN_CACHE_TTL_MS;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Authenticate against the backend and cache the token.
 * Called by `semiont login`.
 */
export async function acquireToken(
  rawBusUrl: string,
  emailStr: string,
  passwordStr: string,
): Promise<void> {
  const semiont = new SemiontApiClient({ baseUrl: toBaseUrl(rawBusUrl), eventBus: new EventBus() });
  const authResult = await semiont.authenticatePassword(toEmail(emailStr), passwordStr);
  const cache: TokenCache = {
    bus: rawBusUrl,
    email: emailStr,
    token: authResult.token,
    cachedAt: new Date().toISOString(),
  };
  writeTokenCache(tokenCachePath(rawBusUrl), cache);
}

/**
 * Load a cached token for the given bus URL and return an authenticated client.
 * Called by every API command.
 *
 * Throws a user-facing error if no valid token exists.
 */
export function loadCachedClient(rawBusUrl: string): AuthenticatedClient {
  const cachePath = tokenCachePath(rawBusUrl);
  const cached = readTokenCache(cachePath);

  if (!cached || !isTokenValid(cached)) {
    throw new Error(
      `Not logged in to ${rawBusUrl}.\n` +
      `Run: semiont login --bus ${rawBusUrl}`
    );
  }

  const semiont = new SemiontApiClient({ baseUrl: toBaseUrl(rawBusUrl), eventBus: new EventBus() });
  return { semiont, token: toAccessToken(cached.token) };
}

/**
 * Resolve the bus URL from --bus flag or $SEMIONT_BUS.
 * Throws if neither is set.
 */
export function resolveBusUrl(busFlag?: string): string {
  const url = busFlag ?? process.env.SEMIONT_BUS;
  if (!url) {
    throw new Error(
      'Backend URL not configured. Use --bus <url> or set $SEMIONT_BUS.\n' +
      'Run `semiont login --bus <url>` to authenticate.'
    );
  }
  return url;
}
