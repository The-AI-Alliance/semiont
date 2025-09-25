/**
 * Selection API Request Schemas
 */

import { z } from '@hono/zod-openapi';

// ==========================================
// SELECTION TYPE SCHEMAS
// ==========================================

export const TextSpanSelectionSchema = z.object({
  type: z.literal('text_span'),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
  text: z.string().optional(),
}).openapi('TextSpanSelection');

export const ASTNodeSelectionSchema = z.object({
  type: z.literal('ast_node'),
  language: z.string(),
  nodePath: z.array(z.string()),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(0).optional(),
}).openapi('ASTNodeSelection');

export const ImageRegionSelectionSchema = z.object({
  type: z.literal('image_region'),
  shape: z.enum(['rectangle', 'circle', 'polygon']),
  coordinates: z.array(z.number()),
}).openapi('ImageRegionSelection');

export const AudioSegmentSelectionSchema = z.object({
  type: z.literal('audio_segment'),
  startTime: z.number().min(0),
  duration: z.number().min(0),
}).openapi('AudioSegmentSelection');

export const SelectionTypeSchema = z.discriminatedUnion('type', [
  TextSpanSelectionSchema,
  ASTNodeSelectionSchema,
  ImageRegionSelectionSchema,
  AudioSegmentSelectionSchema,
]).openapi('SelectionType');

// ==========================================
// SELECTION REQUEST SCHEMAS
// ==========================================

export const CreateSelectionRequestSchema = z.object({
  documentId: z.string(),
  selectionType: z.string(),
  selectionData: SelectionTypeSchema,
  provisional: z.boolean().optional().default(false),
  confidence: z.number().min(0).max(1).optional(),
  resolvedDocumentId: z.string().nullable().optional(),
  referenceTags: z.array(z.string()).optional(),
  entityTypes: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).openapi('CreateSelectionRequest');

export const ResolveSelectionRequestSchema = z.object({
  documentId: z.string(),
  referenceTags: z.array(z.string()).optional(),
  entityTypes: z.array(z.string()).optional(),
  provisional: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).openapi('ResolveSelectionRequest');

export const CreateDocumentFromSelectionRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  contentType: z.string(),
  entityTypes: z.array(z.string()),
  metadata: z.record(z.string(), z.any()).optional(),
}).openapi('CreateDocumentFromSelectionRequest');

export const GenerateDocumentFromSelectionRequestSchema = z.object({
  topic: z.string().min(1),
  style: z.enum(['technical', 'educational', 'research', 'summary']).optional().default('educational'),
  maxLength: z.number().min(100).max(10000).optional().default(2000),
}).openapi('GenerateDocumentFromSelectionRequest');