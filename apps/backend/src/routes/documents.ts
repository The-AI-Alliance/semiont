import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { authMiddleware } from '../middleware/auth';
import { User } from '@prisma/client';
import { ErrorResponseSchema } from '../openapi';
import {
  DocumentSchema,
  CreateDocumentRequestSchema,
  CreateDocumentResponseSchema,
  GetDocumentResponseSchema,
  ListDocumentsResponseSchema,
  UpdateDocumentRequestSchema,
  DetectSelectionsRequestSchema,
  DetectSelectionsResponseSchema,
} from '../schemas/document-schemas';
import { getGraphDatabase } from '../graph/factory';
import { getStorageService } from '../storage/filesystem';
import type { Document, Selection } from '../graph/types';

// Create documents router
export const documentsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to all document routes
documentsRouter.use('/api/documents/*', authMiddleware);

// ==========================================
// CREATE DOCUMENT
// ==========================================

const createDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents',
  summary: 'Create Document',
  description: 'Create a new document with optional initial selections',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentResponseSchema,
        },
      },
      description: 'Document created successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Invalid request',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(createDocumentRoute, async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  try {
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    // Create document in graph database
    const document = await graphDb.createDocument({
      name: body.name,
      entityTypes: body.entityTypes || [],
      content: body.content,
      contentType: body.contentType || 'text/plain',
      metadata: body.metadata || {},
      createdBy: user.id,
    });

    // Save content to filesystem
    const storageUrl = await storage.saveDocument(document.id, body.content);
    
    // Update document with storage URL
    const updatedDocument = await graphDb.updateDocument(document.id, {
      metadata: { ...document.metadata, storageUrl },
      updatedBy: user.id,
    });

    // Create initial selections if provided
    const selections: Selection[] = [];
    if (body.selections && body.selections.length > 0) {
      for (const selData of body.selections) {
        const selInput: any = {
          documentId: document.id,
          selectionType: selData.selectionType.type,
          selectionData: selData.selectionType,
          saved: selData.saved || false,
          provisional: selData.provisional || false,
        };
        if (selData.saved) selInput.savedBy = user.id;
        if (selData.resolvedDocumentId) {
          selInput.resolvedDocumentId = selData.resolvedDocumentId;
          selInput.resolvedBy = user.id;
        }
        if (selData.referenceTags) selInput.referenceTags = selData.referenceTags;
        if (selData.entityTypes) selInput.entityTypes = selData.entityTypes;
        if (selData.confidence !== undefined) selInput.confidence = selData.confidence;
        if (selData.metadata) selInput.metadata = selData.metadata;
        const selection = await graphDb.createSelection(selInput);
        selections.push(selection);
      }
    }

    return c.json({
      document: formatDocument(updatedDocument),
      selections: selections.map(formatSelection),
    }, 201);
  } catch (error) {
    console.error('Error creating document:', error);
    return c.json({ error: 'Failed to create document' }, 500);
  }
});

// ==========================================
// GET DOCUMENT
// ==========================================

const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Retrieve a document by ID with its selections',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document retrieved successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(getDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const graphDb = await getGraphDatabase();
  const document = await graphDb.getDocument(id);

  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  const selections = await graphDb.getDocumentSelections(id);
  const highlights = await graphDb.getHighlights(id);
  const references = await graphDb.getReferences(id);
  const entityReferences = await graphDb.getEntityReferences(id);
  // const referencedBy = await graphDb.getDocumentReferencedBy(id);

  return c.json({
    document: formatDocument(document),
    selections: selections.map(formatSelection),
    highlights: highlights.map(formatSelection),
    references: references.map(formatSelection),
    entityReferences: entityReferences.map(formatSelection),
  }, 200);
});

// ==========================================
// LIST DOCUMENTS
// ==========================================

const listDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents',
  summary: 'List Documents',
  description: 'List and search documents',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      entityTypes: z.string().optional().openapi({ example: 'Person,Author' }),
      search: z.string().optional().openapi({ example: 'quantum' }),
      limit: z.string().optional().default('20').openapi({ example: '20' }),
      offset: z.string().optional().default('0').openapi({ example: '0' }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Documents retrieved successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(listDocumentsRoute, async (c) => {
  const query = c.req.valid('query');
  const limit = parseInt(query.limit);
  const offset = parseInt(query.offset);

  const graphDb = await getGraphDatabase();

  // Build filter for graph database
  const filter: any = {
    limit,
    offset,
  };
  if (query.entityTypes) filter.entityTypes = query.entityTypes.split(',').map(t => t.trim());
  if (query.search) filter.search = query.search;

  const result = await graphDb.listDocuments(filter);

  return c.json({
    documents: result.documents.map(formatDocument),
    total: result.total,
    offset: offset,
    limit: limit,
  }, 200);
});

// ==========================================
// UPDATE DOCUMENT
// ==========================================

const updateDocumentRoute = createRoute({
  method: 'put',
  path: '/api/documents/{id}',
  summary: 'Update Document',
  description: 'Update document metadata (not content)',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateDocumentRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DocumentSchema,
        },
      },
      description: 'Document updated successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(updateDocumentRoute, async (c) => {
  const user = c.get('user');
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const graphDb = await getGraphDatabase();
  const updateInput: any = {
    updatedBy: user.id,
  };
  if (body.name !== undefined) updateInput.name = body.name;
  if (body.entityTypes !== undefined) updateInput.entityTypes = body.entityTypes;
  if (body.metadata !== undefined) updateInput.metadata = body.metadata;
  
  const document = await graphDb.updateDocument(id, updateInput);

  return c.json(formatDocument(document), 200);
});

// ==========================================
// DELETE DOCUMENT
// ==========================================

const deleteDocumentRoute = createRoute({
  method: 'delete',
  path: '/api/documents/{id}',
  summary: 'Delete Document',
  description: 'Delete a document and all its selections',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
  },
  responses: {
    204: {
      description: 'Document deleted successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(deleteDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Delete from graph database (will also delete references)
  await graphDb.deleteDocument(id);

  // Delete from storage
  await storage.deleteDocument(id);

  return c.body(null, 204);
});

// ==========================================
// DETECT SELECTIONS
// ==========================================

const detectSelectionsRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-selections',
  summary: 'Detect Selections',
  description: 'Trigger AI-based selection detection for a document',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: DetectSelectionsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DetectSelectionsResponseSchema,
        },
      },
      description: 'Selections detected successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Document not found',
    },
    401: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Unauthorized',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(detectSelectionsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');

  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  const document = await graphDb.getDocument(id);

  if (!document) {
    return c.json({ error: 'Document not found' }, 404);
  }

  // Get document content from storage
  const content = await storage.getDocument(id);
  const contentStr = content.toString('utf-8');

  // Stub implementation - in real implementation, this would:
  // 1. Use NLP/ML to detect selections in the document
  // 2. Find potential resolutions from existing documents
  // 3. Return detected selections with confidence scores

  const detectedSelections = await detectSelectionsInDocument(
    { ...document, content: contentStr },
    (body as any).types || ['entities', 'concepts'],
    (body as any).confidence || 0.7
  );

  return c.json({
    selections: detectedSelections,
    stats: {
      total: detectedSelections.length,
      byType: {},
      averageConfidence: 0.5,
    },
  }, 200);
});

// ==========================================
// GRAPH SCHEMA DESCRIPTION
// ==========================================

const describeGraphSchemaRoute = createRoute({
  method: 'get',
  path: '/api/documents/schema-description',
  summary: 'Describe Graph Schema',
  description: 'Get a natural language description of the document graph schema and statistics',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            description: z.string(),
            statistics: z.object({
              documentCount: z.number(),
              selectionCount: z.number(),
              highlightCount: z.number(),
              referenceCount: z.number(),
              entityTypes: z.record(z.number()),
            }),
            entityTypeDescriptions: z.array(z.object({
              type: z.string(),
              count: z.number(),
              description: z.string(),
            })),
          }),
        },
      },
      description: 'Schema description retrieved successfully',
    },
    500: {
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
      description: 'Internal server error',
    },
  },
});

documentsRouter.openapi(describeGraphSchemaRoute, async (c) => {
  try {
    const graphDb = await getGraphDatabase();
    
    // Get statistics from the graph database
    const stats = await graphDb.getStats();
    const entityStats = await graphDb.getEntityTypeStats();
    
    // Generate natural language description
    const description = generateSchemaDescription(stats, entityStats);
    
    // Generate entity type descriptions
    const entityTypeDescriptions = entityStats.map(stat => ({
      type: stat.type,
      count: stat.count,
      description: describeEntityType(stat.type, stat.count),
    }));
    
    return c.json({
      description,
      statistics: {
        documentCount: stats.documentCount,
        selectionCount: stats.selectionCount,
        highlightCount: stats.highlightCount,
        referenceCount: stats.referenceCount,
        entityTypes: stats.entityTypes,
      },
      entityTypeDescriptions,
    }, 200);
  } catch (error) {
    console.error('Error describing graph schema:', error);
    return c.json({ error: 'Failed to describe graph schema' }, 500);
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function formatDocument(doc: Document): any {
  return {
    id: doc.id,
    name: doc.name,
    entityTypes: doc.entityTypes,
    contentType: doc.contentType,
    metadata: doc.metadata,
    storageUrl: doc.storageUrl,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
}

function formatSelection(sel: Selection): any {
  return {
    id: sel.id,
    documentId: sel.documentId,
    selectionType: sel.selectionType,
    selectionData: sel.selectionData,
    saved: sel.saved,
    savedAt: sel.savedAt instanceof Date ? sel.savedAt.toISOString() : sel.savedAt,
    savedBy: sel.savedBy,
    resolvedDocumentId: sel.resolvedDocumentId,
    resolvedAt: sel.resolvedAt instanceof Date ? sel.resolvedAt.toISOString() : sel.resolvedAt,
    resolvedBy: sel.resolvedBy,
    referenceTags: sel.referenceTags,
    entityTypes: sel.entityTypes,
    provisional: sel.provisional,
    confidence: sel.confidence,
    metadata: sel.metadata,
    createdAt: sel.createdAt instanceof Date ? sel.createdAt.toISOString() : sel.createdAt,
    updatedAt: sel.updatedAt instanceof Date ? sel.updatedAt.toISOString() : sel.updatedAt,
  };
}


// Dummy implementation for detecting selections in document
async function detectSelectionsInDocument(
  document: any,
  _types: string[],
  _confidence: number
): Promise<any[]> {
  // Dummy implementation that detects:
  // 1. [[wiki-style]] references
  // 2. "lorem ipsum" (case insensitive)
  // 3. "John Doe" (case insensitive)

  const detectedSelections = [];

  // Only process text content
  if (document.contentType === 'text/plain' || document.contentType === 'text/markdown') {
    const content = document.content;
    
    // Pattern 1: Detect [[wiki-style]] references
    const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
    let match;
    
    while ((match = wikiLinkPattern.exec(content)) !== null) {
      const selectionText = match[1];
      const offset = match.index;
      const length = match[0].length;

      const selection = {
        selection: {
          id: `sel_wiki_${Math.random().toString(36).substring(2, 11)}`,
          documentId: document.id,
          selectionType: 'text_span',
          selectionData: {
            type: 'text_span',
            offset,
            length,
            text: selectionText,
          },
          saved: false,
          provisional: true,
          confidence: 0.9,
          metadata: {
            detectionType: 'wiki_link',
            pattern: '[[...]]'
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        suggestedResolutions: [
          {
            documentId: 'doc_suggested_' + Math.random().toString(36).substring(2, 11),
            documentName: selectionText,
            entityTypes: ['Topic'],
            confidence: 0.75,
            reason: 'Wiki-style link detected',
          }
        ],
      };
      detectedSelections.push(selection);
    }

    // Pattern 2: Detect "lorem ipsum" (case insensitive)
    const loremPattern = /lorem\s+ipsum/gi;
    while ((match = loremPattern.exec(content)) !== null) {
      const offset = match.index;
      const length = match[0].length;
      const text = match[0];

      const selection = {
        selection: {
          id: `sel_lorem_${Math.random().toString(36).substring(2, 11)}`,
          documentId: document.id,
          selectionType: 'text_span',
          selectionData: {
            type: 'text_span',
            offset,
            length,
            text,
          },
          saved: false,
          provisional: true,
          confidence: 1.0,
          entityTypes: ['Placeholder'],
          metadata: {
            detectionType: 'dummy_text',
            pattern: 'lorem ipsum'
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        suggestedResolutions: [
          {
            documentId: 'doc_placeholder_text',
            documentName: 'Placeholder Text',
            entityTypes: ['Placeholder', 'Template'],
            confidence: 1.0,
            reason: 'Lorem ipsum placeholder text detected',
          }
        ],
      };
      detectedSelections.push(selection);
    }

    // Pattern 3: Detect "John Doe" (case insensitive)
    const johnDoePattern = /john\s+doe/gi;
    while ((match = johnDoePattern.exec(content)) !== null) {
      const offset = match.index;
      const length = match[0].length;
      const text = match[0];

      const selection = {
        selection: {
          id: `sel_person_${Math.random().toString(36).substring(2, 11)}`,
          documentId: document.id,
          selectionType: 'text_span',
          selectionData: {
            type: 'text_span',
            offset,
            length,
            text,
          },
          saved: false,
          provisional: true,
          confidence: 0.95,
          entityTypes: ['Person'],
          metadata: {
            detectionType: 'named_entity',
            pattern: 'john doe',
            entityType: 'person'
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        suggestedResolutions: [
          {
            documentId: 'doc_person_johndoe',
            documentName: 'John Doe (Example Person)',
            entityTypes: ['Person', 'Example'],
            confidence: 0.95,
            reason: 'Common placeholder name detected',
          }
        ],
      };
      detectedSelections.push(selection);
    }
  }

  return detectedSelections;
}

// Generate natural language description of the graph schema
function generateSchemaDescription(
  stats: {
    documentCount: number;
    selectionCount: number;
    highlightCount: number;
    referenceCount: number;
    entityReferenceCount: number;
    entityTypes: Record<string, number>;
    contentTypes: Record<string, number>;
  },
  entityStats: Array<{ type: string; count: number }>
): string {
  const lines: string[] = [];
  
  // Overview
  lines.push(`The knowledge graph currently contains ${stats.documentCount} document${stats.documentCount !== 1 ? 's' : ''}.`);
  
  // Document types
  if (Object.keys(stats.contentTypes).length > 0) {
    const contentTypeList = Object.entries(stats.contentTypes)
      .map(([type, count]) => `${count} ${type}`)
      .join(', ');
    lines.push(`Document formats include: ${contentTypeList}.`);
  }
  
  // Selections
  if (stats.selectionCount > 0) {
    lines.push(`\nThere are ${stats.selectionCount} total selection${stats.selectionCount !== 1 ? 's' : ''} in the system:`);
    
    if (stats.highlightCount > 0) {
      lines.push(`- ${stats.highlightCount} saved highlight${stats.highlightCount !== 1 ? 's' : ''} (important text marked for later reference)`);
    }
    
    if (stats.referenceCount > 0) {
      lines.push(`- ${stats.referenceCount} resolved reference${stats.referenceCount !== 1 ? 's' : ''} (text linked to specific documents)`);
    }
    
    const provisionalCount = stats.selectionCount - stats.highlightCount - stats.referenceCount;
    if (provisionalCount > 0) {
      lines.push(`- ${provisionalCount} provisional selection${provisionalCount !== 1 ? 's' : ''} (detected but not yet confirmed)`);
    }
  } else {
    lines.push(`\nNo selections have been made yet. Selections allow you to highlight important text, create references between documents, and build connections in your knowledge graph.`);
  }
  
  // Entity types
  if (entityStats.length > 0) {
    lines.push(`\nThe graph organizes content using ${entityStats.length} entity type${entityStats.length !== 1 ? 's' : ''}:`);
    
    // Sort by count descending
    const sortedTypes = [...entityStats].sort((a, b) => b.count - a.count);
    const topTypes = sortedTypes.slice(0, 5);
    
    topTypes.forEach(stat => {
      const percentage = stats.documentCount > 0 
        ? Math.round((stat.count / stats.documentCount) * 100)
        : 0;
      lines.push(`- ${stat.type}: ${stat.count} document${stat.count !== 1 ? 's' : ''} (${percentage}%)`);
    });
    
    if (sortedTypes.length > 5) {
      lines.push(`- ... and ${sortedTypes.length - 5} more type${sortedTypes.length - 5 !== 1 ? 's' : ''}`);
    }
  } else {
    lines.push(`\nNo entity types have been defined yet. Entity types help categorize and organize documents (e.g., Person, Topic, Concept, etc.).`);
  }
  
  // Relationships
  if (stats.referenceCount > 0) {
    lines.push(`\nThe graph contains ${stats.referenceCount} connection${stats.referenceCount !== 1 ? 's' : ''} between documents through resolved references, creating a web of related information.`);
  }
  
  // Summary
  lines.push(`\nThis structure allows for semantic navigation, where you can traverse from one concept to related concepts through selections and references.`);
  
  return lines.join('\n');
}

// Describe what an entity type represents
function describeEntityType(entityType: string, count: number): string {
  // Common entity type descriptions
  const descriptions: Record<string, string> = {
    'Person': 'Represents individuals, including authors, historical figures, or any named person referenced in documents.',
    'Topic': 'Represents subject areas, themes, or general topics of discussion.',
    'Concept': 'Represents abstract ideas, theories, or conceptual frameworks.',
    'Place': 'Represents geographical locations, from specific addresses to countries or regions.',
    'Organization': 'Represents companies, institutions, groups, or any organized body.',
    'Event': 'Represents historical events, meetings, conferences, or any time-bound occurrence.',
    'Technology': 'Represents tools, software, hardware, or technological concepts.',
    'Product': 'Represents physical or digital products, services, or offerings.',
    'Author': 'Represents content creators, writers, or contributors to documents.',
    'Reference': 'Represents bibliographic references, citations, or source materials.',
    'Definition': 'Represents formal definitions or explanations of terms.',
    'Example': 'Represents illustrative examples or case studies.',
    'Placeholder': 'Represents template content or placeholder text (like Lorem ipsum).',
    'Template': 'Represents document templates or reusable content structures.',
  };
  
  const baseDescription = descriptions[entityType] || 
    `Represents ${entityType.toLowerCase()} entities within the knowledge graph.`;
  
  const countInfo = count === 1 
    ? 'Currently 1 document of this type.'
    : `Currently ${count} documents of this type.`;
  
  return `${baseDescription} ${countInfo}`;
}