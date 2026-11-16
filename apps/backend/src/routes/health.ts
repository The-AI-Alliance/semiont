/**
 * Health Check Route
 *
 * Plain Hono, no Zod schemas (a GET with no request body), response type
 * generated from the OpenAPI spec.
 */

import { Hono } from 'hono';
import { DatabaseConnection } from '../db';
import type { components } from '@semiont/core';

type HealthResponse = components['schemas']['HealthResponse'];

// Create health router with plain Hono
export const healthRouter = new Hono();

/**
 * GET /api/health
 *
 * Health check endpoint - no validation needed (no request body)
 * Response type comes from OpenAPI spec via generated types
 */
healthRouter.get('/api/health', async (c) => {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv) {
    throw new Error('NODE_ENV environment variable is required');
  }

  const dbStatus = await DatabaseConnection.checkHealth();

  const response: HealthResponse = {
    status: 'operational',
    message: 'Semiont API is running',
    version: __SEMIONT_VERSION__,
    timestamp: new Date().toISOString(),
    database: dbStatus ? 'connected' : 'disconnected',
    environment: nodeEnv,
  };

  return c.json(response, 200);
});
