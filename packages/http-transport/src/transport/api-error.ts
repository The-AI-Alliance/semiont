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

import { SemiontError, type TransportErrorCode, type HttpStatusError } from '@semiont/core';

function classifyApiCode(status: number): TransportErrorCode {
  if (status === 400) return 'bad-request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'unavailable';
  return 'error';
}

export class APIError extends SemiontError {
  declare code: TransportErrorCode;
  readonly status: number;
  readonly statusText: string;

  constructor(message: string, status: number, statusText: string, body?: unknown) {
    super(message, classifyApiCode(status), { status, statusText, body });
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
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
const _conformsToRetryContract: HttpStatusError = new APIError('', 0, '');
void _conformsToRetryContract;
