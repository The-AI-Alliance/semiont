/**
 * An agent's sign-in at a knowledge base's gateway.
 *
 * A process that works as an agent has two identities, obtained in two
 * steps. It proves who IT is at the knowledge base's issuer, with its own
 * service-account credential (`serviceAccountToken`), and exchanges that
 * token at `POST /api/tokens/agent` for the token of the software agent
 * `(provider, model)`: the identity its work is attributed to. One process
 * may hold several agents, one for each model it works with, which is why
 * the two are separate exchanges.
 *
 * The DID is minted by the gateway, under the knowledge base's own domain,
 * and a caller carries it verbatim. Re-derived from the URL the process
 * happens to dial, one agent has two DIDs.
 *
 * An agent token has no refresh token. It is renewed by signing in again.
 */

import {
  HTTP_REQUEST_TIMEOUT_MS,
  STARTUP_FETCH_RETRY,
  isObject,
  isRetryableRequestError,
  isString,
  retryWithBackoff,
  serviceAccountToken,
  userId,
  type RetryAttemptInfo,
  type ServiceAccountCredential,
  type components,
} from '@semiont/core';
import { APIError } from './api-error';

export interface AgentSignIn {
  /** The gateway, e.g. `http://gateway:4000`: where the process dials, and nothing about who it is. */
  baseUrl: string;
  /** The process's own account at the knowledge base's issuer. */
  credential: ServiceAccountCredential;
  /** The agent's inference provider, e.g. `ollama`. */
  provider: string;
  /** The agent's model, e.g. `gemma3:4b`. */
  model: string;
  /** Told before each wait for a gateway or an issuer that could not be reached. */
  onRetry?: (info: RetryAttemptInfo) => void;
}

/**
 * Sign in as the agent `(provider, model)`: the agent's token, and the DID
 * the gateway minted for it.
 *
 * Each request is bounded by `httpRequestTimeoutMs`
 * (specs/src/client/timing.json). A sign-in is tried again with backoff
 * (`STARTUP_FETCH_RETRY`) when the gateway or the issuer could not be
 * reached, did not answer by that deadline, or said "not now" (the statuses
 * of `RETRY_RULES.boot`): either may be starting when this process does, and
 * a process run with no restart policy that gave up on its first attempt
 * would never come back. Any other refusal is not asked again, and is thrown
 * as an `APIError` carrying its status: the far end is up and said no.
 */
export async function agentToken(opts: AgentSignIn): Promise<components['schemas']['AgentTokenResponse']> {
  const { baseUrl, credential, provider, model, onRetry } = opts;
  const request: components['schemas']['AgentTokenRequest'] = { provider, model };

  return retryWithBackoff(
    async () => {
      // Both steps sit inside the retry: the issuer and the gateway come up
      // independently of this process, and of each other.
      const caller = await serviceAccountToken(credential);

      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tokens/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${caller}` },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
      });
      const answer: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const said = isObject(answer) && isString(answer['error']) ? answer['error'] : `HTTP ${response.status} ${response.statusText}`;
        throw APIError.fromStatus(
          `The gateway refused the agent token of ${provider}:${model}: ${said}`,
          response.status,
          response.statusText,
          answer,
          undefined,
        );
      }
      if (!isObject(answer) || !isString(answer['token']) || !isString(answer['did'])) {
        throw new Error(`The gateway answered the sign-in of ${provider}:${model} with no token or no DID`);
      }
      return { token: answer['token'], did: userId(answer['did']) };
    },
    // Not `isTransientFetchError` alone: a request that bounds itself is
    // rejected with a `TimeoutError` when the bound fires, which that
    // predicate cannot see, and a sign-in against a gateway that accepts a
    // connection and never answers would not be tried again.
    isRetryableRequestError,
    STARTUP_FETCH_RETRY,
    onRetry,
  );
}
