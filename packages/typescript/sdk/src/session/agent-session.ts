/**
 * The token session a long-lived agent holds: a worker, or one of the
 * knowledge base's own services.
 *
 * An agent is an account, as a person is. Every such process signs in the
 * same way (`agentToken`, `@semiont/http-transport`): its account's token
 * from the trusted issuer is its bearer at the gateway, and the gateway names
 * it by that account. The session holds that token and keeps it fresh for as
 * long as the process runs, by a new grant at the issuer.
 *
 * It is not a `SemiontSession`. A person whose token cannot be renewed is
 * signed out, and signs in again. An agent whose renewal fails keeps the
 * token it has and tries again: a process holding a token that still works
 * does not stop working over one bad round trip.
 *
 * This lives in one place because a copy per process is a copy of the token
 * lifetime — a number the ISSUER owns. A copy that falls behind the issuer's
 * lifetime leaves the listen-only path (SSE, which reads `token$` on reconnect
 * rather than driving a request that could 401) quiet with nothing in the
 * logs.
 *
 * So the lifetime is not restated here. When a token expires is that token's
 * own `exp` claim, and how long before expiry to renew is `refreshDelayMs`
 * — the same derivation `SemiontSession` schedules from. One refresh policy,
 * read from the credential itself.
 *
 * That policy derives its margin from the token's own lifetime, never a fixed
 * one: a fixed margin can equal the lifetime an issuer mints (Keycloak's
 * default is five minutes), which schedules every refresh at delay zero.
 *
 * Two recovery paths:
 *   - `refresh` is handed to HttpTransport as its `tokenRefresher`, which
 *     renews once and sends again a request, an emit or the stream whose
 *     credential is refused (a 401, or a 429 `refusal-rate`).
 *   - the proactive timer covers the listen-only case, where nothing ever
 *     401s because nothing is being requested.
 * Either asks the issuer for a new grant, and never the gateway: the DID the
 * gateway named the account by does not change.
 */

import { BehaviorSubject } from 'rxjs';
import { accessToken as makeAccessToken, RETRY_RULES, serviceAccountToken, SignInError, watched } from '@semiont/core';
import type { AccessToken, ServiceAccountCredential, UserId, Watched } from '@semiont/core';
import { agentToken } from '@semiont/http-transport';
import { parseJwtExpiry, refreshDelayMs } from './storage';

/** The logging surface this module uses, structurally. */
interface SessionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentSessionOptions {
  /** Gateway base URL, e.g. `http://gateway:4000`. */
  baseUrl: string;
  /** The agent's account at the issuer. */
  credential: ServiceAccountCredential;
  logger: SessionLogger;
}

export interface AgentSession {
  /**
   * The agent's DID, as the gateway names its account under the knowledge
   * base's own domain. Carried verbatim: re-derived from the URL the process
   * happens to dial, one agent has two DIDs.
   */
  readonly did: UserId;
  /** The current token, for HttpTransport's `token$`. Only the agent's renewal writes it. */
  readonly token$: Watched<AccessToken | null>;
  /** Ask the issuer for a new token now, and push it. HttpTransport's `tokenRefresher`. */
  refresh(): Promise<string | null>;
  /** Stop the proactive refresh. Call from the shutdown path. */
  stop(): void;
}

/**
 * Sign in as an agent, then keep the token fresh until `stop()`.
 *
 * Throws whatever the sign-in throws on the FIRST attempt: a process that
 * cannot authenticate at startup has nothing useful to do, and failing loudly
 * is what lets its supervisor restart it. Later refreshes only log, because a
 * process holding a still-valid token should not die over one bad round trip.
 */
export async function startAgentSession(opts: AgentSessionOptions): Promise<AgentSession> {
  const { baseUrl, credential, logger } = opts;

  logger.info('Authenticating', { baseUrl, as: credential.clientId });
  // A gateway or an issuer that cannot be reached is tried again, and each wait is logged.
  const first = await agentToken({
    baseUrl,
    credential,
    onRetry: ({ attempt, attempts, delayMs, error }) => {
      logger.warn('Gateway unreachable, retrying authentication', {
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const token$ = new BehaviorSubject<AccessToken | null>(makeAccessToken(first.token));
  logger.info('Authenticated', { did: first.did, expiresAt: parseJwtExpiry(first.token)?.toISOString() ?? null });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /**
   * Re-arm from the token just received rather than on a fixed cadence: the
   * issuer is free to change the lifetime, and the very next token teaches
   * this process the new schedule with no release on this side.
   *
   * A token with no readable `exp` schedules nothing. The floor keeps a token
   * that arrives already near expiry from spinning the loop hot.
   */
  const rearm = (token: string): void => {
    if (stopped) return;
    const delay = refreshDelayMs(token);
    if (delay === null) return;
    timer = setTimeout(() => {
      refresh().catch((error: unknown) => {
        const detail = { error: error instanceof Error ? error.message : String(error) };
        // The issuer's answer is the verdict; its absence never is. A refused
        // credential cannot become valid again, so re-arming against it is an
        // infinite loop that outlives the revocation it should have respected —
        // 47 attempts in ten minutes, measured. An outage is the other case:
        // the token in hand may still be good, and the loop is how it recovers.
        const facts = error instanceof SignInError && error.status !== undefined ? { status: error.status } : {};
        if (!RETRY_RULES.refresh.retryable(facts)) {
          logger.error('Re-authentication refused; not retrying', detail);
          return;
        }
        logger.error('Proactive re-authentication failed', detail);
        rearm(token$.value ?? '');
      });
    }, delay);
    // Do not hold the event loop open on this alone.
    timer.unref?.();
  };

  const refresh = async (): Promise<string | null> => {
    const next = await serviceAccountToken(credential, { renewed: true });
    token$.next(makeAccessToken(next));
    rearm(next);
    return next;
  };

  rearm(first.token);

  return {
    did: first.did,
    token$: watched(token$),
    refresh,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
