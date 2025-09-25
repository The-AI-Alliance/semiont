import { z } from '@hono/zod-openapi';

// Re-export our existing schemas but with OpenAPI metadata
export const StatusResponseSchema = z.object({
  status: z.string().openapi({ example: 'operational' }),
  version: z.string().openapi({ example: '0.1.0' }),
  features: z.object({
    semanticContent: z.string(),
    collaboration: z.string(),
    rbac: z.string(),
  }).openapi({ example: { semanticContent: 'planned', collaboration: 'planned', rbac: 'planned' } }),
  message: z.string().openapi({ example: 'Ready to build the future of knowledge management!' }),
  authenticatedAs: z.string().optional().openapi({ example: 'user@example.com' }),
}).openapi('StatusResponse');

export const HealthResponseSchema = z.object({
  status: z.string().openapi({ example: 'operational' }),
  message: z.string().openapi({ example: 'Semiont API is running' }),
  version: z.string().openapi({ example: '0.1.0' }),
  timestamp: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  database: z.enum(['connected', 'disconnected', 'unknown']).openapi({ example: 'connected' }),
  environment: z.string().openapi({ example: 'development' }),
}).openapi('HealthResponse');

export const GoogleAuthRequestSchema = z.object({
  access_token: z.string().openapi({ 
    example: 'ya29.a0AfH6SMBx...', 
    description: 'Google OAuth access token'
  }),
}).openapi('GoogleAuthRequest');

export const AuthResponseSchema = z.object({
  success: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    isAdmin: z.boolean(),
  }),
  token: z.string().openapi({ description: 'JWT token for API authentication' }),
  isNewUser: z.boolean(),
}).openapi('AuthResponse');

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  domain: z.string(),
  provider: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  termsAcceptedAt: z.string().nullable(),
  lastLogin: z.string().nullable(),
  createdAt: z.string(),
}).openapi('UserResponse');

export const ErrorResponseSchema = z.object({
  error: z.string().openapi({ example: 'An error occurred' }),
  code: z.string().optional().openapi({ example: 'ERROR_CODE' }),
  details: z.any().optional(),
}).openapi('ErrorResponse');

export const UserListResponseSchema = z.object({
  success: z.boolean(),
  users: z.array(z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    domain: z.string(),
    provider: z.string(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    lastLogin: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
}).openapi('UserListResponse');

export const UserStatsResponseSchema = z.object({
  success: z.boolean(),
  stats: z.object({
    totalUsers: z.number(),
    activeUsers: z.number(),
    adminUsers: z.number(),
    regularUsers: z.number(),
    domainBreakdown: z.array(z.object({
      domain: z.string(),
      count: z.number(),
    })),
    recentSignups: z.array(z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      createdAt: z.string(),
    })),
  }),
}).openapi('UserStatsResponse');

export const UpdateUserRequestSchema = z.object({
  isAdmin: z.boolean().optional(),
  isActive: z.boolean().optional(),
  name: z.string().optional(),
}).openapi('UpdateUserRequest');

// Create route definitions for OpenAPI documentation
// Routes are now defined in separate files under src/routes/
// This keeps the route definitions close to their implementations

// Old routes object removed - routes are now defined in:
// - src/routes/health.ts
// - src/routes/auth.ts
// - src/routes/admin.ts
// - src/routes/status.ts

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

