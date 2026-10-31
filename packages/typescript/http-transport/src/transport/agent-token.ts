/**
 * An agent's sign-in at a knowledge base's gateway.
 *
 * An agent is an account, as a person is. It signs in at the knowledge
 * base's issuer with its own service-account credential
 * (`serviceAccountToken`), and the token its issuer grants is its bearer at
 * the gateway. The gateway names it by that account: its DID, which the
 * gateway answers at `GET /api/users/me`, is who its work is attributed to.
 * The engine it runs is no part of it: each write names that itself.
 *
 * The DID is the gateway's, under the knowledge base's own domain, and a
 * caller carries it verbatim. Re-derived from the URL the process happens to
 * dial, one agent has two DIDs.
 *
 * The token is renewed by a new grant at the issuer, as it expires and when
 * the gateway refuses it. Its DID does not change, so nothing renewed asks
 * the gateway again.
 */

import {
  HTTP_REQUEST_TIMEOUT_MS,
  STARTUP_FETCH_RETRY,
  UnansweredError,
  isObject,
  isString,
  jsonOf,
  retryAfterMs,
  retryWithBackoff,
  serviceAccountToken,
  userId,
  type RetryAttemptInfo,
  type ServiceAccountCredential,
  type UserId,
} from '@semiont/core';
import { APIError, retryableUnlessRefused } from './api-error';
import { fetchOf } from './fetch-of';

export interface AgentSignIn {
  /** The gateway, e.g. `http://gateway:4000`: where the process dials, and nothing about who it is. */
  baseUrl: string;
  /** The agent's account at the knowledge base's issuer. */
  credential: ServiceAccountCredential;
  /** Told before each wait for a gateway or an issuer that could not be reached. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** What the issuer's requests and the gateway's are sent with. Absent, the runtime's own `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Sign the agent in as its account: the account's token, and the DID the
 * gateway names it by.
 *
 * Each request is bounded by `httpRequestTimeoutMs`
 * (specs/src/client/timing.json). A sign-in is tried again with backoff
 * (`STARTUP_FETCH_RETRY`) when the gateway or the issuer could not be
 * reached, did not answer by that deadline, or said "not now" (the statuses
 * of `RETRY_RULES.boot`): either may be starting when this process does, and
 * a process run with no restart policy that gave up on its first attempt
 * would never come back. Any other refusal is not asked again: the far end is
 * up and said no. The gateway's is thrown as an `APIError` carrying its
 * status, the issuer's as a `SignInError`.
 */
export async function agentToken(opts: AgentSignIn): Promise<{ token: string; did: UserId }> {
  const { baseUrl, credential, onRetry, fetch } = opts;

  return retryWithBackoff(
    async () => {
      // Both steps sit inside the retry: the issuer and the gateway come up
      // independently of this process, and of each other.
      const token = await serviceAccountToken(credential, { renewed: false, ...(fetch ? { fetch } : {}) });
      return { token, did: await named(baseUrl, token, fetch) };
    },
    // A request that got no answer, its deadline passing among the ways it
    // gets none, and a status that says "not now": a sign-in against a
    // gateway that accepts a connection and never answers is tried again. A
    // refused token is not: the same token gets the same answer.
    retryableUnlessRefused,
    STARTUP_FETCH_RETRY,
    onRetry,
  );
}

/** The DID the gateway names the bearer of `token` by: `GET /api/users/me`. */
async function named(baseUrl: string, token: string, fetch: typeof globalThis.fetch | undefined): Promise<UserId> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/users/me`;
  const unanswered = (error: unknown) => new UnansweredError(url, error);
  const response = await fetchOf(fetch)(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw unanswered(error);
  });
  const answer = await jsonOf(response, unanswered);

  if (!response.ok) {
    const said = isObject(answer) && isString(answer['error']) ? answer['error'] : `HTTP ${response.status} ${response.statusText}`;
    throw APIError.fromStatus(
      `The gateway did not name the agent: ${said}`,
      response.status,
      response.statusText,
      answer,
      retryAfterMs(response.headers.get('retry-after')),
    );
  }
  if (!isObject(answer) || !isString(answer['did'])) {
    throw new Error(`${url} did not answer a DID`);
  }
  return userId(answer['did']);
}
