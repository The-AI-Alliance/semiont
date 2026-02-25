/**
 * Health Check Route - Spec-First Version
 *
 * This is a proof of concept demonstrating the new spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No Zod schemas (GET endpoint has no request body)
 * - Types come from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { Hono } from 'hono';
import { DatabaseConnection } from '../db';
import type { components } from '@semiont/core';
import { getLogger } from '../logger';

const logger = getLogger().child({ component: 'health' });

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

  // Check if startup script had issues (for internal monitoring)
  let startupFailed = false;
  try {
    const fs = await import('fs');
    if (fs.existsSync('/tmp/startup_status')) {
      const startupStatus = fs.readFileSync('/tmp/startup_status', 'utf-8').trim();
      if (startupStatus.startsWith('FAILED')) {
        startupFailed = true;
        // Log internally but don't expose details
        logger.error('Startup script failure detected', { startupStatus });
      }
    }
  } catch (e) {
    // Ignore file read errors
  }

  if (startupFailed) {
    // Return unhealthy but don't expose internal details
    const response: HealthResponse = {
      status: 'offline',
      message: 'Service is experiencing issues',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      database: 'unknown',
      environment: nodeEnv,
    };
    return c.json(response, 200);  // Always return 200 for health checks (ALB requirement)
  }

  const dbStatus = await DatabaseConnection.checkHealth();

  const response: HealthResponse = {
    status: 'operational',
    message: 'Semiont API is running',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    database: dbStatus ? 'connected' : 'disconnected',
    environment: nodeEnv,
  };

  return c.json(response, 200);
});
