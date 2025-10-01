import { z } from 'zod';

// Reusable schema definitions that match our actual data structures
// These are used instead of importing from @semiont/api-contracts to avoid TypeScript hanging

export const DocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  metadata: z.record(z.string(), z.any()),
  archived: z.boolean(),
  entityTypes: z.array(z.string()),
  creationMethod: z.string(),
  sourceSelectionId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  content: z.string().optional(),
});

export const SelectionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  selectionType: z.enum(['highlight', 'reference']),
  selectionData: z.record(z.string(), z.any()),
  entityTypes: z.array(z.string()).optional(),
  resolvedDocumentId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
});

// Request schemas
export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(500),
  content: z.string(),
  contentType: z.string().optional().default('text/plain'),
  entityTypes: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.any()).optional().default({}),
  sourceSelectionId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
});

// Update schema - only allows append-only operations
// Document name and content are immutable after creation
export const UpdateDocumentRequestSchema = z.object({
  entityTypes: z.array(z.string()).optional(), // Can add entity types
  metadata: z.record(z.string(), z.any()).optional(), // Can add metadata
  archived: z.boolean().optional(), // Can archive (one-way operation)
});

// Response schemas
export const CreateDocumentResponseSchema = z.object({
  document: DocumentSchema,
  selections: z.array(SelectionSchema),
});

export const GetDocumentResponseSchema = z.object({
  document: DocumentSchema.extend({ content: z.string() }),
  selections: z.array(SelectionSchema),
  highlights: z.array(SelectionSchema),
  references: z.array(SelectionSchema),
  entityReferences: z.array(SelectionSchema),
});

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});