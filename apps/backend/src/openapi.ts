import { ErrorResponseSchema } from '@semiont/sdk';

// Shared error response schema used across all routes (imported from SDK)
export { ErrorResponseSchema };

// Create route definitions for OpenAPI documentation
// Routes are now defined in separate files under src/routes/
// This keeps the route definitions close to their implementations

// OpenAPI configuration
const BACKEND_URL = process.env.BACKEND_URL;
if (!BACKEND_URL) {
  throw new Error('BACKEND_URL environment variable is required for OpenAPI configuration');
}

export const openApiConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Semiont API',
    version: '0.1.0',
    description: 'Semantic Knowledge Platform API'
  },
  servers: [
    {
      url: BACKEND_URL,
      description: 'API Server'
    }
  ]
};

