import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { getStorageService } from '../../storage/filesystem';
import { generateDocumentFromTopic, generateText } from '../../inference/factory';
import { calculateChecksum } from '@semiont/utils';
import { CREATION_METHODS } from '@semiont/core-types';
import { registerGenerateDocumentStream } from './routes/generate-document-stream';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';
import { emitDocumentCreated, emitReferenceResolved } from '../../events/emit';

// Create router with auth middleware
export const operationsRouter: AnnotationsRouterType = createAnnotationRouter();

// Local schemas
const CreateDocumentFromSelectionRequest = z.object({
  name: z.string().min(1).max(255),
  entityTypes: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentType: z.string().default('text/plain'),
  metadata: z.record(z.string(), z.any()).optional(),
});

const CreateDocumentFromSelectionResponse = z.object({
  document: z.any(),
  selection: z.any(),
});

const GenerateDocumentFromSelectionRequest = z.object({
  name: z.string().min(1).max(255).optional(),
  entityTypes: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});

const GenerateDocumentFromSelectionResponse = z.object({
  document: z.any(),
  selection: z.any(),
  generated: z.boolean(),
});

const SelectionContextResponse = z.object({
  selection: z.any(),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
  document: z.any(),
});

const ContextualSummaryResponse = z.object({
  summary: z.string(),
  relevantFields: z.record(z.string(), z.any()),
  context: z.object({
    before: z.string().optional(),
    selected: z.string(),
    after: z.string().optional(),
  }),
});

// CREATE DOCUMENT FROM SELECTION
const createDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/create-document',
  summary: 'Create Document from Selection',
  description: 'Create a new document from a selection and resolve the selection to it',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: CreateDocumentFromSelectionResponse,
        },
      },
      description: 'Document created and selection resolved',
    },
  },
});

operationsRouter.openapi(createDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const storage = getStorageService();

  if (!body.content) {
    throw new HTTPException(400, { message: 'Content is required when creating a document' });
  }

  // Get selection from Layer 3
  const selection = await AnnotationQueryService.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Create the new document
  const checksum = calculateChecksum(body.content);
  const documentId = `doc-sha256:${checksum}`;

  // Save content to Layer 1 (filesystem)
  await storage.saveDocument(documentId, Buffer.from(body.content));

  // Emit document.created event (event store updates Layer 3, graph consumer updates Layer 4)
  await emitDocumentCreated({
    documentId,
    userId: user.id,
    name: body.name,
    contentType: body.contentType,
    contentHash: checksum,
    entityTypes: body.entityTypes || [],
    metadata: body.metadata || {},
  });

  // Emit reference.resolved event to link the selection to the new document
  await emitReferenceResolved({
    documentId: selection.documentId,
    referenceId: id,
    userId: user.id,
    targetDocumentId: documentId,
  });

  // Return optimistic response
  return c.json({
    document: {
      id: documentId,
      name: body.name,
      contentType: body.contentType,
      content: body.content,
      entityTypes: body.entityTypes || [],
      metadata: body.metadata || {},
      creationMethod: CREATION_METHODS.API,
      contentChecksum: checksum,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      archived: false,
    },
    selection: {
      id,
      documentId: selection.documentId,
      selector: {
        exact: selection.exact,
        offset: selection.selector.offset,
        length: selection.selector.length,
      },
      referencedDocumentId: documentId,
      entityTypes: selection.entityTypes,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }, 201);
});

// GENERATE DOCUMENT FROM SELECTION
const generateDocumentFromSelectionRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/generate-document',
  summary: 'Generate Document from Selection',
  description: 'Use AI to generate document content from a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionRequest,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromSelectionResponse,
        },
      },
      description: 'Document generated and selection resolved',
    },
  },
});

operationsRouter.openapi(generateDocumentFromSelectionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const storage = getStorageService();

  // Get selection from Layer 3
  const selection = await AnnotationQueryService.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Get the original document metadata from Layer 3
  const originalDoc = await DocumentQueryService.getDocumentMetadata(selection.documentId);
  if (!originalDoc) {
    throw new HTTPException(404, { message: 'Original document not found' });
  }

  // Use selection text
  const selectedText = selection.exact;

  // Generate content using the proper document generation function
  const { title, content: generatedContent } = await generateDocumentFromTopic(
    selectedText,
    body.entityTypes || selection.entityTypes || [],
    body.prompt
  );

  if (!generatedContent) {
    throw new HTTPException(500, { message: 'No content returned from generation service' });
  }

  // Create the new document
  const documentName = body.name || title;
  const checksum = calculateChecksum(generatedContent);
  const documentId = `doc-sha256:${checksum}`;

  // Store generated content to Layer 1
  await storage.saveDocument(documentId, Buffer.from(generatedContent));

  // Emit document.created event (event store updates Layer 3, graph consumer updates Layer 4)
  await emitDocumentCreated({
    documentId,
    userId: user.id,
    name: documentName,
    contentType: 'text/markdown',
    contentHash: checksum,
    entityTypes: body.entityTypes || selection.entityTypes || [],
    metadata: {
      generatedFrom: id,
      prompt: body.prompt,
    },
  });

  // Emit reference.resolved event to link the selection to the new document
  await emitReferenceResolved({
    documentId: selection.documentId,
    referenceId: id,
    userId: user.id,
    targetDocumentId: documentId,
  });

  // Return optimistic response
  return c.json({
    document: {
      id: documentId,
      name: documentName,
      contentType: 'text/markdown',
      content: generatedContent,
      entityTypes: body.entityTypes || selection.entityTypes || [],
      metadata: {
        generatedFrom: id,
        prompt: body.prompt,
      },
      creationMethod: CREATION_METHODS.GENERATED,
      contentChecksum: checksum,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      archived: false,
    },
    selection: {
      id,
      documentId: selection.documentId,
      selector: {
        exact: selection.exact,
        offset: selection.selector.offset,
        length: selection.selector.length,
      },
      referencedDocumentId: documentId,
      entityTypes: selection.entityTypes,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    generated: true,
  }, 201);
});

// GET SELECTION CONTEXT
const getSelectionContextRoute = createRoute({
  method: 'get',
  path: '/api/annotations/{id}/context',
  summary: 'Get Selection Context',
  description: 'Get the context around a selection',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      contextBefore: z.coerce.number().int().min(0).max(5000).default(100),
      contextAfter: z.coerce.number().int().min(0).max(5000).default(100),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: SelectionContextResponse,
        },
      },
      description: 'Selection context',
    },
  },
});

operationsRouter.openapi(getSelectionContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { contextBefore, contextAfter } = c.req.valid('query');
  const storage = getStorageService();

  // Get selection from Layer 3
  const selection = await AnnotationQueryService.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Get document metadata from Layer 3
  const document = await DocumentQueryService.getDocumentMetadata(selection.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content from Layer 1
  const content = await storage.getDocument(selection.documentId);
  const contentStr = content.toString('utf-8');

  // Extract context based on selection position
  const selStart = selection.selector.offset;
  const selEnd = selection.selector.offset + selection.selector.length;
  const start = Math.max(0, selStart - contextBefore);
  const end = Math.min(contentStr.length, selEnd + contextAfter);

  const before = contentStr.substring(start, selStart);
  const selected = contentStr.substring(selStart, selEnd);
  const after = contentStr.substring(selEnd, end);

  return c.json({
    selection: {
      id: selection.id,
      documentId: selection.documentId,
      selector: {
        exact: selection.exact,
        offset: selection.selector.offset,
        length: selection.selector.length,
      },
      referencedDocumentId: selection.referencedDocumentId,
      entityTypes: selection.entityTypes,
      createdBy: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    context: {
      before,
      selected,
      after,
    },
    document: {
      id: document.id,
      name: document.name,
      contentType: document.contentType,
      metadata: document.metadata,
      entityTypes: document.entityTypes,
      archived: document.archived,
      creationMethod: document.creationMethod,
      createdBy: document.createdBy,
      createdAt: document.createdAt,
    },
  });
});

// GET CONTEXTUAL SUMMARY
const getContextualSummaryRoute = createRoute({
  method: 'get',
  path: '/api/annotations/{id}/summary',
  summary: 'Get Contextual Summary',
  description: 'Get an AI-generated summary of the selection in context',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: ContextualSummaryResponse,
        },
      },
      description: 'Contextual summary',
    },
  },
});

operationsRouter.openapi(getContextualSummaryRoute, async (c) => {
  const { id } = c.req.valid('param');
  const storage = getStorageService();

  // Get selection from Layer 3
  const selection = await AnnotationQueryService.getSelection(id);
  if (!selection) {
    throw new HTTPException(404, { message: 'Selection not found' });
  }

  // Get document from Layer 3
  const document = await DocumentQueryService.getDocumentMetadata(selection.documentId);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content from Layer 1
  const content = await storage.getDocument(selection.documentId);
  const contentStr = content.toString('utf-8');

  // Extract selection text with context
  const contextSize = 500; // Fixed context for summary
  const selStart = selection.selector.offset;
  const selEnd = selection.selector.offset + selection.selector.length;
  const start = Math.max(0, selStart - contextSize);
  const end = Math.min(contentStr.length, selEnd + contextSize);

  const before = contentStr.substring(start, selStart);
  const selected = contentStr.substring(selStart, selEnd);
  const after = contentStr.substring(selEnd, end);

  // Generate summary using the proper inference function
  const summaryPrompt = `Summarize this text in context:

Context before: "${before.substring(Math.max(0, before.length - 200))}"
Selected exact: "${selected}"
Context after: "${after.substring(0, 200)}"

Document: ${document.name}
Entity types: ${(selection.entityTypes || []).join(', ')}`;

  const summary = await generateText(summaryPrompt, 500, 0.5);

  return c.json({
    summary,
    relevantFields: {
      documentId: document.id,
      documentName: document.name,
      entityTypes: selection.entityTypes || [],
    },
    context: {
      before: before.substring(Math.max(0, before.length - 200)), // Last 200 chars
      selected,
      after: after.substring(0, 200), // First 200 chars
    },
  });
});

// Register SSE route for document generation progress
registerGenerateDocumentStream(operationsRouter);