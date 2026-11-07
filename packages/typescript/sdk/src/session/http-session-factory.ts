/**
 * createHttpSessionFactory — the default `SessionFactory` for HTTP-backed
 * KBs. Owns every HTTP-specific construction concern, so `SemiontBrowser`
 * has none: building `HttpTransport`/`HttpContentTransport`,
 * wiring the `tokenRefresher` callback, deduplicating concurrent 401
 * refresh round trips, renewing the session at its issuer, and asking the
 * gateway who a stored token is. Each session's sign-in is the knowledge
 * base's in the registry's storage, as `keptIn` keeps it.
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
import { kbGatewayUrl, keptIn, lastEventIdKey, personKey } from './storage';
import { renewKept } from './oauth';
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
    const signIn = keptIn(storage, kb.id);

    /**
     * Renew `holding`, the KB's access token the session holds, at the
     * issuer the kept sign-in names. Concurrent calls for the same KB
     * dedup through `inFlightRefreshes`, so simultaneous 401s trigger only
     * one refresh grant.
     */
    const performRefresh = async (holding: string | null): Promise<string | null> => {
      const existing = inFlightRefreshes.get(kb.id);
      if (existing) return existing;

      const promise = renewKept(signIn, holding, fetch);

      inFlightRefreshes.set(kb.id, promise);
      try {
        return await promise;
      } finally {
        inFlightRefreshes.delete(kb.id);
      }
    };

    /**
     * The sign-in could not be read before a save: the client keeps nothing
     * more for its life, and the session's host is told so once.
     */
    const unreadable = (cause: unknown): void => {
      const why = cause instanceof Error ? cause.message : String(cause);
      onError(new SemiontSessionError(
        'session.keep-failed',
        `The sign-in could not be read before what the client keeps was saved, so it keeps nothing more: ${why}`,
        kb.id,
      ));
    };

    /**
     * B17: what the session keeps for one person, the stream's places and
     * the caches, through a store that writes only while the kept sign-in
     * names that person. The places are COUPLED to the cache flush (stashed
     * in memory, written only alongside cache-document writes), so the kept
     * bookmark can lag the caches but never lead them, and a reload resumes
     * by replay instead of gapping.
     */
    const keepingFor = (person: string) => {
      const coupled = coupledLastEventId(whileSignedIn(storage, signIn, person, unreadable), lastEventIdKey(kb.id, person));
      return { ...coupled, persistence: { storage: coupled.storage, kbId: kb.id, personKey: person } };
    };
    // Kept from the start when the kept sign-in names its person; until
    // the gateway names them otherwise, nothing is kept.
    const named = signIn.held()?.personKey;
    let keeping = named === undefined ? null : keepingFor(named);

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
      ...(keeping === null ? {} : { loadLastEventIds: keeping.loadLastEventIds }),
      saveLastEventId: (scope, id) => {
        if (keeping !== null) keeping.saveLastEventId(scope, id);
      },
      ...(fetch ? { fetch } : {}),
    });
    const content = new HttpContentTransport(transport);
    const client = new SemiontClient(transport, content, transport, keeping === null ? {} : { cachePersistence: keeping.persistence });
    // B17-Q (C1): the bookmark flush waits for persisted-cache quiescence —
    // a bystander document write must not carry an id whose event some other
    // cache is still absorbing (mid-refetch, mid-debounce, or a refetch the
    // refresher's window owes). Wired after
    // construction because the gate reads the client's own caches.
    const settled = (): boolean => client.browse.persistenceSettled();
    if (keeping !== null) keeping.setFlushGate(settled);

    /**
     * Ask the gateway who `token` is: one request, with no client behind it.
     * The session asks at startup, to populate `user$`, and decides for
     * itself what a refusal means. A client built for the asking would open
     * a bus stream each time it is built, with the token being asked about.
     *
     * The answer names the person, recorded on the kept sign-in only while
     * it still holds `token` (a renewal or another context's sign-in in
     * between records nothing). Recorded for a session keeping nothing yet,
     * it starts keeping before the answer is handed back, so before the
     * session is `ready`: the kept caches fill what this life has not asked
     * for, and the kept places what the stream has not seen.
     */
    const performValidate = async (token: AccessToken): Promise<UserInfo> => {
      const user = await currentUserOf(gateway, token, fetch);
      const person = personKey(user.did);
      if (signIn.recordPersonKey(token, person) && keeping === null) {
        keeping = keepingFor(person);
        keeping.setFlushGate(settled);
        client.browse.attachPersistence(keeping.persistence);
        const places = keeping.loadLastEventIds();
        if (places !== null) transport.restoreLastEventIds(places);
      }
      return user;
    };

    session = new SemiontSession({
      kb,
      kept: signIn,
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
