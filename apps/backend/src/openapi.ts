import { ErrorResponseSchemaOpenAPI as ErrorResponseSchema } from '@semiont/sdk';

// Shared error response schema used across all routes (imported from SDK)
export { ErrorResponseSchema };

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
      url: process.env.BACKEND_URL || 'http://localhost:4000',
      description: 'API Server'
    }
  ]
};

