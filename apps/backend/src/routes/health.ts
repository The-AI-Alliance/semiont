import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { HealthResponseSchema } from '../openapi';
import { DatabaseConnection } from '../db';
import { HealthResponse } from '../types/api';

// Define the health check route
export const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  summary: 'Health Check',
  description: 'Check if the API is operational and database is connected',
  tags: ['System'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
      description: 'Health status of the API',
    },
  },
});

// Create health router
export const healthRouter = new OpenAPIHono();

healthRouter.openapi(healthRoute, async (c) => {
  // Check if startup script had issues (for internal monitoring)
  let startupFailed = false;
  try {
    const fs = await import('fs');
    if (fs.existsSync('/tmp/startup_status')) {
      const startupStatus = fs.readFileSync('/tmp/startup_status', 'utf-8').trim();
      if (startupStatus.startsWith('FAILED')) {
        startupFailed = true;
        // Log internally but don't expose details
        console.error('Startup script failure detected:', startupStatus);
      }
    }
  } catch (e) {
    // Ignore file read errors
  }

  if (startupFailed) {
    // Return unhealthy but don't expose internal details
    return c.json<HealthResponse>({ 
      status: 'offline',
      message: 'Service is experiencing issues',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      database: 'unknown',
      environment: process.env.NODE_ENV || 'development',
    }, 503);
  }

  const dbStatus = await DatabaseConnection.checkHealth();
  
  return c.json<HealthResponse>({
    status: 'operational',
    message: 'Semiont API is running',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    database: dbStatus ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development',
  });
});