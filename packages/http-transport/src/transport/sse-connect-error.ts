import { SemiontError, type HttpStatusError } from '@semiont/core';

/**
 * A refused SSE connect — `POST /bus/subscribe` answered non-2xx (or 2xx
 * with no body). The status is CARRIED, not interpolated into the message:
 * P3's backoff/terminal split reads it (auth-refused is terminal in kind;
 * 5xx is transient), and it surfaces on `ActorStateUnit.errors$` so a
 * refused client is observable instead of a silent retry loop
 * (SSE-AUTH-RESILIENCE P2, shape B).
 *
 * Extends `SemiontError` (core) rather than reusing `APIError`: APIError
 * lives in http-transport.ts, which imports the actor — reaching for it
 * there would buy one inherited field with an import cycle.
 *
 * Its OWN module, not `actor-state-unit.ts`, because `*-state-unit.ts` files
 * carry no class declarations: state units are plain-object factories, and
 * `audit-state-unit-no-class.sh` is the static half of the A1 axiom whose
 * allowlist is deliberately empty. An error type is not state-unit
 * machinery, so it moves rather than earning that gate its first exception.
 * A leaf module importing only core also keeps the cycle shut.
 */
export class SseConnectError extends SemiontError implements HttpStatusError {
  readonly status: number;
  /** The wait the refusal's `Retry-After` stated: the reconnect waits at least this long. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, retryAfterMs: number | undefined) {
    super(`SSE connect failed: ${status}`, 'SSE_CONNECT_FAILED', { status });
    this.name = 'SseConnectError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
