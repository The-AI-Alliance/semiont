/**
 * Request ID Middleware
 *
 * Generates a unique ID for each request and attaches it to the context.
 * Also creates a request-scoped logger with the request ID for correlation.
 */

import { Context, Next } from 'hono';
import { randomUUID } from 'crypto';
import { createChildLogger } from '../logger';
import type winston from 'winston';

/**
 * Extended Hono Variables to include requestId and logger
 */
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: winston.Logger;
  }
}

/**
 * Request ID middleware
 *
 * Generates a unique request ID and creates a request-scoped logger.
 * The request ID is included in all logs from this request.
 *
 * @example
 * ```typescript
 * app.use('*', requestIdMiddleware);
 *
 * // Later in a route handler:
 * const logger = c.get('logger');
 * logger.info('Processing request'); // Includes requestId automatically
 * ```
 */
export const requestIdMiddleware = async (c: Context, next: Next) => {
  // Generate unique request ID
  const requestId = randomUUID();

  // Create request-scoped logger with request ID
  const logger = createChildLogger({ requestId });

  // Attach to context
  c.set('requestId', requestId);
  c.set('logger', logger);

  // Add request ID to response headers for debugging
  c.header('X-Request-ID', requestId);

  await next();
};
