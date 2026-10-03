/**
 * `APIError` — the transport's HTTP failure, carrying the status it came from.
 *
 * Lives in its own module rather than in `http-transport.ts` because
 * `actor-state-unit.ts` throws it too (SIDECAR-BOOT-RESILIENCE P2) and
 * `http-transport.ts` imports `actor-state-unit.ts` — so the obvious home is a
 * cycle. The alternative, a second status-bearing error class beside this one,
 * is the duplicated shape the house rules forbid: there would then be two
 * answers to "how does an HTTP failure carry its status", and the retry
 * predicate could only agree with one of them.
 */

import { SemiontError, isObject, isString, retryAfterMs, transportErrorCodeForStatus, type TransportErrorCode, type TransportFailure, type HttpStatusError } from '@semiont/core';

export class APIError extends SemiontError {
  declare code: TransportErrorCode;
  readonly status: number;
  readonly statusText: string;

  readonly retryAfterMs: number | undefined;

  /**
   * The gateway's own words (`ErrorResponse.error`), when its body stated
   * them; null when it did not, or when what answered was not the gateway's
   * error body. Kept apart from `message`, which falls back to the status
   * line: a host that shows a person what the gateway said must never show
   * them a sentence the transport made up.
   */
  readonly said: string | null;

  private constructor(
    message: string,
    code: TransportErrorCode,
    status: number,
    statusText: string,
    body: unknown,
    retryAfterMs: number | undefined,
    said: string | null,
  ) {
    super(message, code, { status, statusText, body });
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.retryAfterMs = retryAfterMs;
    this.said = said;
  }

  /** The server answered, and its status decides the code. */
  static fromStatus(
    message: string,
    status: number,
    statusText: string,
    body: unknown,
    retryAfterMs: number | undefined,
  ): APIError {
    return new APIError(message, transportErrorCodeForStatus(status), status, statusText, body, retryAfterMs, null);
  }

  /**
   * The gateway's refusal, as every request of this package reports one: in
   * the gateway's own words when its body states them (`ErrorResponse.error`),
   * with the body as it came, and with the wait its `Retry-After` states.
   */
  static refusal(status: number, statusText: string, body: unknown, retryAfter: string | null): APIError {
    const said = isObject(body) && isString(body['error']) ? body['error'] : null;
    return new APIError(
      said ?? `HTTP ${status}: ${statusText}`,
      transportErrorCodeForStatus(status),
      status,
      statusText,
      body,
      retryAfterMs(retryAfter),
      said,
    );
  }

  /**
   * The exchange ended with no response: the connection failed, or the
   * request's deadline passed. There is no status to decide a code, and the
   * vocabulary files a request that got no answer under `unavailable`.
   * `statusText` names which ending it was.
   */
  static withoutResponse(message: string, statusText: string): APIError {
    return new APIError(message, 'unavailable', 0, statusText, undefined, undefined, null);
  }
}

/**
 * The contract between this class and core's `isRetryableRequestError`, asserted
 * at compile time (SIDECAR-BOOT-RESILIENCE P1/P2).
 *
 * Core cannot name `APIError` — http-transport depends on core, not the reverse —
 * so the predicate reads the `status` field structurally. Without this line that
 * agreement is a coincidence: rename `status` here and every 429 silently stops
 * being retryable, with no test failing, because a predicate that finds no status
 * simply answers `false`. **A silent loss of retry is exactly the failure this
 * plan exists to prevent**, so it is pinned by the compiler rather than by a test.
 */
const _conformsToRetryContract: HttpStatusError = APIError.fromStatus('', 0, '', undefined, undefined);
void _conformsToRetryContract;

/**
 * The same agreement with `ITransport.errors$`: what this class publishes is
 * what the routing layer reads, `code` and `said`, checked by the compiler. A
 * renamed `said` would otherwise leave every refusal's detail null, silently.
 */
const _conformsToTransportFailure: TransportFailure = APIError.fromStatus('', 0, '', undefined, undefined);
void _conformsToTransportFailure;
