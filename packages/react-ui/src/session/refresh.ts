/**
 * Refresh-token coordination for the Semiont session layer.
 *
 * Module-scoped state: an in-flight Promise per KB so concurrent 401s for
 * the same KB deduplicate to a single network call.
 */

import { SemiontApiClient } from '@semiont/api-client';
import { baseUrl, refreshToken as makeRefreshToken } from '@semiont/core';
import type { KnowledgeBase } from '../types/knowledge-base';
import { getStoredSession, setStoredSession, kbBackendUrl } from './storage';
import type { SessionStorage } from './session-storage';

/**
 * One in-flight refresh promise per KB. Ensures concurrent 401s for the same
 * KB deduplicate to a single network call.
 */
const inFlightRefreshes: Map<string, Promise<string | null>> = new Map();

/**
 * Refresh the active KB's access token. Returns the new access token, or
 * null if no refresh token is available or the refresh failed.
 *
 * IMPORTANT: this constructs a fresh `SemiontApiClient` *without* a
 * `tokenRefresher`. Do not be tempted to reuse the configured client: a
 * refresh-call returning 401 would recursively re-enter the refresher,
 * calling `/api/tokens/refresh` again, in an infinite loop. The throwaway
 * client deliberately has no recovery path — a 401 here propagates as `null`
 * and surfaces the modal upstream.
 *
 * Concurrent calls for the same KB deduplicate via the in-flight Promise
 * Map keyed by `kb.id`, so simultaneous 401s on different requests trigger
 * only one network round-trip to `/api/tokens/refresh`.
 */
export async function performRefresh(
  kb: KnowledgeBase,
  storage: SessionStorage,
): Promise<string | null> {
  const existing = inFlightRefreshes.get(kb.id);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    const stored = getStoredSession(storage, kb.id);
    if (!stored) return null;

    const client = new SemiontApiClient({
      baseUrl: baseUrl(kbBackendUrl(kb)),
    });

    try {
      const response = await client.refreshToken(makeRefreshToken(stored.refresh));
      const newAccess = response.access_token;
      if (!newAccess) return null;
      setStoredSession(storage, kb.id, { access: newAccess, refresh: stored.refresh });
      return newAccess;
    } catch {
      return null;
    }
  })();

  inFlightRefreshes.set(kb.id, promise);
  try {
    return await promise;
  } finally {
    inFlightRefreshes.delete(kb.id);
  }
}
