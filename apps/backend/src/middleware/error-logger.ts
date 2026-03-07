/**
 * Error Logger Middleware
 *
 * Catches unhandled errors and logs them with full stack traces.
 * Should be one of the last middleware in the chain.
 */

import { Context, Next } from 'hono';

/**
 * Error logger middleware
 *
 * Catches any errors thrown during request processing and logs them.
 * Ensures errors are logged with full context before returning error responses.
 *
 * IMPORTANT: This should be added BEFORE route handlers but AFTER
 * requestIdMiddleware so errors have the request ID for correlation.
 *
 * @example
 * ```typescript
 * app.use('*', requestIdMiddleware);
 * app.use('*', errorLoggerMiddleware);
 * app.use('*', requestLoggerMiddleware);
 * // ... route handlers
 * ```
 */
export const errorLoggerMiddleware = async (c: Context, next: Next) => {
  try {
    await next();
  } catch (error) {
    const logger = c.get('logger');

    // Log the error with full context
    logger.error('Unhandled error during request processing', {
      type: 'unhandled_error',
      method: c.req.method,
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined
    });

    // Re-throw to let Hono's error handler deal with it
    throw error;
  }
};
