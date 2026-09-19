/**
 * The agent token session a long-lived sidecar holds.
 *
 * Every sidecar in this package authenticates the same way: prove who the
 * PROCESS is at the trusted issuer with its own service-account credential,
 * exchange that token at `POST /api/tokens/agent` for an agent token naming a
 * (provider, model) identity, hold it, and keep it fresh for as long as the
 * process runs.
 *
 * Two identities on purpose. The service account is rotatable on its own and
 * its tokens expire; the agent DID is what events are attributed to. They used
 * to be one shared static secret that granted any agent identity to anyone
 * holding it.
 *
 * This lives in one place because it was four byte-identical copies, which
 * meant four copies of the token lifetime — a number the GATEWAY owns, written
 * as `12 * 60 * 60 * 1000`, "half the TTL". When the gateway's lifetime
 * changed, the copies did not, and the listen-only path (SSE, which reads
 * `token$` on reconnect rather than driving a request that could 401) would
 * have gone quiet with nothing in the logs.
 *
 * So the lifetime is not restated here. When a token expires is that token's
 * own `exp` claim, and how long before expiry to renew is `REFRESH_BEFORE_EXP_MS`
 * — the same two facts `SemiontSession` schedules from for human and worker
 * sessions. One refresh policy, read from the credential itself.
 *
 * Two recovery paths, unchanged from the copies this replaces:
 *   - `refresh` is handed to HttpTransport as its `tokenRefresher`, which
 *     re-authenticates and retries once when any request answers 401.
 *   - the proactive timer covers the listen-only case, where nothing ever
 *     401s because nothing is being requested.
 */

import { BehaviorSubject } from 'rxjs';
import {
  accessToken as makeAccessToken,
  retryWithBackoff,
  isTransientFetchError,
  serviceAccountToken,
  STARTUP_FETCH_RETRY,
} from '@semiont/core';
import type { ServiceAccountCredential } from '@semiont/core';
import type { AccessToken } from '@semiont/core';
import { parseJwtExpiry, REFRESH_BEFORE_EXP_MS } from '@semiont/sdk';

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
  /** The agent identity's inference provider, e.g. `semiont`. */
  provider: string;
  /** The agent identity's model, e.g. `weaver`. */
  model: string;
  logger: SessionLogger;
}

export interface AgentSession {
  /** The current token, for HttpTransport's `token$`. */
  readonly token$: BehaviorSubject<AccessToken | null>;
  /** Re-authenticate now and push the new token. HttpTransport's `tokenRefresher`. */
  refresh(): Promise<string | null>;
  /** Stop the proactive refresh. Call from the shutdown path. */
  stop(): void;
}

/**
 * One authentication round trip.
 *
 * Connection-level failures are retried with backoff: the gateway may be
 * mid-restart or the container network still warming up when a sidecar starts,
 * and orchestration runs these with `--rm` and no restart policy, so exiting on
 * the first failed fetch is permanent death. HTTP-level rejections (a refused
 * credential) are NOT retried; the far end is up and said no.
 */
async function authenticate(opts: AgentSessionOptions): Promise<string> {
  const { baseUrl, credential, provider, model, logger } = opts;

  return retryWithBackoff(
    async () => {
      // Both round trips sit inside the retry: the issuer and the gateway come
      // up independently of this process, and either being slow to boot is the
      // transient case this exists for.
      const caller = await serviceAccountToken(credential);

      const response = await fetch(`${baseUrl}/api/tokens/agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${caller}`,
        },
        body: JSON.stringify({ provider, model }),
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const { token } = await response.json() as { token: string; did: string };
      return token;
    },
    isTransientFetchError,
    STARTUP_FETCH_RETRY,
    ({ attempt, attempts, delayMs, error }) => {
      logger.warn('Gateway unreachable, retrying authentication', {
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/**
 * Authenticate, then keep the token fresh until `stop()`.
 *
 * Throws whatever `authenticate` throws on the FIRST attempt: a sidecar that
 * cannot authenticate at startup has nothing useful to do, and failing loudly
 * is what lets the supervisor restart it. Later refreshes only log, because a
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
  const token$ = new BehaviorSubject<AccessToken | null>(makeAccessToken(first));
  logger.info('Authenticated', { expiresAt: parseJwtExpiry(first)?.toISOString() ?? null });

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
    const expiresAt = parseJwtExpiry(token);
    if (!expiresAt) return;
    const delay = Math.max(1_000, expiresAt.getTime() - REFRESH_BEFORE_EXP_MS - Date.now());
    timer = setTimeout(() => {
      refresh().catch((error) => {
        logger.error('Proactive re-authentication failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Keep trying against the token in hand; it may still be valid.
        rearm(token$.value ?? '');
      });
    }, delay);
    // Do not hold the event loop open on this alone.
    timer.unref?.();
  };

  const refresh = async (): Promise<string | null> => {
    const next = await authenticate(opts);
    token$.next(makeAccessToken(next));
    rearm(next);
    return next;
  };

  rearm(first);

  return {
    token$,
    refresh,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
