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

import { SemiontError, isObject, isRetryableRequestError, isString, retryAfterMs, transportErrorCodeForStatus, whyUnanswered, type TransportErrorCode, type HttpStatusError, type components } from '@semiont/core';

/**
 * The limit that answers only a request whose token has already failed
 * verification: it says what a 401 says.
 */
const REFUSAL_RATE = 'refusal-rate' satisfies components['schemas']['LimitRefusal']['code'];

/**
 * Whether a refusal refuses the request's credential: a 401, or a 429 whose
 * body is a `LimitRefusal` naming `refusal-rate`
 * (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential). Such a
 * request is renewed or fails, and is never retried with the token refused.
 */
export function refusesCredential(status: number, body: unknown): boolean {
  return status === 401 || (status === 429 && isObject(body) && body['code'] === REFUSAL_RATE);
}

/**
 * A refused response's body as the gateway wrote it: parsed when it is JSON,
 * its text when it is not, and none when it is empty.
 */
export function refusalBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** What a refused response's body says when it is an `ErrorResponse`: its `error`. */
export function gatewayWords(body: unknown): string | undefined {
  return isObject(body) && isString(body['error']) ? body['error'] : undefined;
}

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

  /**
   * The server answered, and its status decides the code, but for a refused
   * credential (`refusesCredential`), which is `unauthorized` whatever its
   * status. So `code === 'unauthorized'` is what says a credential was
   * refused, and the paths that renew one read it there.
   */
  static fromStatus(
    message: string,
    status: number,
    statusText: string,
    body: unknown,
    retryAfterMs: number | undefined,
  ): APIError {
    const code = refusesCredential(status, body) ? 'unauthorized' : transportErrorCodeForStatus(status);
    return new APIError(message, code, status, statusText, body, retryAfterMs);
  }

  /**
   * The gateway's refusal, as every request of this package reports one: in
   * the gateway's own words when its body states them (`ErrorResponse.error`),
   * with the body as it came, and with the wait its `Retry-After` states.
   */
  static refusal(status: number, statusText: string, body: unknown, retryAfter: string | null): APIError {
    return APIError.fromStatus(gatewayWords(body) ?? `HTTP ${status}: ${statusText}`, status, statusText, body, retryAfterMs(retryAfter));
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

  /**
   * The request `what` names got no answer, and `error` is what the runtime
   * rejected with, or threw, in place of one. The runtime quotes the request
   * in its words, the token it carries and the address it goes to: the
   * failure says the kind of error it was, and none of those words
   * (`whyUnanswered`).
   */
  static unanswered(what: string, error: unknown): APIError {
    return APIError.withoutResponse(`${what} got no answer: ${whyUnanswered(error)}`, error instanceof Error ? error.name : 'Error');
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

/**
 * Whether a failed request is worth another attempt by core's rule, with one
 * exception the rule cannot see: a refused credential, which is renewed or
 * final and never sent again with the token refused, whatever its status.
 */
export function retryableUnlessRefused(error: unknown): boolean {
  return !(error instanceof APIError && error.code === 'unauthorized') && isRetryableRequestError(error);
}
