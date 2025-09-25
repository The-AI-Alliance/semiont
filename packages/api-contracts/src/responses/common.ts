/**
 * Common API Response Schemas
 */

import { z } from '@hono/zod-openapi';

// ==========================================
// ERROR RESPONSE SCHEMAS
// ==========================================

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.any().optional(),
}).openapi('ErrorResponse');

export const ValidationErrorResponseSchema = z.object({
  error: z.string(),
  code: z.literal('VALIDATION_ERROR'),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
}).openapi('ValidationErrorResponse');

// ==========================================
// SUCCESS RESPONSE SCHEMAS
// ==========================================

export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
}).openapi('SuccessResponse');

export const DeleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean(),
}).openapi('DeleteResponse');

// ==========================================
// PAGINATION SCHEMAS
// ==========================================

export const PaginationSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
  hasMore: z.boolean().optional(),
}).openapi('Pagination');

// ==========================================
// METADATA SCHEMAS
// ==========================================

export const TimestampsSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('Timestamps');

export const AuditSchema = z.object({
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).openapi('Audit');