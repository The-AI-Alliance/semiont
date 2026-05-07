/**
 * Common error classes — the unified Semiont error hierarchy.
 *
 * `SemiontError` is the base every other Semiont error class extends:
 * `APIError` (api-client), `BusRequestError` and `SemiontSessionError` (sdk),
 * `ValidationError`, `ScriptError`, `NotFoundError`, `UnauthorizedError`,
 * `ConflictError` (here), and `AWSError` (cli). Subclasses tighten the
 * `code` field to a literal-union for discriminated handling.
 */

/**
 * Transport-neutral error vocabulary. Every transport that surfaces
 * errors over `ITransport.errors$` maps its native failure modes to one
 * of these codes — HTTP `APIError` maps from status code, in-process
 * transports map from local failure shape, gRPC would map from status
 * code, etc. Routing layers (e.g. `SemiontBrowser`'s session-expired /
 * permission-denied modal routing) match on this vocabulary so they
 * stay transport-agnostic.
 *
 *  - `unauthorized` — auth required / token missing or expired (HTTP 401)
 *  - `forbidden`    — auth ok but lacks permission (HTTP 403)
 *  - `not-found`    — resource missing (HTTP 404)
 *  - `conflict`     — concurrent modification, duplicate, etc. (HTTP 409)
 *  - `bad-request`  — request malformed (HTTP 400)
 *  - `unavailable`  — backend unreachable, network error, 5xx
 *  - `error`        — unclassified fallback
 */
export type TransportErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'bad-request'
  | 'unavailable'
  | 'error';

export class SemiontError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SemiontError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends SemiontError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class ScriptError extends SemiontError {
  constructor(message: string, code: string = 'SCRIPT_ERROR', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'ScriptError';
  }
}

export class NotFoundError extends SemiontError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 'NOT_FOUND', { resource, id });
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends SemiontError {
  constructor(message: string = 'Unauthorized', details?: Record<string, unknown>) {
    super(message, 'UNAUTHORIZED', details);
    this.name = 'UnauthorizedError';
  }
}

export class ConflictError extends SemiontError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', details);
    this.name = 'ConflictError';
  }
}
