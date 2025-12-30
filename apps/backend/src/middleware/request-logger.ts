/**
 * Request Logger Middleware
 *
 * Logs incoming requests and outgoing responses with timing information.
 * Helps debug request flow and identify slow endpoints.
 */

import { Context, Next } from 'hono';

/**
 * Request logger middleware
 *
 * Logs:
 * - Incoming requests (method, path, query params, user agent)
 * - Outgoing responses (status code, timing)
 *
 * Uses the request-scoped logger from context (set by requestIdMiddleware).
 *
 * @example
 * ```typescript
 * app.use('*', requestIdMiddleware);
 * app.use('*', requestLoggerMiddleware);
 * ```
 */
export const requestLoggerMiddleware = async (c: Context, next: Next) => {
  const logger = c.get('logger');
  const startTime = Date.now();

  const method = c.req.method;
  const path = c.req.path;
  const query = c.req.query();
  const userAgent = c.req.header('User-Agent') || 'unknown';

  // Log incoming request
  logger.http('Incoming request', {
    type: 'request_incoming',
    method,
    path,
    query: Object.keys(query).length > 0 ? query : undefined,
    userAgent
  });

  // Process request
  await next();

  // Log outgoing response
  const duration = Date.now() - startTime;
  const status = c.res.status;

  logger.http('Outgoing response', {
    type: 'request_outgoing',
    method,
    path,
    status,
    duration,
    durationMs: duration
  });
};
