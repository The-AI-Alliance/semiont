/**
 * Common error classes
 */

/**
 * Base error class for Semiont applications
 */
export class SemiontError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'SemiontError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends SemiontError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown by scripts
 */
export class ScriptError extends SemiontError {
  constructor(message: string, code: string = 'SCRIPT_ERROR', details?: Record<string, any>) {
    super(message, code, details);
    this.name = 'ScriptError';
  }
}

/**
 * Error thrown when a resource is not found
 */
export class NotFoundError extends SemiontError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, 'NOT_FOUND', { resource, id });
    this.name = 'NotFoundError';
  }
}

/**
 * Error thrown when user is not authorized
 */
export class UnauthorizedError extends SemiontError {
  constructor(message: string = 'Unauthorized', details?: Record<string, any>) {
    super(message, 'UNAUTHORIZED', details);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Error thrown when operation would conflict with existing data
 */
export class ConflictError extends SemiontError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CONFLICT', details);
    this.name = 'ConflictError';
  }
}