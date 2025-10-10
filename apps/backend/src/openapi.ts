import { z } from '@hono/zod-openapi';
import { ErrorResponseSchema as BaseErrorResponseSchema } from '@semiont/core-types';

// Shared error response schema used across all routes
export const ErrorResponseSchema = BaseErrorResponseSchema.extend({
  error: z.string().openapi({ example: 'An error occurred' }),
  code: z.string().optional().openapi({ example: 'ERROR_CODE' }),
}).openapi('ErrorResponse');

// Create route definitions for OpenAPI documentation
// Routes are now defined in separate files under src/routes/
// This keeps the route definitions close to their implementations

// OpenAPI configuration
export const openApiConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Semiont API',
    version: '0.1.0',
    description: 'Semantic Knowledge Platform API'
  },
  servers: [
    {
      url: process.env.API_URL || 'http://localhost:4000',
      description: 'API Server'
    }
  ]
};

