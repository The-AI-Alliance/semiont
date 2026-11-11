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
 * issuer, is sent with `fetch`, or the runtime's own. It reads none of a
 * session's errors: the registry that calls it does.
 */

import { BehaviorSubject } from 'rxjs';
import { HttpTransport, HttpContentTransport, currentUserOf } from '@semiont/http-transport';
import { BRIDGED_CHANNELS, baseUrl, type AccessToken } from '@semiont/core';
import { SemiontClient } from '../client';
import { personKeeping } from '../cache-persister';
import { SemiontSession, sayOn, type UserInfo } from './semiont-session';
import { SemiontSessionError } from './errors';
import { kbGatewayUrl, keptIn } from './storage';
import { renewKept } from './oauth';
import type { SessionFactory, SessionFactoryOptions } from './session-factory';

export function createHttpSessionFactory(fetch?: typeof globalThis.fetch): SessionFactory {
  const inFlightRefreshes = new Map<string, Promise<string | null>>();

  return (opts: SessionFactoryOptions): SemiontSession => {
    const { kb, storage, signals } = opts;
    let session!: SemiontSession;

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

    // B17: what the session keeps for one person, the stream's places and
    // the caches, kept from the start when the kept sign-in names its
    // person; until the gateway names them otherwise, nothing is kept. What
    // goes wrong with it, the session says on its errors.
    const keeps = personKeeping(storage, kb.id, signIn, (error) => sayOn(session, error));

    // Build transport stack: factory owns token$ and threads it through
    // transport (which reads it on every request) and session (which
    // writes refreshed values into it). The `tokenRefresher` closure, and
    // what the keeping says, resolve `session` lazily — `session` is
    // defined right after, before any 401 or save could happen.
    const token$ = new BehaviorSubject<AccessToken | null>(null);
    const transport = new HttpTransport({
      baseUrl: gateway,
      token$,
      channels: BRIDGED_CHANNELS,
      tokenRefresher: (refused) => session.refresh(refused),
      ...(keeps.fromStart === null ? {} : { loadLastEventIds: keeps.fromStart.places.loadLastEventIds }),
      saveLastEventId: keeps.saveLastEventId,
      ...(fetch ? { fetch } : {}),
    });
    const content = new HttpContentTransport(transport);
    const client = new SemiontClient(transport, content, transport, keeps.fromStart === null ? {} : { cachePersistence: keeps.fromStart.persistence });
    // B17-Q (C1): the places wait for what the client keeps to be at rest —
    // a bystander document write must not carry an id whose event some other
    // cache is still absorbing (mid-refetch, mid-debounce, or a refetch the
    // refresher's window owes). Coupled after construction because the gate
    // reads the client's own caches.
    if (keeps.fromStart !== null) keeps.fromStart.places.coupleTo(client);

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
      keeps.named(token, user.did, client, transport);
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
    });
    return session;
  };
}
