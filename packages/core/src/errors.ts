/**
 * Common error classes — the unified Semiont error hierarchy.
 *
 * `SemiontError` is the base every other Semiont error class extends:
 * `APIError` (api-client), `BusRequestError` and `SemiontSessionError` (sdk),
 * `ValidationError`, `ScriptError`, `NotFoundError`, `UnauthorizedError`,
 * `ConflictError` (here), and `AWSError` (cli). Subclasses tighten the
 * `code` field to a literal-union for discriminated handling.
 */

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
