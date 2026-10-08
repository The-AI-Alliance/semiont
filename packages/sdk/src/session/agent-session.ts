/**
 * The token session a long-lived agent holds: a worker, or one of the
 * knowledge base's own services.
 *
 * Every such process signs in the same way (`agentToken`,
 * `@semiont/http-transport`): it proves who the PROCESS is at the trusted
 * issuer with its own service-account credential, exchanges that token at
 * `POST /api/tokens/agent` for an agent token naming a (provider, model)
 * identity, holds it, and keeps it fresh for as long as the process runs.
 *
 * Two identities on purpose. The service account is rotatable on its own and
 * its tokens expire; the agent DID is what events are attributed to. One
 * shared static secret would grant any agent identity to anyone holding it.
 *
 * It is not a `SemiontSession`. A person whose token cannot be renewed is
 * signed out, and signs in again. An agent whose renewal fails keeps the
 * token it has and tries again: a process holding a token that still works
 * does not stop working over one bad round trip.
 *
 * This lives in one place because a copy per process is a copy of the token
 * lifetime — a number the GATEWAY owns. A copy that falls behind the gateway's
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
 * These tokens are gateway-minted and an hour long, but the derivation holds
 * whatever the issuer mints.
 *
 * Two recovery paths:
 *   - `refresh` is handed to HttpTransport as its `tokenRefresher`, which
 *     re-authenticates and retries once when any request answers 401.
 *   - the proactive timer covers the listen-only case, where nothing ever
 *     401s because nothing is being requested.
 */

import { BehaviorSubject } from 'rxjs';
import { accessToken as makeAccessToken, isObject, RETRY_RULES } from '@semiont/core';
import type { AccessToken, ServiceAccountCredential, UserId } from '@semiont/core';
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
  /** This process's own account at the issuer. */
  credential: ServiceAccountCredential;
  /** The agent identity's inference provider, e.g. `ollama`. */
  provider: string;
  /** The agent identity's model, e.g. `gemma3:4b`. */
  model: string;
  logger: SessionLogger;
}

export interface AgentSession {
  /**
   * The agent's DID, as the gateway minted it under the knowledge base's own
   * domain. Carried verbatim: re-derived from the URL the process happens to
   * dial, one agent has two DIDs.
   */
  readonly did: UserId;
  /** The current token, for HttpTransport's `token$`. */
  readonly token$: BehaviorSubject<AccessToken | null>;
  /** Re-authenticate now and push the new token. HttpTransport's `tokenRefresher`. */
  refresh(): Promise<string | null>;
  /** Stop the proactive refresh. Call from the shutdown path. */
  stop(): void;
}

/** One sign-in. A gateway or an issuer that cannot be reached is tried again, and each wait is logged. */
function authenticate(opts: AgentSessionOptions) {
  const { baseUrl, credential, provider, model, logger } = opts;
  return agentToken({
    baseUrl,
    credential,
    provider,
    model,
    onRetry: ({ attempt, attempts, delayMs, error }) => {
      logger.warn('Gateway unreachable, retrying authentication', {
        agent: `${provider}:${model}`,
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
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
  const { logger, provider, model } = opts;

  logger.info('Authenticating', {
    baseUrl: opts.baseUrl,
    agent: `${provider}:${model}`,
    as: opts.credential.clientId,
  });
  const first = await authenticate(opts);
  const token$ = new BehaviorSubject<AccessToken | null>(makeAccessToken(first.token));
  logger.info('Authenticated', { did: first.did, expiresAt: parseJwtExpiry(first.token)?.toISOString() ?? null });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /**
   * Re-arm from the token just received rather than on a fixed cadence: the
   * gateway is free to change the lifetime, and the very next token teaches
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
        // The far end's answer is the verdict; its absence never is. A refused
        // credential cannot become valid again, so re-arming against it is an
        // infinite loop that outlives the revocation it should have respected —
        // 47 attempts in ten minutes, measured. An outage is the other case:
        // the token in hand may still be good, and the loop is how it recovers.
        // The status is read off the error structurally, as core's retry rules
        // read it: a refusal is whatever carries one.
        const status = isObject(error) && typeof error['status'] === 'number' ? error['status'] : undefined;
        if (!RETRY_RULES.refresh.retryable(status === undefined ? {} : { status })) {
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
    const next = await authenticate(opts);
    token$.next(makeAccessToken(next.token));
    rearm(next.token);
    return next.token;
  };

  rearm(first.token);

  return {
    did: first.did,
    token$,
    refresh,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
