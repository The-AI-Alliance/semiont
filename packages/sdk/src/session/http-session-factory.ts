/**
 * createHttpSessionFactory — the default `SessionFactory` for HTTP-backed
 * KBs. Owns every HTTP-specific construction concern that used to live in
 * `SemiontBrowser`: building `HttpTransport`/`HttpContentTransport`,
 * wiring the `tokenRefresher` callback, deduplicating concurrent 401
 * refresh round trips, and invoking the auth endpoints for token refresh
 * and user-validate.
 *
 * Returned as a closure so a single `inFlightRefreshes` map is shared
 * across every session this factory builds — the dedup is meaningful
 * across concurrent session reactivations for the same KB id.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpTransport, HttpContentTransport } from '@semiont/api-client';
import { baseUrl, type AccessToken } from '@semiont/core';
import { SemiontClient } from '../client';
import { SemiontSession, type UserInfo } from './semiont-session';
import { SemiontSessionError } from './errors';
import { kbBackendUrl, getStoredSession, setStoredSession } from './storage';
import type { SessionFactory, SessionFactoryOptions } from './session-factory';

export function createHttpSessionFactory(): SessionFactory {
  const inFlightRefreshes = new Map<string, Promise<string | null>>();

  return (opts: SessionFactoryOptions): SemiontSession => {
    const { kb, storage, signals, onError } = opts;

    if (kb.endpoint.kind !== 'http') {
      throw new SemiontSessionError(
        'session.construct-failed',
        `HTTP session factory cannot construct a session for endpoint kind "${kb.endpoint.kind}"`,
        kb.id,
      );
    }
    const endpoint = kb.endpoint;

    /**
     * Refresh the KB's access token. Concurrent calls for the same KB
     * dedup through `inFlightRefreshes`, so simultaneous 401s trigger
     * only one `/api/tokens/refresh` round trip. Uses a throwaway
     * `SemiontClient` with no `tokenRefresher` — a refresh call
     * returning 401 would otherwise re-enter this function infinitely.
     */
    const performRefresh = async (): Promise<string | null> => {
      const existing = inFlightRefreshes.get(kb.id);
      if (existing) return existing;

      const promise = (async () => {
        const stored = getStoredSession(storage, kb.id);
        if (!stored) return null;
        const throwawayTransport = new HttpTransport({ baseUrl: baseUrl(kbBackendUrl(endpoint)) });
        const throwaway = new SemiontClient(throwawayTransport, new HttpContentTransport(throwawayTransport), throwawayTransport);
        try {
          const response = await throwaway.auth!.refresh(stored.refresh);
          const newAccess = response.access_token;
          if (!newAccess) return null;
          setStoredSession(storage, kb.id, { access: newAccess, refresh: stored.refresh });
          return newAccess;
        } catch {
          return null;
        } finally {
          throwaway.dispose();
        }
      })();

      inFlightRefreshes.set(kb.id, promise);
      try {
        return await promise;
      } finally {
        inFlightRefreshes.delete(kb.id);
      }
    };

    /**
     * Validate an access token by calling `auth.me` on a throwaway
     * client seeded with that specific token. The session uses this
     * once at startup to populate `user$`; 401 triggers a
     * refresh-then-retry inside the session.
     */
    const performValidate = async (token: AccessToken): Promise<UserInfo | null> => {
      const tokenSubject = new BehaviorSubject<AccessToken | null>(token);
      const throwawayTransport = new HttpTransport({
        baseUrl: baseUrl(kbBackendUrl(endpoint)),
        token$: tokenSubject,
      });
      const throwaway = new SemiontClient(throwawayTransport, new HttpContentTransport(throwawayTransport), throwawayTransport);
      try {
        const data = await throwaway.auth!.me();
        return data as UserInfo;
      } finally {
        throwaway.dispose();
        tokenSubject.complete();
      }
    };

    // Build transport stack: factory owns token$ and threads it through
    // transport (which reads it on every request) and session (which
    // writes refreshed values into it). The `tokenRefresher` closure
    // resolves `session` lazily — `session` is defined right after,
    // before any 401 could fire.
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    let session!: SemiontSession;
    const transport = new HttpTransport({
      baseUrl: baseUrl(kbBackendUrl(endpoint)),
      token$,
      tokenRefresher: () => session.refresh().then((t) => t ?? null),
    });
    const content = new HttpContentTransport(transport);
    const client = new SemiontClient(transport, content, transport);
    session = new SemiontSession({
      kb,
      storage,
      client,
      token$,
      refresh: performRefresh,
      validate: performValidate,
      onAuthFailed: (msg) => signals.notifySessionExpired(msg),
      onError,
    });
    return session;
  };
}
