/**
 * The unified Semiont error hierarchy.
 *
 * `SemiontError` is the base every other Semiont error class extends:
 * `APIError` (http-transport), `BusRequestError` (here, in `bus-request.ts`)
 * and `SemiontSessionError` (sdk). Subclasses tighten the `code` field to a
 * literal-union for discriminated handling.
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
