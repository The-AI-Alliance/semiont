/**
 * createHttpSessionFactory — the default `SessionFactory` for HTTP-backed
 * KBs. Owns every HTTP-specific construction concern that used to live in
 * `SemiontBrowser`: building `HttpTransport`/`HttpContentTransport`,
 * wiring the `tokenRefresher` callback, deduplicating concurrent 401
 * refresh round trips, renewing the session at its issuer, and asking the
 * gateway who a stored token is.
 *
 * Returned as a closure so a single `inFlightRefreshes` map is shared
 * across every session this factory builds — the dedup is meaningful
 * across concurrent session reactivations for the same KB id.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpTransport, HttpContentTransport, currentUserOf } from '@semiont/http-transport';
import { baseUrl, type AccessToken } from '@semiont/core';
import { SemiontClient } from '../client';
import { coupledLastEventId } from '../cache-persister';
import { SemiontSession, type UserInfo } from './semiont-session';
import { SemiontSessionError } from './errors';
import { kbGatewayUrl } from './storage';
import { refreshStoredSession } from './oauth';
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
     * Renew the KB's access token at the issuer the stored session names.
     * Concurrent calls for the same KB dedup through `inFlightRefreshes`,
     * so simultaneous 401s trigger only one refresh grant.
     */
    const performRefresh = async (): Promise<string | null> => {
      const existing = inFlightRefreshes.get(kb.id);
      if (existing) return existing;

      const promise = refreshStoredSession(storage, kb.id);

      inFlightRefreshes.set(kb.id, promise);
      try {
        return await promise;
      } finally {
        inFlightRefreshes.delete(kb.id);
      }
    };

    /**
     * Ask the gateway who `token` is: one request, with no client behind it.
     * The session asks at startup, to populate `user$`, and decides for
     * itself what a refusal means. A client built for the asking opened a
     * bus stream each time it was built, with the token being asked about.
     */
    const performValidate = (token: AccessToken): Promise<UserInfo> =>
      currentUserOf(baseUrl(kbGatewayUrl(endpoint)), token);

    // Build transport stack: factory owns token$ and threads it through
    // transport (which reads it on every request) and session (which
    // writes refreshed values into it). The `tokenRefresher` closure
    // resolves `session` lazily — `session` is defined right after,
    // before any 401 could fire.
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    let session!: SemiontSession;
    // B17: resume from the last persisted SSE id across reloads, so
    // rehydrated caches reconcile by replay instead of gapping. The id is
    // COUPLED to the cache flush (stashed in memory, written only alongside
    // cache-document writes) so the persisted bookmark can lag the caches
    // but never lead them.
    const coupled = coupledLastEventId(storage, `semiont.lastEventId.${kb.id}`);
    const transport = new HttpTransport({
      baseUrl: baseUrl(kbGatewayUrl(endpoint)),
      token$,
      tokenRefresher: () => session.refresh().then((t) => t ?? null),
      loadLastEventIds: coupled.loadLastEventIds,
      saveLastEventId: coupled.saveLastEventId,
    });
    const content = new HttpContentTransport(transport);
    // B17: the session's client persists its browse caches through the
    // environment's storage adapter, scoped by KB.
    const client = new SemiontClient(transport, content, transport, {
      cachePersistence: { storage: coupled.storage, keyPrefix: kb.id },
    });
    // B17-Q (C1): the bookmark flush waits for persisted-cache quiescence —
    // a bystander document write must not carry an id whose event some other
    // cache is still absorbing (mid-refetch or mid-debounce). Wired after
    // construction because the gate reads the client's own caches.
    coupled.setFlushGate(() => client.browse.persistenceSettled());
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
