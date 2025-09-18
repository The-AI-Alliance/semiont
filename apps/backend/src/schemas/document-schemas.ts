import { z } from '@hono/zod-openapi';

// ==========================================
// SELECTION TYPE SCHEMAS
// ==========================================

export const TextSpanSelectionSchema = z.object({
  type: z.literal('text_span'),
  offset: z.number().int().min(0).openapi({ example: 100, description: 'Character offset in document' }),
  length: z.number().int().min(0).openapi({ example: 20, description: 'Length in characters' }),
  text: z.string().optional().openapi({ example: 'quantum computing', description: 'The actual text (for convenience)' }),
}).openapi('TextSpanSelection');

export const ASTNodeSelectionSchema = z.object({
  type: z.literal('ast_node'),
  language: z.string().openapi({ example: 'typescript', description: 'Programming language' }),
  nodePath: z.array(z.string()).openapi({ example: ['Program', 'FunctionDeclaration', 'Identifier'], description: 'Path through AST to node' }),
  offset: z.number().int().min(0).optional().openapi({ description: 'Offset within node text' }),
  length: z.number().int().min(0).optional().openapi({ description: 'Length within node text' }),
}).openapi('ASTNodeSelection');

export const ImageRegionSelectionSchema = z.object({
  type: z.literal('image_region'),
  shape: z.enum(['rectangle', 'circle', 'polygon']).openapi({ example: 'rectangle' }),
  coordinates: z.array(z.number()).openapi({ example: [10, 20, 100, 150], description: 'Shape-specific coordinates' }),
}).openapi('ImageRegionSelection');

export const AudioSegmentSelectionSchema = z.object({
  type: z.literal('audio_segment'),
  startTime: z.number().min(0).openapi({ example: 1000, description: 'Start time in milliseconds' }),
  duration: z.number().min(0).openapi({ example: 5000, description: 'Duration in milliseconds' }),
}).openapi('AudioSegmentSelection');

export const SelectionTypeSchema = z.discriminatedUnion('type', [
  TextSpanSelectionSchema,
  ASTNodeSelectionSchema,
  ImageRegionSelectionSchema,
  AudioSegmentSelectionSchema,
]).openapi('SelectionType');

// ==========================================
// DOCUMENT SCHEMA
// ==========================================

export const DocumentSchema = z.object({
  id: z.string().openapi({ example: 'doc_abc123' }),
  name: z.string().openapi({ example: 'Introduction to Quantum Computing' }),
  entityTypes: z.array(z.string()).openapi({ example: ['Technology', 'Topic'] }),
  content: z.string().openapi({ example: 'Quantum computing is a revolutionary...' }),
  contentType: z.string().openapi({ example: 'text/plain', description: 'MIME type' }),
  metadata: z.object({}).passthrough().optional(),
  archived: z.boolean().optional().openapi({ example: false, description: 'Whether the document is archived (read-only)' }),
  
  // Provenance tracking
  creationMethod: z.enum(['reference', 'upload', 'ui', 'api']).optional().openapi({ 
    example: 'reference',
    description: 'How the document was created' 
  }),
  contentChecksum: z.string().optional().openapi({ 
    example: 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
    description: 'SHA-256 hash of content' 
  }),
  sourceSelectionId: z.string().optional().openapi({ 
    example: 'sel_xyz789',
    description: 'Selection that triggered creation' 
  }),
  sourceDocumentId: z.string().optional().openapi({ 
    example: 'doc_xyz789',
    description: 'Source document for reference creation' 
  }),
  
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
  createdAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  updatedAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
}).openapi('Document');

// ==========================================
// SELECTION SCHEMA
// ==========================================

export const SelectionSchema = z.object({
  id: z.string().openapi({ example: 'sel_xyz789' }),
  documentId: z.string().openapi({ example: 'doc_abc123' }),
  selectionType: z.string().openapi({ example: 'text_span' }),
  selectionData: z.unknown().openapi({ description: 'Type-specific selection data' }),
  
  // Creation tracking
  createdAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  createdBy: z.string().optional(),
  
  // Reference properties (resolved selection)
  resolvedDocumentId: z.string().optional().openapi({ example: 'doc_def456', description: 'Target document if resolved (reference)' }),
  resolvedAt: z.string().optional().openapi({ example: '2024-01-01T00:00:00.000Z' }),
  resolvedBy: z.string().optional(),
  
  // Reference tags - semantic relationship types
  referenceTags: z.array(z.string()).optional().openapi({ 
    example: ['defines', 'cites'], 
    description: 'Semantic relationship tags (e.g., defines, cites, supports, refutes)' 
  }),
  
  // Entity reference properties
  entityTypes: z.array(z.string()).optional().openapi({ 
    example: ['Person', 'Author'], 
    description: 'Entity types being referenced (entity reference)' 
  }),
  
  provisional: z.boolean().default(false).openapi({ example: false }),
  confidence: z.number().min(0).max(1).optional().openapi({ example: 0.85 }),
  metadata: z.object({}).passthrough().optional(),
  
  updatedAt: z.string().openapi({ example: '2024-01-01T00:00:00.000Z' }),
}).openapi('Selection');

// ==========================================
// REQUEST SCHEMAS
// ==========================================

export const CreateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(255).openapi({ example: 'My Document' }),
  entityTypes: z.array(z.string()).optional().openapi({ example: ['Person', 'Author'] }),
  content: z.string().openapi({ example: 'Document content here...' }),
  contentType: z.string().default('text/plain').openapi({ example: 'text/plain' }),
  metadata: z.object({}).passthrough().optional(),
  
  // Provenance tracking - only optional fields that provide context
  // creationMethod defaults to 'api' on backend, but can be overridden for 'reference', 'upload', 'ui'
  creationMethod: z.enum(['reference', 'upload', 'ui', 'api']).optional().openapi({ 
    example: 'reference',
    description: 'How the document was created (defaults to api)' 
  }),
  sourceSelectionId: z.string().optional().openapi({ 
    example: 'sel_xyz789',
    description: 'Selection that triggered document creation (for reference method)' 
  }),
  sourceDocumentId: z.string().optional().openapi({ 
    example: 'doc_abc123',
    description: 'Source document (for reference method)' 
  }),
  // Note: createdBy, createdAt, and contentChecksum are set by the backend
  
  selections: z.array(z.object({
    selectionType: SelectionTypeSchema,
    resolvedDocumentId: z.string().optional(),
    referenceTags: z.array(z.string()).optional(),
    entityTypes: z.array(z.string()).optional(),
    provisional: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.object({}).passthrough().optional(),
  })).optional().openapi({ description: 'Initial selections within the document' }),
}).openapi('CreateDocumentRequest');

export const UpdateDocumentRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  entityTypes: z.array(z.string()).optional(),
  metadata: z.object({}).passthrough().optional(),
  archived: z.boolean().optional().openapi({ description: 'Whether the document is archived (read-only)' }),
}).openapi('UpdateDocumentRequest');

export const CreateSelectionRequestSchema = z.object({
  documentId: z.string().openapi({ example: 'doc_abc123' }),
  selectionType: SelectionTypeSchema,
  resolvedDocumentId: z.string().nullable().optional().openapi({ description: 'Resolve to document (reference). null for stub reference, string for resolved reference, omit for highlight' }),
  referenceTags: z.array(z.string()).optional().openapi({ 
    example: ['defines', 'mentions'], 
    description: 'Semantic relationship tags' 
  }),
  entityTypes: z.array(z.string()).optional().openapi({ description: 'Entity types being referenced' }),
  metadata: z.object({}).passthrough().optional(),
}).openapi('CreateSelectionRequest');

export const ResolveSelectionRequestSchema = z.object({
  documentId: z.string().openapi({ example: 'doc_def456' }),
  referenceTags: z.array(z.string()).optional().openapi({ 
    example: ['cites', 'supports'], 
    description: 'Semantic relationship tags (e.g., defines, cites, supports, refutes)' 
  }),
  entityTypes: z.array(z.string()).optional().openapi({ 
    example: ['Person'], 
    description: 'Specify which entity types are being referenced' 
  }),
  provisional: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.object({}).passthrough().optional(),
}).openapi('ResolveSelectionRequest');

export const CreateDocumentFromSelectionRequestSchema = z.object({
  name: z.string().min(1).max(255),
  entityTypes: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentType: z.string().default('text/plain'),
  metadata: z.object({}).passthrough().optional(),
}).openapi('CreateDocumentFromSelectionRequest');

export const GenerateDocumentFromSelectionRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  entityTypes: z.array(z.string()).optional(),
  prompt: z.string().optional().openapi({ 
    example: 'Generate a detailed explanation of this concept',
    description: 'Optional prompt for AI generation' 
  }),
}).openapi('GenerateDocumentFromSelectionRequest');

export const DetectSelectionsRequestSchema = z.object({
  entityTypes: z.array(z.string()).openapi({ 
    description: 'Entity types to detect (e.g., Person, Organization, Concept)',
    example: ['Person', 'Organization', 'Concept']
  }),
  confidence: z.number().min(0).max(1).default(0.7).optional().openapi({
    description: 'Minimum confidence threshold for detections',
    example: 0.7
  }),
}).openapi('DetectSelectionsRequest');

// ==========================================
// RESPONSE SCHEMAS
// ==========================================

export const CreateDocumentResponseSchema = z.object({
  document: DocumentSchema,
  selections: z.array(SelectionSchema),
}).openapi('CreateDocumentResponse');

export const GetDocumentResponseSchema = z.object({
  document: DocumentSchema,
  selections: z.array(SelectionSchema),
  highlights: z.array(SelectionSchema).openapi({ description: 'Saved selections' }),
  references: z.array(SelectionSchema).openapi({ description: 'Resolved selections' }),
  entityReferences: z.array(SelectionSchema).openapi({ description: 'Entity references' }),
}).openapi('GetDocumentResponse');

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
}).openapi('ListDocumentsResponse');

export const DetectSelectionsResponseSchema = z.object({
  selections: z.array(SelectionSchema),
  stats: z.object({
    total: z.number(),
    byType: z.object({}).passthrough(),
    averageConfidence: z.number(),
  }),
}).openapi('DetectSelectionsResponse');

export const CreateDocumentFromSelectionResponseSchema = z.object({
  document: DocumentSchema,
  selection: SelectionSchema.openapi({ description: 'Updated selection now resolved to new document' }),
}).openapi('CreateDocumentFromSelectionResponse');

export const GenerateDocumentFromSelectionResponseSchema = z.object({
  document: DocumentSchema,
  selection: SelectionSchema.openapi({ description: 'Updated selection now resolved to generated document' }),
  generated: z.boolean().openapi({ example: true }),
}).openapi('GenerateDocumentFromSelectionResponse');

export const ContextualSummaryResponseSchema = z.object({
  summary: z.string(),
  relevantFields: z.object({}).passthrough(),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
}).openapi('ContextualSummaryResponse');

export const SelectionContextResponseSchema = z.object({
  selection: SelectionSchema,
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
  document: DocumentSchema,
}).openapi('SelectionContextResponse');