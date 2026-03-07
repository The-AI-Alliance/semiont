// Create route definitions for OpenAPI resourceation
// Routes are now defined in separate files under src/routes/
// This keeps the route definitions close to their implementations

/**
 * Generate OpenAPI configuration with dynamic backend URL
 * @param backendUrl - Backend public URL from config
 */
export function createOpenApiConfig(backendUrl: string) {
  if (!backendUrl) {
    throw new Error('backendUrl is required for OpenAPI configuration');
  }

  return {
    openapi: '3.0.0',
    info: {
      title: 'Semiont API',
      version: '0.1.0',
      description: 'Semantic Knowledge Platform API'
    },
    servers: [
      {
        url: backendUrl,
        description: 'API Server'
      }
    ]
  };
}

