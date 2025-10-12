import { z } from 'zod';

/**
 * Status Response - returned by /api/status
 */
export const StatusResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
  features: z.object({
    semanticContent: z.string(),
    collaboration: z.string(),
    rbac: z.string(),
  }),
  message: z.string(),
  authenticatedAs: z.string().optional(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/**
 * Health Response - returned by /api/health
 */
export const HealthResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  version: z.string(),
  timestamp: z.string(),
  database: z.enum(['connected', 'disconnected', 'unknown']),
  environment: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Error Response - standard error format
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.any().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
