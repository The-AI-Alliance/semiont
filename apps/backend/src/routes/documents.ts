import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { User } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { 
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
import type { Document, Selection, UpdateDocumentInput } from '../graph/types';
import { calculateChecksum } from '../utils/checksum';

// Create documents router
export const documentsRouter = new OpenAPIHono<{ Variables: { user: User } }>();

// Apply auth middleware to all document routes
documentsRouter.use('/api/documents/*', authMiddleware);

// CREATE
const createDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents',
  summary: 'Create Document',
  description: 'Create a new document',
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
  },
});
documentsRouter.openapi(createDocumentRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const checksum = calculateChecksum(body.content);
  const document: Document = {
    id: `doc_${Math.random().toString(36).substring(2, 11)}`,
    name: body.name,
    archived: false,
    contentType: body.contentType || 'text/plain',
    metadata: body.metadata || {},
    entityTypes: [],
    
    // Creation context
    creationMethod: (body.creationMethod || 'api') as 'api' | 'reference' | 'upload' | 'ui',
    sourceSelectionId: body.sourceSelectionId || undefined,
    sourceDocumentId: body.sourceDocumentId || undefined,
    contentChecksum: checksum,
    
    createdBy: user.id,
    updatedBy: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  const createInput: any = {
    name: document.name,
    entityTypes: document.entityTypes,
    content: body.content,
    contentType: document.contentType,
    metadata: document.metadata,
    createdBy: document.createdBy,
    creationMethod: document.creationMethod || 'api',
  };
  if (document.sourceSelectionId) createInput.sourceSelectionId = document.sourceSelectionId;
  if (document.sourceDocumentId) createInput.sourceDocumentId = document.sourceDocumentId;
  if (document.contentChecksum) createInput.contentChecksum = document.contentChecksum;
  
  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));
  
  // Get selections
  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);
  
  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});

// GET
const getDocumentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}',
  summary: 'Get Document',
  description: 'Get a document by ID',
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
  },
});
documentsRouter.openapi(getDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  // Get content from storage
  const content = await storage.getDocument(id);
  
  // Get selections
  const highlights = await graphDb.getHighlights(id);
  const references = await graphDb.getReferences(id);
  const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);
  
  return c.json({
    document: {
      ...formatDocument(document),
      content: content.toString('utf-8')
    },
    selections: [...highlights, ...references].map(formatSelection),
    highlights: highlights.map(formatSelection),
    references: references.map(formatSelection),
    entityReferences: entityReferences.map(formatSelection),
  });
});

// LIST
const listDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents',
  summary: 'List Documents',
  description: 'List all documents with optional filters',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      offset: z.coerce.number().default(0),
      limit: z.coerce.number().default(50),
      entityType: z.string().optional(),
      archived: z.coerce.boolean().optional(),
      search: z.string().optional(), // Add search parameter for text search
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Documents listed successfully',
    },
  },
});
documentsRouter.openapi(listDocumentsRoute, async (c) => {
  const { offset, limit, entityType, archived, search } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const allDocs = await graphDb.listDocuments({});
  
  // Apply filters
  let filteredDocs = allDocs.documents;
  
  // Apply search filter if provided
  if (search) {
    const searchLower = search.toLowerCase();
    filteredDocs = filteredDocs.filter(doc => 
      doc.name.toLowerCase().includes(searchLower)
    );
  }
  
  if (entityType) {
    filteredDocs = filteredDocs.filter(doc => doc.entityTypes?.includes(entityType));
  }
  if (archived !== undefined) {
    filteredDocs = filteredDocs.filter(doc => doc.archived === archived);
  }
  
  // Paginate
  const paginatedDocs = filteredDocs.slice(offset, offset + limit);
  
  // For search results, load content snippets
  let documentsWithContent = paginatedDocs;
  if (search) {
    documentsWithContent = await Promise.all(
      paginatedDocs.map(async (doc) => {
        try {
          const contentBuffer = await storage.getDocument(doc.id);
          const contentStr = contentBuffer.toString('utf-8');
          return { ...doc, content: contentStr.slice(0, 200) }; // Include first 200 chars as preview
        } catch {
          return { ...doc, content: '' }; // Return empty content if load fails
        }
      })
    );
  }
  
  return c.json({
    documents: documentsWithContent.map(formatDocument),
    total: filteredDocs.length,
    offset,
    limit,
  });
});

// SEARCH
const searchDocumentsRoute = createRoute({
  method: 'get',
  path: '/api/documents/search',
  summary: 'Search Documents',
  description: 'Search documents by name',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().min(1),
      limit: z.coerce.number().default(10),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ListDocumentsResponseSchema,
        },
      },
      description: 'Search results',
    },
  },
});
documentsRouter.openapi(searchDocumentsRoute, async (c) => {
  const { q, limit } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  
  const allDocs = await graphDb.listDocuments({});
  
  // Simple case-insensitive search in document names
  const query = q.toLowerCase();
  const matchingDocs = allDocs.documents
    .filter((doc: Document) => doc.name.toLowerCase().includes(query))
    .slice(0, limit);
  
  return c.json({
    documents: matchingDocs.map(formatDocument),
    total: matchingDocs.length,
    offset: 0,
    limit,
  });
});

// UPDATE
const updateDocumentRoute = createRoute({
  method: 'put',
  path: '/api/documents/{id}',
  summary: 'Update Document',
  description: 'Update document metadata',
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
          schema: GetDocumentResponseSchema,
        },
      },
      description: 'Document updated successfully',
    },
  },
});
documentsRouter.openapi(updateDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  const updateData: UpdateDocumentInput = {
    updatedBy: user.id
  };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.entityTypes !== undefined) updateData.entityTypes = body.entityTypes;
  if (body.metadata !== undefined) updateData.metadata = body.metadata;
  if (body.archived !== undefined) updateData.archived = body.archived;
  
  const updatedDoc = await graphDb.updateDocument(id, updateData);
  
  // Get content from storage
  const content = await storage.getDocument(id);
  
  // Get selections
  const highlights = await graphDb.getHighlights(id);
  const references = await graphDb.getReferences(id);
  const entityReferences = references.filter(ref => ref.entityTypes && ref.entityTypes.length > 0);
  
  return c.json({
    document: {
      ...formatDocument(updatedDoc),
      content: content.toString('utf-8')
    },
    selections: [...highlights, ...references].map(formatSelection),
    highlights: highlights.map(formatSelection),
    references: references.map(formatSelection),
    entityReferences: entityReferences.map(formatSelection),
  });
});

// DELETE
const deleteDocumentRoute = createRoute({
  method: 'delete',
  path: '/api/documents/{id}',
  summary: 'Delete Document',
  description: 'Delete a document',
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
  },
});
documentsRouter.openapi(deleteDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  await graphDb.deleteDocument(id);
  await storage.deleteDocument(id);
  
  return c.body(null, 204);
});

// GET CONTENT
const getDocumentContentRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/content',
  summary: 'Get Document Content',
  description: 'Get the content of a document',
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
        'text/plain': {
          schema: z.string(),
        },
        'text/markdown': {
          schema: z.string(),
        },
        'application/json': {
          schema: z.object({ content: z.string() }),
        },
      },
      description: 'Document content retrieved successfully',
    },
  },
});
documentsRouter.openapi(getDocumentContentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  const content = await storage.getDocument(id);
  
  // Return based on content type
  if (document.contentType === 'text/plain' || document.contentType === 'text/markdown') {
    c.header('Content-Type', document.contentType);
    return c.text(content.toString('utf-8'));
  }
  
  // Default to JSON
  return c.json({ content: content.toString('utf-8') });
});

// Clone Document (create clone token)
const cloneDocumentRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/clone',
  summary: 'Clone Document',
  description: 'Create a clone token for duplicating a document',
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
          schema: z.object({
            token: z.string(),
            expiresAt: z.string(),
            sourceDocument: z.any(),
          }),
        },
      },
      description: 'Clone token created successfully',
    },
  },
});

// Simple in-memory token store (replace with Redis/DB in production)
const cloneTokens = new Map<string, { documentId: string; expiresAt: Date }>();

documentsRouter.openapi(cloneDocumentRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  // Get content
  const content = await storage.getDocument(id);
  
  // Create token
  const token = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  
  cloneTokens.set(token, {
    documentId: id,
    expiresAt,
  });
  
  return c.json({
    token,
    expiresAt: expiresAt.toISOString(),
    sourceDocument: {
      ...formatDocument(document),
      content: content.toString('utf-8'),
    },
  });
});

// Get document by clone token
const getDocumentByTokenRoute = createRoute({
  method: 'get',
  path: '/api/documents/token/{token}',
  summary: 'Get Document by Clone Token',
  description: 'Retrieve a document using a clone token',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            sourceDocument: z.any(),
            expiresAt: z.string(),
          }),
        },
      },
      description: 'Document retrieved successfully',
    },
  },
});

documentsRouter.openapi(getDocumentByTokenRoute, async (c) => {
  const { token } = c.req.valid('param');
  
  const tokenData = cloneTokens.get(token);
  if (!tokenData) {
    throw new HTTPException(404, { message: 'Invalid or expired token' });
  }
  
  if (new Date() > tokenData.expiresAt) {
    cloneTokens.delete(token);
    throw new HTTPException(404, { message: 'Token expired' });
  }
  
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  const document = await graphDb.getDocument(tokenData.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Source document not found' });
  }
  
  const content = await storage.getDocument(tokenData.documentId);
  
  return c.json({
    sourceDocument: {
      ...formatDocument(document),
      content: content.toString('utf-8'),
    },
    expiresAt: tokenData.expiresAt.toISOString(),
  });
});

// Create document from clone token
const createDocumentFromTokenRoute = createRoute({
  method: 'post',
  path: '/api/documents/create-from-token',
  summary: 'Create Document from Clone Token',
  description: 'Create a new document using a clone token',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            name: z.string(),
            content: z.string(),
            archiveOriginal: z.boolean().optional(),
          }),
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
  },
});

documentsRouter.openapi(createDocumentFromTokenRoute, async (c) => {
  const body = c.req.valid('json');
  const user = c.get('user');
  
  const tokenData = cloneTokens.get(body.token);
  if (!tokenData) {
    throw new HTTPException(404, { message: 'Invalid or expired token' });
  }
  
  if (new Date() > tokenData.expiresAt) {
    cloneTokens.delete(body.token);
    throw new HTTPException(404, { message: 'Token expired' });
  }
  
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Get source document
  const sourceDoc = await graphDb.getDocument(tokenData.documentId);
  if (!sourceDoc) {
    throw new HTTPException(404, { message: 'Source document not found' });
  }
  
  // Create new document
  // const checksum = calculateChecksum(body.content);  // Not used
  const document: Document = {
    id: `doc_${Math.random().toString(36).substring(2, 11)}`,
    name: body.name,
    archived: false,
    contentType: sourceDoc.contentType,
    metadata: sourceDoc.metadata || {},
    entityTypes: sourceDoc.entityTypes || [],
    
    // Clone context
    creationMethod: 'clone',
    sourceDocumentId: tokenData.documentId,
    
    createdBy: user.id,
    updatedBy: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  const createInput: any = {
    name: document.name,
    entityTypes: document.entityTypes,
    content: body.content,
    contentType: document.contentType,
    metadata: document.metadata,
    createdBy: document.createdBy,
    creationMethod: document.creationMethod || 'api',
  };
  if (document.sourceSelectionId) createInput.sourceSelectionId = document.sourceSelectionId;
  if (document.sourceDocumentId) createInput.sourceDocumentId = document.sourceDocumentId;
  if (document.contentChecksum) createInput.contentChecksum = document.contentChecksum;
  
  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));
  
  // Archive original if requested
  if (body.archiveOriginal) {
    await graphDb.updateDocument(tokenData.documentId, {
      archived: true,
      updatedBy: user.id,
      });
  }
  
  // Clean up token
  cloneTokens.delete(body.token);
  
  // Get selections
  const highlights = await graphDb.getHighlights(savedDoc.id);
  const references = await graphDb.getReferences(savedDoc.id);
  
  return c.json({
    document: formatDocument(savedDoc),
    selections: [...highlights, ...references].map(formatSelection),
  }, 201);
});

// Get referenced by (incoming references)
const getReferencedByRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/referenced-by',
  summary: 'Get Referenced By',
  description: 'Get all selections from other documents that reference this document',
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
          schema: z.object({
            referencedBy: z.array(z.any()),
          }),
        },
      },
      description: 'Incoming references retrieved successfully',
    },
  },
});

documentsRouter.openapi(getReferencedByRoute, async (c) => {
  const { id } = c.req.valid('param');
  const graphDb = await getGraphDatabase();
  
  // Get all selections that reference this document
  const incomingRefs = await graphDb.getDocumentReferencedBy(id);
  
  // Get source document names for better display
  const enhancedReferences = await Promise.all(
    incomingRefs.map(async (sel) => {
      const sourceDoc = await graphDb.getDocument(sel.documentId);
      return {
        ...formatSelection(sel),
        documentName: sourceDoc?.name || 'Untitled Document'
      };
    })
  );
  
  return c.json({
    referencedBy: enhancedReferences,
  });
});

// DISCOVER CONTEXT
// ==========================================
const discoverContextRoute = createRoute({
  method: 'post',
  path: '/api/documents/discover-context',
  summary: 'Discover Context',
  description: 'Analyze text to discover relevant documents and entities',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            text: z.string().min(1).max(5000).openapi({
              example: 'The Titans were overthrown by Zeus and the Olympians',
              description: 'Text to analyze for context discovery'
            }),
            includeDocuments: z.boolean().default(true).openapi({
              description: 'Include relevant documents in the response'
            }),
            includeSelections: z.boolean().default(true).openapi({
              description: 'Include relevant selections/references in the response'
            }),
            limit: z.number().min(1).max(20).default(5).openapi({
              description: 'Maximum number of relevant items to return'
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            analysis: z.object({
              detectedEntities: z.array(z.object({
                text: z.string(),
                type: z.string(),
                confidence: z.number(),
              })),
              detectedTopics: z.array(z.string()),
            }),
            relevantDocuments: z.array(z.object({
              id: z.string(),
              name: z.string(),
              entityTypes: z.array(z.string()),
              relevanceScore: z.number(),
              matchType: z.string().openapi({
                description: 'How this document matches (entity_match, topic_match, text_similarity, etc.)'
              }),
              snippet: z.string(),
              matchedPhrases: z.array(z.string()),
            })),
            relevantSelections: z.array(z.object({
              id: z.string(),
              documentId: z.string(),
              documentName: z.string(),
              text: z.string(),
              selectionType: z.string(),
              relevanceScore: z.number(),
              matchReason: z.string(),
              resolvedDocument: z.object({
                id: z.string(),
                name: z.string(),
                entityTypes: z.array(z.string()),
              }).optional(),
            })),
          }),
        },
      },
      description: 'Context discovered successfully',
    },
  },
});

documentsRouter.openapi(discoverContextRoute, async (c) => {
  const body = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Analyze the text for entities and topics
  const analysis = await analyzeText(body.text);
  
  const relevantDocuments = [];
  const relevantSelections = [];
  
  if (body.includeDocuments) {
    // Find relevant documents
    const allDocs = await graphDb.listDocuments({});
    
    for (const doc of allDocs.documents) {
      const relevance = await calculateDocumentRelevance(doc, analysis, body.text);
      if (relevance.score > 0.3) {
        // Get a snippet of the document content
        const content = await storage.getDocument(doc.id);
        const snippet = extractRelevantSnippet(content.toString('utf-8'), body.text, 200);
        
        relevantDocuments.push({
          id: doc.id,
          name: doc.name,
          entityTypes: doc.entityTypes || [],
          relevanceScore: relevance.score,
          matchType: relevance.matchType,
          snippet,
          matchedPhrases: relevance.matchedPhrases,
        });
      }
    }
    
    // Sort by relevance and limit
    relevantDocuments.sort((a, b) => b.relevanceScore - a.relevanceScore);
    relevantDocuments.splice(body.limit);
  }
  
  if (body.includeSelections) {
    // Find relevant selections
    const allSelections = (await graphDb.listSelections({})).selections;
    
    for (const sel of allSelections) {
      const relevance = await calculateSelectionRelevance(sel, analysis, body.text);
      if (relevance.score > 0.3) {
        const sourceDoc = await graphDb.getDocument(sel.documentId);
        const resolvedDoc = sel.resolvedDocumentId ? await graphDb.getDocument(sel.resolvedDocumentId) : null;
        
        relevantSelections.push({
          id: sel.id,
          documentId: sel.documentId,
          documentName: sourceDoc?.name || 'Unknown',
          text: sel.selectionData?.text || '',
          selectionType: sel.selectionType,
          relevanceScore: relevance.score,
          matchReason: relevance.reason,
          ...(resolvedDoc && {
            resolvedDocument: {
              id: resolvedDoc.id,
              name: resolvedDoc.name,
              entityTypes: resolvedDoc.entityTypes || [],
            }
          })
        });
      }
    }
    
    // Sort by relevance and limit
    relevantSelections.sort((a, b) => b.relevanceScore - a.relevanceScore);
    relevantSelections.splice(body.limit);
  }
  
  return c.json({
    analysis,
    relevantDocuments,
    relevantSelections,
  });
});

// Helper functions for context discovery
async function analyzeText(text: string): Promise<{
  detectedEntities: Array<{ text: string; type: string; confidence: number }>;
  detectedTopics: string[];
}> {
  // Simple entity detection (proper nouns)
  const entities = [];
  const properNounPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let match;
  
  while ((match = properNounPattern.exec(text)) !== null) {
    // Simple heuristic: multi-word = Person, single word = other entity
    const entityText = match[0];
    const wordCount = entityText.split(' ').length;
    
    entities.push({
      text: entityText,
      type: wordCount > 1 ? 'Person' : 'Entity',
      confidence: 0.7,
    });
  }
  
  // Simple topic extraction (just extract key nouns for now)
  const topics = text
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 4)
    .filter(word => !['their', 'there', 'where', 'which', 'would', 'could', 'should'].includes(word))
    .slice(0, 5);
  
  return {
    detectedEntities: entities,
    detectedTopics: topics,
  };
}

async function calculateDocumentRelevance(
  doc: Document,
  analysis: any,
  queryText: string
): Promise<{ score: number; matchType: string; matchedPhrases: string[] }> {
  const docName = doc.name.toLowerCase();
  const queryLower = queryText.toLowerCase();
  const matchedPhrases = [];
  let score = 0;
  let matchType = 'none';
  
  // Check entity type matches
  for (const entity of analysis.detectedEntities) {
    if (doc.entityTypes?.some(type => type.toLowerCase() === entity.type.toLowerCase())) {
      score += 0.3;
      matchType = 'entity_match';
    }
  }
  
  // Check name similarity
  const words = queryLower.split(/\s+/);
  for (const word of words) {
    if (word.length > 3 && docName.includes(word)) {
      score += 0.2;
      matchedPhrases.push(word);
      if (matchType === 'none') matchType = 'name_match';
    }
  }
  
  // Check topic matches
  for (const topic of analysis.detectedTopics) {
    if (docName.includes(topic)) {
      score += 0.1;
      if (matchType === 'none') matchType = 'topic_match';
    }
  }
  
  return {
    score: Math.min(score, 1),
    matchType,
    matchedPhrases,
  };
}

async function calculateSelectionRelevance(
  sel: Selection,
  analysis: any,
  queryText: string
): Promise<{ score: number; reason: string }> {
  const selText = (sel.selectionData?.text || '').toLowerCase();
  const queryLower = queryText.toLowerCase();
  let score = 0;
  let reason = 'text_similarity';
  
  // Check direct text matches
  const words = queryLower.split(/\s+/);
  for (const word of words) {
    if (word.length > 3 && selText.includes(word)) {
      score += 0.3;
    }
  }
  
  // Check entity matches
  for (const entity of analysis.detectedEntities) {
    if (selText.includes(entity.text.toLowerCase())) {
      score += 0.4;
      reason = 'entity_reference';
    }
  }
  
  // Boost if it's a resolved reference
  if (sel.resolvedDocumentId) {
    score += 0.1;
  }
  
  return {
    score: Math.min(score, 1),
    reason,
  };
}

function extractRelevantSnippet(content: string, query: string, maxLength: number): string {
  const queryLower = query.toLowerCase();
  const contentLower = content.toLowerCase();
  
  // Find the first occurrence of any query word
  const words = queryLower.split(/\s+/).filter(w => w.length > 3);
  let bestIndex = -1;
  
  for (const word of words) {
    const index = contentLower.indexOf(word);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  
  if (bestIndex === -1) {
    // No match found, return beginning
    return content.substring(0, maxLength) + (content.length > maxLength ? '...' : '');
  }
  
  // Extract snippet around the match
  const start = Math.max(0, bestIndex - 50);
  const end = Math.min(content.length, bestIndex + maxLength - 50);
  let snippet = content.substring(start, end);
  
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  
  return snippet;
}

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
  },
});
documentsRouter.openapi(detectSelectionsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  console.log(`[detect-selections] Starting detection for document ${id} with entity types:`, body.entityTypes);
  
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  // Get document content from storage
  const content = await storage.getDocument(id);
  const contentStr = content.toString('utf-8');
  
  console.log(`[detect-selections] Document loaded, content length: ${contentStr.length}`);
  
  // Detect selections in the document
  const detectedSelections = await detectSelectionsInDocument(
    { ...document, content: contentStr },
    body.entityTypes,
    body.confidence || 0.7
  );
  
  console.log(`[detect-selections] Detected ${detectedSelections.length} potential entity references`);
  
  // Actually create the selections in the database
  const createdSelections = [];
  for (const detection of detectedSelections) {
    try {
      console.log(`[detect-selections] Creating selection for text: "${detection.selection.selectionData.text}"`);
      
      // Create the selection as a stub reference (resolvedDocumentId: null)
      const selectionData: any = {
        documentId: id,
        selectionType: detection.selection.selectionType,
        selectionData: detection.selection.selectionData,
        entityTypes: detection.selection.entityTypes,
        provisional: true,
        confidence: detection.selection.confidence,
        metadata: detection.selection.metadata,
      };
      
      // Only include resolvedDocumentId if we want a stub reference
      // For entity references without a target, we include it as null
      selectionData.resolvedDocumentId = null;
      
      const selection = await graphDb.createSelection(selectionData);
      
      createdSelections.push(selection);
      console.log(`[detect-selections] Created selection ${selection.id}`);
    } catch (err) {
      console.error(`[detect-selections] Failed to create selection:`, err);
    }
  }
  
  console.log(`[detect-selections] Successfully created ${createdSelections.length} selections`);
  
  // Format the selections for response
  const formattedSelections = createdSelections.map(sel => formatSelection(sel));
  
  return c.json({
    selections: formattedSelections,
    stats: {
      total: formattedSelections.length,
      byType: {},
      averageConfidence: 0.85,
    },
  });
});

// GENERATE DOCUMENT FROM SELECTION
// ==========================================
const generateDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/generate-document',
  summary: 'Generate Document from Selection',
  description: 'Use AI to generate a document from a selection/reference',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'sel_xyz789' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            prompt: z.string().optional().openapi({
              example: 'Generate a detailed explanation of this concept',
              description: 'Optional prompt for AI generation'
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            document: z.any(),
            selection: z.any(),
          }),
        },
      },
      description: 'Document generated successfully',
    },
  },
});

documentsRouter.openapi(generateDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Get the selection
  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }
  
  // Generate content (stub implementation)
  const generatedContent = await generateDocumentContent(
    selection.selectionData?.text || 'Unknown Topic',
    selection.entityTypes || [],
    body.prompt
  );
  
  // Create the document
  // const checksum = calculateChecksum(generatedContent.content);  // Not used
  const document: Document = {
    id: `doc_${Math.random().toString(36).substring(2, 11)}`,
    name: generatedContent.title,
    archived: false,
    contentType: 'text/markdown',
    metadata: {
      aiGenerated: true,
      generationPrompt: body.prompt,
      sourceSelectionId: id,
    },
    entityTypes: selection.entityTypes || [],
    
    creationMethod: 'api' as const,  // Use 'api' instead of 'ai_generation'
    sourceSelectionId: id,
    sourceDocumentId: selection.documentId,
    
    createdBy: user.id,
    updatedBy: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  const createInput: any = {
    name: document.name,
    entityTypes: document.entityTypes,
    content: generatedContent.content,
    contentType: document.contentType,
    metadata: document.metadata,
    createdBy: document.createdBy,
    creationMethod: document.creationMethod || 'api',
  };
  if (document.sourceSelectionId) createInput.sourceSelectionId = document.sourceSelectionId;
  if (document.sourceDocumentId) createInput.sourceDocumentId = document.sourceDocumentId;
  if (document.contentChecksum) createInput.contentChecksum = document.contentChecksum;
  
  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(generatedContent.content));
  
  // Update the selection to resolve to this document
  const updatedSelection = await graphDb.updateSelection(id, {
    resolvedDocumentId: savedDoc.id,
    resolvedAt: new Date(),
    resolvedBy: user.id,
  });
  
  return c.json({
    document: formatDocument(savedDoc),
    selection: formatSelection(updatedSelection),
  });
});

// Stub implementation for AI content generation
async function generateDocumentContent(
  topic: string,
  entityTypes: string[],
  prompt?: string
): Promise<{ title: string; content: string }> {
  // In real implementation, this would call an AI service
  const title = topic;
  const content = `# ${topic}

${prompt ? `*Generated based on prompt: "${prompt}"*\n\n` : ''}

## Overview

This is an AI-generated document about **${topic}**.

## Entity Types

${entityTypes.length > 0 ? entityTypes.map(type => `- ${type}`).join('\n') : 'No specific entity types identified.'}

## Description

This document was automatically generated to provide information about ${topic}. 
In a real implementation, this would contain AI-generated content based on:
- The selection text: "${topic}"
- Entity types: ${entityTypes.join(', ') || 'none'}
- Custom prompt: ${prompt || 'none'}

## Related Topics

- Further research needed
- Additional context required
- Related entities to explore

---
*This is a stub implementation. In production, this would use an actual AI service to generate meaningful content.*
`;
  
  return { title, content };
}

// CREATE DOCUMENT FROM SELECTION
// ==========================================
const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/selections/{id}/create-document',
  summary: 'Create Document from Selection',
  description: 'Create a new document and resolve a selection/reference to it',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'sel_xyz789' }),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string(),
            content: z.string(),
            contentType: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            document: z.any(),
            selection: z.any(),
          }),
        },
      },
      description: 'Document created and selection resolved',
    },
  },
});

documentsRouter.openapi(createDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Get the selection
  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }
  
  // Create the document
  // const checksum = calculateChecksum(body.content);  // Not used
  const document: Document = {
    id: `doc_${Math.random().toString(36).substring(2, 11)}`,
    name: body.name,
    archived: false,
    contentType: body.contentType || 'text/markdown',
    metadata: {},
    entityTypes: selection.entityTypes || [],
    
    creationMethod: 'reference',
    sourceSelectionId: id,
    sourceDocumentId: selection.documentId,
    
    createdBy: user.id,
    updatedBy: user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  const createInput: any = {
    name: document.name,
    entityTypes: document.entityTypes,
    content: body.content,
    contentType: document.contentType,
    metadata: document.metadata,
    createdBy: document.createdBy,
    creationMethod: document.creationMethod || 'api',
  };
  if (document.sourceSelectionId) createInput.sourceSelectionId = document.sourceSelectionId;
  if (document.sourceDocumentId) createInput.sourceDocumentId = document.sourceDocumentId;
  if (document.contentChecksum) createInput.contentChecksum = document.contentChecksum;
  
  const savedDoc = await graphDb.createDocument(createInput);
  await storage.saveDocument(savedDoc.id, Buffer.from(body.content));
  
  // Update the selection to resolve to this document
  const updatedSelection = await graphDb.updateSelection(id, {
    resolvedDocumentId: savedDoc.id,
    resolvedAt: new Date(),
    resolvedBy: user.id,
  });
  
  return c.json({
    document: formatDocument(savedDoc),
    selection: formatSelection(updatedSelection),
  }, 201);
});

// Format helpers
function formatDocument(doc: Document & { content?: string }): any {
  const formatted: any = {
    id: doc.id,
    name: doc.name,
    // checksum: doc.checksum,  // Document type doesn't have checksum
    contentType: doc.contentType,
    metadata: doc.metadata,
    archived: doc.archived || false,
    entityTypes: doc.entityTypes || [],
    
    creationMethod: doc.creationMethod,
    sourceSelectionId: doc.sourceSelectionId,
    sourceDocumentId: doc.sourceDocumentId,
    
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
  };
  
  // Include content if it exists (for search results)
  if ('content' in doc) {
    formatted.content = doc.content;
  }
  
  return formatted;
}

function formatSelection(sel: Selection): any {
  return {
    id: sel.id,
    documentId: sel.documentId,
    selectionType: sel.selectionType,
    selectionData: sel.selectionData,
    resolvedDocumentId: sel.resolvedDocumentId,
    resolvedAt: sel.resolvedAt instanceof Date ? sel.resolvedAt.toISOString() : sel.resolvedAt,
    resolvedBy: sel.resolvedBy,
    referenceTags: sel.referenceTags,
    entityTypes: sel.entityTypes,
    provisional: sel.provisional,
    confidence: sel.confidence,
    metadata: sel.metadata,
    createdBy: sel.createdBy,
    createdAt: sel.createdAt instanceof Date ? sel.createdAt.toISOString() : sel.createdAt,
    updatedAt: sel.updatedAt instanceof Date ? sel.updatedAt.toISOString() : sel.updatedAt,
  };
}


// Implementation for detecting entity references in document
// Version Zero: Detects proper nouns (capitalized word sequences)
async function detectSelectionsInDocument(
  document: any,
  entityTypes: string[],
  confidence: number
): Promise<any[]> {
  console.log(`Detecting entities of types: ${entityTypes.join(', ')} with confidence >= ${confidence}`);
  
  const detectedSelections = [];

  // Only process text content
  if (document.contentType === 'text/plain' || document.contentType === 'text/markdown') {
    const content = document.content;
    
    // Pattern for proper nouns: Capitalized word sequences
    // Matches sequences of capitalized words (with optional spaces/hyphens between them)
    // Stops at sentence endings (., !, ?), quotes, or markdown syntax
    const properNounPattern = /\b([A-Z][a-z]*(?:[-\s]+[A-Z][a-z]*)*)/g;
    
    // Track already detected positions to avoid duplicates
    const detectedPositions = new Set<string>();
    
    let match;
    while ((match = properNounPattern.exec(content)) !== null) {
      const selectionText = match[0];
      const offset = match.index;
      const length = selectionText.length;
      
      // Skip if too short (single letter) or too long (probably not a proper noun)
      if (selectionText.length < 2 || selectionText.length > 50) continue;
      
      // Skip if it's at the start of a sentence (check for preceding period/newline)
      if (offset > 0) {
        // const precedingChar = content[offset - 1];  // unused
        const twoCharsBefore = offset > 1 ? content.substring(offset - 2, offset) : '';
        // Skip if preceded by sentence ending + space (likely sentence start, not proper noun)
        if (twoCharsBefore.match(/[.!?\n]\s$/)) continue;
      }
      
      // Skip common words that are often capitalized but aren't entities
      const skipWords = ['The', 'This', 'That', 'These', 'Those', 'There', 'Here', 'When', 'Where', 'What', 'Who', 'Why', 'How', 'If', 'Then', 'But', 'And', 'Or', 'Not', 'In', 'On', 'At', 'To', 'For', 'From', 'With', 'By', 'About', 'After', 'Before', 'During'];
      if (skipWords.includes(selectionText)) continue;
      
      // Check if we already detected this position
      const posKey = `${offset}-${offset + length}`;
      if (detectedPositions.has(posKey)) continue;
      detectedPositions.add(posKey);
      
      // Randomly select an entity type from the requested types
      const randomEntityType = entityTypes[Math.floor(Math.random() * entityTypes.length)];
      
      const selection = {
        selection: {
          id: `sel_proper_${Math.random().toString(36).substring(2, 11)}`,
          documentId: document.id,
          selectionType: 'text_span',
          selectionData: {
            type: 'text_span',
            offset,
            length,
            text: selectionText,
          },
          provisional: true,
          confidence: confidence, // Use the provided confidence threshold
          entityTypes: [randomEntityType],
          metadata: {
            detectionType: 'proper_noun',
            pattern: 'Capitalized word sequence',
            assignedEntityType: randomEntityType
          },
          createdAt: new Date().toISOString(),
              },
        suggestedResolutions: [
          {
            documentId: null, // Stub reference
            documentName: selectionText,
            entityTypes: [randomEntityType],
            confidence: confidence,
            reason: 'Proper noun detected',
          }
        ],
      };
      detectedSelections.push(selection);
    }
    
    // Also detect wiki-style links as they're explicitly marked
    const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
    properNounPattern.lastIndex = 0; // Reset regex
    
    while ((match = wikiLinkPattern.exec(content)) !== null) {
      const selectionText = match[1];
      const offset = match.index;
      const length = match[0].length;
      
      // Check if we already detected this position
      const posKey = `${offset}-${offset + length}`;
      if (detectedPositions.has(posKey)) continue;
      detectedPositions.add(posKey);
      
      // Randomly select an entity type
      const randomEntityType = entityTypes[Math.floor(Math.random() * entityTypes.length)];
      
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
          provisional: true,
          confidence: 1.0, // Wiki links have high confidence
          entityTypes: [randomEntityType],
          metadata: {
            detectionType: 'wiki_link',
            pattern: '[[...]]',
            assignedEntityType: randomEntityType
          },
          createdAt: new Date().toISOString(),
              },
        suggestedResolutions: [
          {
            documentId: null,
            documentName: selectionText,
            entityTypes: [randomEntityType],
            confidence: 1.0,
            reason: 'Wiki-style link detected',
          }
        ],
      };
      detectedSelections.push(selection);
    }
  }

  return detectedSelections;
}

// LLM CONTEXT FOR DOCUMENT
// ==========================================
const getDocumentLLMContextRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/llm-context',
  summary: 'Get LLM Context for Document',
  description: 'Get comprehensive context about a document optimized for LLM consumption',
  tags: ['Documents'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'doc_abc123' }),
    }),
    query: z.object({
      includeContent: z.coerce.boolean().default(true).openapi({
        description: 'Include full document content'
      }),
      includeSelections: z.coerce.boolean().default(true).openapi({
        description: 'Include highlights and references within the document'
      }),
      includeIncomingRefs: z.coerce.boolean().default(true).openapi({
        description: 'Include references from other documents'
      }),
      includeRelated: z.coerce.boolean().default(true).openapi({
        description: 'Include related documents based on entity types and content'
      }),
      maxRelated: z.coerce.number().min(1).max(10).default(5).openapi({
        description: 'Maximum number of related documents to include'
      }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            document: z.object({
              id: z.string(),
              name: z.string(),
              entityTypes: z.array(z.string()),
              metadata: z.any(),
              archived: z.boolean(),
              createdAt: z.string(),
              updatedAt: z.string(),
            }),
            content: z.string().optional(),
            contentSummary: z.string().openapi({
              description: 'Brief summary of document content'
            }),
            statistics: z.object({
              wordCount: z.number(),
              highlightCount: z.number(),
              referenceCount: z.number(),
              stubReferenceCount: z.number(),
              incomingReferenceCount: z.number(),
            }),
            selections: z.object({
              highlights: z.array(z.object({
                id: z.string(),
                text: z.string(),
                offset: z.number(),
                length: z.number(),
              })).optional(),
              references: z.array(z.object({
                id: z.string(),
                text: z.string(),
                offset: z.number(),
                length: z.number(),
                targetDocumentId: z.string().nullable(),
                targetDocumentName: z.string().nullable(),
                referenceType: z.string().optional(),
                entityTypes: z.array(z.string()).optional(),
                isStub: z.boolean(),
              })).optional(),
            }),
            incomingReferences: z.array(z.object({
              sourceDocumentId: z.string(),
              sourceDocumentName: z.string(),
              selectionText: z.string(),
              referenceType: z.string().optional(),
            })).optional(),
            relatedDocuments: z.array(z.object({
              id: z.string(),
              name: z.string(),
              entityTypes: z.array(z.string()),
              relevanceScore: z.number(),
              relationshipType: z.string().openapi({
                description: 'How this document relates (entity_match, content_similarity, co_referenced, etc.)'
              }),
            })).optional(),
            graphContext: z.object({
              directConnections: z.number(),
              secondDegreeConnections: z.number(),
              centralityScore: z.number().optional(),
              clusters: z.array(z.string()).optional(),
            }),
          }),
        },
      },
      description: 'LLM context retrieved successfully',
    },
  },
});

documentsRouter.openapi(getDocumentLLMContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const query = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Get document
  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }
  
  // Get content
  let content: string | undefined;
  let wordCount = 0;
  if (query.includeContent) {
    const contentBuffer = await storage.getDocument(id);
    content = contentBuffer.toString('utf-8');
    wordCount = content.split(/\s+/).length;
  }
  
  // Get selections
  let highlights: any[] = [];
  let references: any[] = [];
  let stubReferenceCount = 0;
  
  if (query.includeSelections) {
    highlights = await graphDb.getHighlights(id);
    references = await graphDb.getReferences(id);
    
    // Count stub references
    stubReferenceCount = references.filter(ref => !ref.resolvedDocumentId).length;
    
    // Enhance references with target document names
    for (const ref of references) {
      if (ref.resolvedDocumentId) {
        const targetDoc = await graphDb.getDocument(ref.resolvedDocumentId);
        ref.targetDocumentName = targetDoc?.name || null;
      }
      ref.isStub = !ref.resolvedDocumentId;
    }
  }
  
  // Get incoming references
  let incomingReferences: any[] = [];
  if (query.includeIncomingRefs) {
    // Get all references and filter for those pointing to this document
    const allReferences = (await graphDb.listSelections({})).selections;
    const incoming = allReferences.filter(ref => 
      ref.selectionType === 'reference' && ref.resolvedDocumentId === id
    );
    
    for (const ref of incoming) {
      const sourceDoc = await graphDb.getDocument(ref.documentId);
      incomingReferences.push({
        sourceDocumentId: ref.documentId,
        sourceDocumentName: sourceDoc?.name || 'Unknown',
        selectionText: ref.selectionData?.text || '',
        referenceType: ref.referenceTags?.[0] || 'mentions',
      });
    }
  }
  
  // Get related documents
  let relatedDocuments: any[] = [];
  if (query.includeRelated && document.entityTypes && document.entityTypes.length > 0) {
    const allDocs = await graphDb.listDocuments({});
    
    // Find documents with matching entity types
    for (const doc of allDocs.documents) {
      if (doc.id === id) continue;
      
      const sharedEntities = doc.entityTypes?.filter(e => 
        document.entityTypes?.includes(e)
      ) || [];
      
      if (sharedEntities.length > 0) {
        relatedDocuments.push({
          id: doc.id,
          name: doc.name,
          entityTypes: doc.entityTypes || [],
          relevanceScore: sharedEntities.length / (document.entityTypes?.length || 1),
          relationshipType: 'entity_match',
        });
      }
    }
    
    // Sort by relevance and limit
    relatedDocuments.sort((a, b) => b.relevanceScore - a.relevanceScore);
    relatedDocuments = relatedDocuments.slice(0, query.maxRelated);
  }
  
  // Generate content summary
  const contentSummary = content 
    ? content.substring(0, 200).replace(/\n+/g, ' ').trim() + '...'
    : 'No content available';
  
  // Graph context (simplified for stub)
  const graphContext = {
    directConnections: references.length + incomingReferences.length,
    secondDegreeConnections: relatedDocuments.length,
    centralityScore: undefined, // Would calculate in real implementation
    clusters: document.entityTypes,
  };
  
  return c.json({
    document: {
      id: document.id,
      name: document.name,
      entityTypes: document.entityTypes || [],
      metadata: document.metadata || {},
      archived: document.archived || false,
      createdAt: document.createdAt instanceof Date ? document.createdAt.toISOString() : document.createdAt,
      updatedAt: document.updatedAt instanceof Date ? document.updatedAt.toISOString() : document.updatedAt,
    },
    ...(query.includeContent && { content }),
    contentSummary,
    statistics: {
      wordCount,
      highlightCount: highlights.length,
      referenceCount: references.length,
      stubReferenceCount,
      incomingReferenceCount: incomingReferences.length,
    },
    selections: query.includeSelections ? {
      highlights: highlights.map(h => ({
        id: h.id,
        text: h.selectionData?.text || '',
        offset: h.selectionData?.offset || 0,
        length: h.selectionData?.length || 0,
      })),
      references: references.map(r => ({
        id: r.id,
        text: r.selectionData?.text || '',
        offset: r.selectionData?.offset || 0,
        length: r.selectionData?.length || 0,
        targetDocumentId: r.resolvedDocumentId || null,
        targetDocumentName: r.targetDocumentName || null,
        referenceType: r.referenceTags?.[0] || undefined,
        entityTypes: r.entityTypes || undefined,
        isStub: r.isStub,
      })),
    } : {},
    ...(query.includeIncomingRefs && { incomingReferences }),
    ...(query.includeRelated && { relatedDocuments }),
    graphContext,
  });
});

// LLM CONTEXT FOR REFERENCE
// ==========================================
const getReferenceLLMContextRoute = createRoute({
  method: 'get',
  path: '/api/references/{id}/llm-context',
  summary: 'Get LLM Context for Reference',
  description: 'Get comprehensive context about a reference/selection optimized for LLM consumption',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'sel_xyz789' }),
    }),
    query: z.object({
      contextWindow: z.coerce.number().min(100).max(1000).default(300).openapi({
        description: 'Characters of surrounding context to include'
      }),
      includeRelatedRefs: z.coerce.boolean().default(true).openapi({
        description: 'Include other references with similar entity types'
      }),
      includeTargetDoc: z.coerce.boolean().default(true).openapi({
        description: 'Include full target document if reference is resolved'
      }),
      maxRelated: z.coerce.number().min(1).max(10).default(5).openapi({
        description: 'Maximum number of related references to include'
      }),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            reference: z.object({
              id: z.string(),
              text: z.string(),
              type: z.string(),
              entityTypes: z.array(z.string()).optional(),
              referenceType: z.string().optional(),
              isStub: z.boolean(),
            }),
            sourceContext: z.object({
              documentId: z.string(),
              documentName: z.string(),
              documentEntityTypes: z.array(z.string()),
              surroundingText: z.string(),
              beforeText: z.string(),
              afterText: z.string(),
              offset: z.number(),
            }),
            targetContext: z.object({
              exists: z.boolean(),
              documentId: z.string().nullable(),
              documentName: z.string().nullable(),
              content: z.string().optional(),
              entityTypes: z.array(z.string()).optional(),
              suggestedName: z.string().optional(),
              suggestedEntityTypes: z.array(z.string()).optional(),
            }),
            relatedReferences: z.array(z.object({
              id: z.string(),
              text: z.string(),
              documentId: z.string(),
              documentName: z.string(),
              entityTypes: z.array(z.string()).optional(),
              similarityScore: z.number(),
              similarityReason: z.string(),
            })).optional(),
            generationContext: z.object({
              suggestedContent: z.object({
                title: z.string(),
                summary: z.string(),
                keyPoints: z.array(z.string()),
                relatedConcepts: z.array(z.string()),
              }),
              contentGuidelines: z.array(z.string()),
              recommendedStructure: z.array(z.string()),
            }),
            knowledgeGraphContext: z.object({
              connectedEntities: z.array(z.string()),
              domainClusters: z.array(z.string()),
              semanticDistance: z.number().optional(),
            }),
          }),
        },
      },
      description: 'Reference LLM context retrieved successfully',
    },
  },
});

documentsRouter.openapi(getReferenceLLMContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const query = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();
  
  // Get the reference/selection
  const selection = await graphDb.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Reference not found' });
  }
  
  const isReference = selection.selectionType === 'reference';
  const isStub = isReference && !selection.resolvedDocumentId;
  
  // Get source document
  const sourceDoc = await graphDb.getDocument(selection.documentId);
  if (!sourceDoc) {
    throw new HTTPException(404, { message: 'Source document not found' });
  }
  
  // Get source content and extract surrounding context
  const sourceContent = await storage.getDocument(selection.documentId);
  const contentStr = sourceContent.toString('utf-8');
  
  const offset = selection.selectionData?.offset || 0;
  const length = selection.selectionData?.length || 0;
  const beforeStart = Math.max(0, offset - query.contextWindow);
  const afterEnd = Math.min(contentStr.length, offset + length + query.contextWindow);
  
  const beforeText = contentStr.substring(beforeStart, offset);
  const afterText = contentStr.substring(offset + length, afterEnd);
  const surroundingText = contentStr.substring(beforeStart, afterEnd);
  
  // Get target context if reference is resolved
  let targetContext: any = {
    exists: false,
    documentId: null,
    documentName: null,
    suggestedName: selection.selectionData?.text || 'New Document',
    suggestedEntityTypes: selection.entityTypes || [],
  };
  
  if (selection.resolvedDocumentId) {
    const targetDoc = await graphDb.getDocument(selection.resolvedDocumentId);
    if (targetDoc) {
      targetContext = {
        exists: true,
        documentId: targetDoc.id,
        documentName: targetDoc.name,
        entityTypes: targetDoc.entityTypes || [],
      };
      
      if (query.includeTargetDoc) {
        const targetContent = await storage.getDocument(targetDoc.id);
        targetContext.content = targetContent.toString('utf-8');
      }
    }
  }
  
  // Get related references
  let relatedReferences: any[] = [];
  if (query.includeRelatedRefs) {
    const allSelections = (await graphDb.listSelections({})).selections;
    
    for (const sel of allSelections) {
      if (sel.id === id) continue;
      if (sel.selectionType !== 'reference') continue;
      
      // Calculate similarity based on entity types and text
      let similarityScore = 0;
      let similarityReason = '';
      
      // Check entity type overlap
      if (selection.entityTypes && sel.entityTypes) {
        const sharedEntities = sel.entityTypes.filter(e => 
          selection.entityTypes?.includes(e)
        );
        if (sharedEntities.length > 0) {
          similarityScore += sharedEntities.length * 0.3;
          similarityReason = 'shared_entities';
        }
      }
      
      // Check text similarity (simple approach)
      if (selection.selectionData?.text && sel.selectionData?.text) {
        const text1 = selection.selectionData.text.toLowerCase();
        const text2 = sel.selectionData.text.toLowerCase();
        if (text1.includes(text2) || text2.includes(text1)) {
          similarityScore += 0.5;
          similarityReason = similarityReason ? 'shared_entities_and_text' : 'text_similarity';
        }
      }
      
      if (similarityScore > 0) {
        const relDoc = await graphDb.getDocument(sel.documentId);
        relatedReferences.push({
          id: sel.id,
          text: sel.selectionData?.text || '',
          documentId: sel.documentId,
          documentName: relDoc?.name || 'Unknown',
          entityTypes: sel.entityTypes,
          similarityScore,
          similarityReason,
        });
      }
    }
    
    // Sort by similarity and limit
    relatedReferences.sort((a, b) => b.similarityScore - a.similarityScore);
    relatedReferences = relatedReferences.slice(0, query.maxRelated);
  }
  
  // Generate content suggestions for stub references
  const generationContext = {
    suggestedContent: {
      title: selection.selectionData?.text || 'New Document',
      summary: `This document provides information about ${selection.selectionData?.text || 'the selected topic'}.`,
      keyPoints: [
        `Definition and overview of ${selection.selectionData?.text}`,
        'Historical context and development',
        'Current applications and relevance',
        'Related concepts and connections',
      ],
      relatedConcepts: relatedReferences.map(r => r.text).slice(0, 5),
    },
    contentGuidelines: [
      'Start with a clear definition',
      'Provide context from the source document',
      'Include relevant entity types',
      'Connect to existing knowledge in the graph',
    ],
    recommendedStructure: [
      'Overview',
      'Description',
      'Key Concepts',
      'Relationships',
      'Applications',
      'References',
    ],
  };
  
  // Knowledge graph context
  const knowledgeGraphContext = {
    connectedEntities: [
      ...(sourceDoc.entityTypes || []),
      ...(selection.entityTypes || []),
    ].filter((v, i, a) => a.indexOf(v) === i), // unique
    domainClusters: sourceDoc.entityTypes || [],
    semanticDistance: undefined, // Would calculate in real implementation
  };
  
  return c.json({
    reference: {
      id: selection.id,
      text: selection.selectionData?.text || '',
      type: selection.selectionType,
      entityTypes: selection.entityTypes,
      referenceType: selection.referenceTags?.[0],
      isStub,
    },
    sourceContext: {
      documentId: sourceDoc.id,
      documentName: sourceDoc.name,
      documentEntityTypes: sourceDoc.entityTypes || [],
      surroundingText,
      beforeText,
      afterText,
      offset,
    },
    targetContext,
    ...(query.includeRelatedRefs && { relatedReferences }),
    generationContext,
    knowledgeGraphContext,
  });
});

export default documentsRouter;