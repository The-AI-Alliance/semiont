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

import { SemiontError, transportErrorCodeForStatus, type TransportErrorCode, type HttpStatusError } from '@semiont/core';

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
   * The exchange ended with no response. XHR reports status 0 for every such
   * ending and no code maps from 0, so the caller states the code: it knows
   * which ending this was, and a failed network and a cancelled upload share
   * a status and nothing else.
   */
  static withoutResponse(message: string, code: TransportErrorCode, statusText: string): APIError {
    return new APIError(message, code, 0, statusText, undefined, undefined);
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
