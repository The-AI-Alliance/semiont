/**
 * `APIError` — the transport's HTTP failure, carrying the status it came from.
 *
 * Lives in its own module rather than in `http-transport.ts` because
 * `actor-state-unit.ts` throws it too (a refused emit carries its status) and
 * `http-transport.ts` imports `actor-state-unit.ts` — so the obvious home is a
 * cycle. The alternative, a second status-bearing error class beside this one,
 * is a duplicated shape, and one decision lives in one place: there would then
 * be two answers to "how does an HTTP failure carry its status", and the retry
 * predicate could only agree with one of them.
 */

import { SemiontError, isObject, isString, retryAfterMs, transportErrorCodeForStatus, type TransportErrorCode, type HttpStatusError } from '@semiont/core';

export class APIError extends SemiontError {
  declare code: TransportErrorCode;
  readonly status: number;
  readonly statusText: string;

  readonly retryAfterMs: number | undefined;

  private constructor(
    message: string,
    code: TransportErrorCode,
    status: number,
    statusText: string,
    body: unknown,
    retryAfterMs: number | undefined,
  ) {
    super(message, code, { status, statusText, body });
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.retryAfterMs = retryAfterMs;
  }

  /** The server answered, and its status decides the code. */
  static fromStatus(
    message: string,
    status: number,
    statusText: string,
    body: unknown,
    retryAfterMs: number | undefined,
  ): APIError {
    return new APIError(message, transportErrorCodeForStatus(status), status, statusText, body, retryAfterMs);
  }

  /**
   * The gateway's refusal, as every request of this package reports one: in
   * the gateway's own words when its body states them (`ErrorResponse.error`),
   * with the body as it came, and with the wait its `Retry-After` states.
   */
  static refusal(status: number, statusText: string, body: unknown, retryAfter: string | null): APIError {
    const said = isObject(body) && isString(body['error']) ? body['error'] : undefined;
    return APIError.fromStatus(said ?? `HTTP ${status}: ${statusText}`, status, statusText, body, retryAfterMs(retryAfter));
  }

  /**
   * The exchange ended with no response: the connection failed, or the
   * request's deadline passed. There is no status to decide a code, and the
   * vocabulary files a request that got no answer under `unavailable`.
   * `statusText` names which ending it was.
   */
  static withoutResponse(message: string, statusText: string): APIError {
    return new APIError(message, 'unavailable', 0, statusText, undefined, undefined);
  }
}

/**
 * The contract between this class and core's `isRetryableRequestError`, asserted
 * at compile time: the predicate classifies a request error by its status, and
 * this class is what carries one.
 *
 * Core cannot name `APIError` — http-transport depends on core, not the reverse —
 * so the predicate reads the `status` field structurally. Without this line that
 * agreement is a coincidence: rename `status` here and every 429 silently stops
 * being retryable, with no test failing, because a predicate that finds no status
 * simply answers `false`. **A silent loss of retry is exactly how a projector
 * dies of a retryable error**, so it is pinned by the compiler rather than by
 * a test.
 */
const _conformsToRetryContract: HttpStatusError = APIError.fromStatus('', 0, '', undefined, undefined);
void _conformsToRetryContract;
