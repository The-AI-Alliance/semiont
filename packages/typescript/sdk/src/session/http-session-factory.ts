/**
 * createHttpSessionFactory — the default `SessionFactory` for HTTP-backed
 * KBs. Owns every HTTP-specific construction concern, so `SemiontBrowser`
 * has none: building `HttpTransport`/`HttpContentTransport`,
 * wiring the `tokenRefresher` callback, deduplicating concurrent 401
 * refresh round trips, renewing the session at its issuer, and asking the
 * gateway who a stored token is.
 *
 * Returned as a closure so a single `inFlightRefreshes` map is shared
 * across every session this factory builds — the dedup is meaningful
 * across concurrent session reactivations for the same KB id.
 *
 * Every request of every session it builds, of the gateway and of the
 * issuer, is sent with `fetch`, or the runtime's own.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpTransport, HttpContentTransport, currentUserOf } from '@semiont/http-transport';
import { baseUrl, type AccessToken } from '@semiont/core';
import { SemiontClient } from '../client';
import { coupledLastEventId, whileSignedIn } from '../cache-persister';
import { SemiontSession, type UserInfo } from './semiont-session';
import { SemiontSessionError } from './errors';
import { getStoredSession, kbGatewayUrl, lastEventIdKey, personKey, recordPersonKey } from './storage';
import { refreshStoredSession } from './oauth';
import type { SessionFactory, SessionFactoryOptions } from './session-factory';

export function createHttpSessionFactory(fetch?: typeof globalThis.fetch): SessionFactory {
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
    const gateway = baseUrl(kbGatewayUrl(endpoint));

    /**
     * Renew `holding`, the KB's access token the session holds, at the
     * issuer the stored session names. Concurrent calls for the same KB
     * dedup through `inFlightRefreshes`, so simultaneous 401s trigger only
     * one refresh grant.
     */
    const performRefresh = async (holding: string | null): Promise<string | null> => {
      const existing = inFlightRefreshes.get(kb.id);
      if (existing) return existing;

      const promise = refreshStoredSession(storage, kb.id, holding, fetch);

      inFlightRefreshes.set(kb.id, promise);
      try {
        return await promise;
      } finally {
        inFlightRefreshes.delete(kb.id);
      }
    };

    /**
     * B17: what the session keeps for one person, the stream's places and
     * the caches, through a store that writes only while the stored sign-in
     * names that person. The places are COUPLED to the cache flush (stashed
     * in memory, written only alongside cache-document writes), so the kept
     * bookmark can lag the caches but never lead them, and a reload resumes
     * by replay instead of gapping.
     */
    const keeping = (person: string) => {
      const coupled = coupledLastEventId(whileSignedIn(storage, kb.id, person), lastEventIdKey(kb.id, person));
      return { ...coupled, persistence: { storage: coupled.storage, kbId: kb.id, personKey: person } };
    };
    // Kept from the start when the stored sign-in names its person; until
    // the gateway names them otherwise, nothing is kept.
    const named = getStoredSession(storage, kb.id)?.personKey;
    let kept = named === undefined ? null : keeping(named);

    // Build transport stack: factory owns token$ and threads it through
    // transport (which reads it on every request) and session (which
    // writes refreshed values into it). The `tokenRefresher` closure
    // resolves `session` lazily — `session` is defined right after,
    // before any 401 could fire.
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    let session!: SemiontSession;
    const transport = new HttpTransport({
      baseUrl: gateway,
      token$,
      tokenRefresher: (refused) => session.refresh(refused),
      ...(kept === null ? {} : { loadLastEventIds: kept.loadLastEventIds }),
      saveLastEventId: (scope, id) => {
        if (kept !== null) kept.saveLastEventId(scope, id);
      },
      ...(fetch ? { fetch } : {}),
    });
    const content = new HttpContentTransport(transport);
    const client = new SemiontClient(transport, content, transport, kept === null ? {} : { cachePersistence: kept.persistence });
    // B17-Q (C1): the bookmark flush waits for persisted-cache quiescence —
    // a bystander document write must not carry an id whose event some other
    // cache is still absorbing (mid-refetch or mid-debounce). Wired after
    // construction because the gate reads the client's own caches.
    const settled = (): boolean => client.browse.persistenceSettled();
    if (kept !== null) kept.setFlushGate(settled);

    /**
     * Ask the gateway who `token` is: one request, with no client behind it.
     * The session asks at startup, to populate `user$`, and decides for
     * itself what a refusal means. A client built for the asking would open
     * a bus stream each time it is built, with the token being asked about.
     *
     * The answer names the person, recorded on the stored sign-in only while
     * it still holds `token` (a renewal or another context's sign-in in
     * between records nothing). Recorded for a session keeping nothing yet,
     * it starts keeping before the answer is handed back, so before the
     * session is `ready`: the kept caches fill what this life has not asked
     * for, and the kept places what the stream has not seen.
     */
    const performValidate = async (token: AccessToken): Promise<UserInfo> => {
      const user = await currentUserOf(gateway, token, fetch);
      const person = personKey(user.did);
      if (recordPersonKey(storage, kb.id, token, person) && kept === null) {
        kept = keeping(person);
        kept.setFlushGate(settled);
        client.browse.attachPersistence(kept.persistence);
        const places = kept.loadLastEventIds();
        if (places !== null) transport.restoreLastEventIds(places);
      }
      return user;
    };

    session = new SemiontSession({
      kb,
      storage,
      client,
      token$,
      refresh: performRefresh,
      validate: performValidate,
      onAuthFailed: (reason) => signals.notifySessionEnded(reason),
      onError,
    });
    return session;
  };
}
