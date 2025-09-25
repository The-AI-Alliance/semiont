/**
 * Document API Request Schemas
 */

import { z } from '@hono/zod-openapi';

// ==========================================
// DOCUMENT REQUEST SCHEMAS
// ==========================================

export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  contentType: z.string(),
  entityTypes: z.array(z.string()),
  metadata: z.record(z.string(), z.any()).optional(),
}).openapi('CreateDocumentRequest');

export const UpdateDocumentRequestSchema = z.object({
  archived: z.boolean().optional(),
}).openapi('UpdateDocumentRequest');

export const ListDocumentsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).optional().transform(val => val ? parseInt(val, 10) : 50),
  offset: z.string().regex(/^\d+$/).optional().transform(val => val ? parseInt(val, 10) : 0),
  search: z.string().optional(),
  entityTypes: z.string().optional(),
}).openapi('ListDocumentsQuery');

export const DetectSelectionsRequestSchema = z.object({
  confidence: z.number().min(0).max(1).optional().default(0.7),
  entityTypes: z.array(z.string()).optional(),
}).openapi('DetectSelectionsRequest');

export const DiscoverContextRequestSchema = z.object({
  content: z.string().min(1),
}).openapi('DiscoverContextRequest');