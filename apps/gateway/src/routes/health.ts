/**
 * Health Check Route
 *
 * Plain Hono, no Zod schemas (a GET with no request body), response type
 * generated from the OpenAPI spec.
 */

import { Hono, type Context } from 'hono';
import type { components } from '@semiont/core';

type HealthResponse = components['schemas']['HealthResponse'];

// Create health router with plain Hono
export const healthRouter = new Hono();

/**
 * Health check - no validation needed (no request body).
 * Response type comes from OpenAPI spec via generated types.
 */
async function health(c: Context) {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv) {
    throw new Error('NODE_ENV environment variable is required');
  }

  const response: HealthResponse = {
    status: 'operational',
    message: 'Semiont API is running',
    version: __SEMIONT_VERSION__,
    timestamp: new Date().toISOString(),
    environment: nodeEnv,
  };

  return c.json(response, 200);
}

healthRouter.get('/api/health', health);

// `/` is where a person who typed this host lands. One handler, so the two
// can never disagree: a bare 404 there reads as "the gateway is down".
healthRouter.get('/', health);
