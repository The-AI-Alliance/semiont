import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { getStorageService } from '../../storage/filesystem';
import { generateDocumentFromTopic, generateText } from '../../inference/factory';
import { calculateChecksum } from '@semiont/utils';
import {
  CREATION_METHODS,
  GenerateDocumentFromAnnotationRequestSchema,
  GenerateDocumentFromAnnotationResponseSchema,
  CreateDocumentFromSelectionResponseSchema,
  AnnotationContextResponseSchema,
  ContextualSummaryResponseSchema,
  getAnnotationExactText,
  getTextPositionSelector,
  type Document,
  type Annotation,
  type GenerateDocumentFromAnnotationResponse,
  type CreateDocumentFromSelectionResponse,
  type AnnotationContextResponse,
  type ContextualSummaryResponse,
} from '@semiont/core-types';
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

// CREATE DOCUMENT FROM ANNOTATION
const createDocumentFromAnnotationRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/create-document',
  summary: 'Create Document from Annotation',
  description: 'Create a new document from an annotation and resolve the annotation to it',
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
          schema: CreateDocumentFromSelectionResponseSchema,
        },
      },
      description: 'Document created and annotation resolved',
    },
  },
});

operationsRouter.openapi(createDocumentFromAnnotationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const storage = getStorageService();

  if (!body.content) {
    throw new HTTPException(400, { message: 'Content is required when creating a document' });
  }

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(id);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
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

  // Emit reference.resolved event to link the annotation to the new document
  await emitReferenceResolved({
    documentId: annotation.target.source,
    referenceId: id,
    userId: user.id,
    targetDocumentId: documentId,
  });

  // Return optimistic response - update annotation to link to new document
  const resolvedAnnotation: Annotation = {
    ...annotation,
    motivation: 'linking' as const,
    body: {
      ...annotation.body,
      type: 'SpecificResource' as const,
      source: documentId,
    },
    resolvedBy: user.id,
    resolvedAt: new Date().toISOString(),
    resolvedDocumentName: body.name,
  };

  const documentMetadata: Document = {
    id: documentId,
    name: body.name,
    contentType: body.contentType,
    entityTypes: body.entityTypes || [],
    creationMethod: CREATION_METHODS.API,
    contentChecksum: checksum,
    creator: user.id,
    created: new Date().toISOString(),
    archived: false,
  };

  const response: CreateDocumentFromSelectionResponse = {
    document: documentMetadata,
    annotation: resolvedAnnotation,
  };

  return c.json(response, 201);
});

// GENERATE DOCUMENT FROM ANNOTATION
const generateDocumentFromAnnotationRoute = createRoute({
  method: 'post',
  path: '/api/annotations/{id}/generate-document',
  summary: 'Generate Document from Annotation',
  description: 'Use AI to generate document content from an annotation',
  tags: ['Selections'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromAnnotationRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: GenerateDocumentFromAnnotationResponseSchema,
        },
      },
      description: 'Document generated and annotation resolved',
    },
  },
});

operationsRouter.openapi(generateDocumentFromAnnotationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const storage = getStorageService();

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(id);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get the original document metadata from Layer 3
  const originalDoc = await DocumentQueryService.getDocumentMetadata(annotation.target.source);
  if (!originalDoc) {
    throw new HTTPException(404, { message: 'Original document not found' });
  }

  // Use annotation text
  const selectedText = getAnnotationExactText(annotation);

  // Generate content using the proper document generation function
  const { title, content: generatedContent } = await generateDocumentFromTopic(
    selectedText,
    body.entityTypes || annotation.body.entityTypes || [],
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
    entityTypes: body.entityTypes || annotation.body.entityTypes || [],
    metadata: {
      generatedFrom: id,
      prompt: body.prompt,
    },
  });

  // Emit reference.resolved event to link the annotation to the new document
  await emitReferenceResolved({
    documentId: annotation.target.source,
    referenceId: id,
    userId: user.id,
    targetDocumentId: documentId,
  });

  // Return optimistic response - update annotation to link to generated document
  const resolvedAnnotation: Annotation = {
    ...annotation,
    motivation: 'linking' as const,
    body: {
      ...annotation.body,
      type: 'SpecificResource' as const,
      source: documentId,
    },
    resolvedBy: user.id,
    resolvedAt: new Date().toISOString(),
    resolvedDocumentName: documentName,
  };

  const documentMetadata: Document = {
    id: documentId,
    name: documentName,
    contentType: 'text/markdown',
    entityTypes: body.entityTypes || annotation.body.entityTypes || [],
    sourceAnnotationId: id,
    creationMethod: CREATION_METHODS.GENERATED,
    contentChecksum: checksum,
    creator: user.id,
    created: new Date().toISOString(),
    archived: false,
  };

  const response: GenerateDocumentFromAnnotationResponse = {
    document: documentMetadata,
    annotation: resolvedAnnotation,
    generated: true,
  };

  return c.json(response, 201);
});

// GET ANNOTATION CONTEXT
const getSelectionContextRoute = createRoute({
  method: 'get',
  path: '/api/annotations/{id}/context',
  summary: 'Get Annotation Context',
  description: 'Get the context around an annotation',
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
          schema: AnnotationContextResponseSchema,
        },
      },
      description: 'Annotation context',
    },
  },
});

operationsRouter.openapi(getSelectionContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { contextBefore, contextAfter } = c.req.valid('query');
  const storage = getStorageService();

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(id);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get document metadata from Layer 3
  const document = await DocumentQueryService.getDocumentMetadata(annotation.target.source);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content from Layer 1
  const content = await storage.getDocument(annotation.target.source);
  const contentStr = content.toString('utf-8');

  // Extract context based on annotation position
  const posSelector3 = getTextPositionSelector(annotation.target.selector);
  if (!posSelector3) {
    throw new HTTPException(400, { message: 'TextPositionSelector required for context' });
  }
  const selStart = posSelector3.offset;
  const selEnd = posSelector3.offset + posSelector3.length;
  const start = Math.max(0, selStart - contextBefore);
  const end = Math.min(contentStr.length, selEnd + contextAfter);

  const before = contentStr.substring(start, selStart);
  const selected = contentStr.substring(selStart, selEnd);
  const after = contentStr.substring(selEnd, end);

  const response: AnnotationContextResponse = {
    annotation: {
      id: annotation.id,
      documentId: annotation.target.source,
      selector: {
        exact: getAnnotationExactText(annotation),
        offset: posSelector3.offset,
        length: posSelector3.length,
      },
      referencedDocumentId: annotation.body.source ?? null,
      entityTypes: annotation.body.entityTypes,
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
      entityTypes: document.entityTypes,
      archived: document.archived,
      creationMethod: document.creationMethod,
      creator: document.creator,
      created: document.created,
      contentChecksum: document.contentChecksum,
    },
  };

  return c.json(response);
});

// GET CONTEXTUAL SUMMARY
const getContextualSummaryRoute = createRoute({
  method: 'get',
  path: '/api/annotations/{id}/summary',
  summary: 'Get Contextual Summary',
  description: 'Get an AI-generated summary of the annotation in context',
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
          schema: ContextualSummaryResponseSchema,
        },
      },
      description: 'Contextual summary',
    },
  },
});

operationsRouter.openapi(getContextualSummaryRoute, async (c) => {
  const { id } = c.req.valid('param');
  const storage = getStorageService();

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(id);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get document from Layer 3
  const document = await DocumentQueryService.getDocumentMetadata(annotation.target.source);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content from Layer 1
  const content = await storage.getDocument(annotation.target.source);
  const contentStr = content.toString('utf-8');

  // Extract annotation text with context
  const contextSize = 500; // Fixed context for summary
  const posSelector4 = getTextPositionSelector(annotation.target.selector);
  if (!posSelector4) {
    throw new HTTPException(400, { message: 'TextPositionSelector required for summary' });
  }
  const selStart = posSelector4.offset;
  const selEnd = posSelector4.offset + posSelector4.length;
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
Entity types: ${(annotation.body.entityTypes || []).join(', ')}`;

  const summary = await generateText(summaryPrompt, 500, 0.5);

  const response: ContextualSummaryResponse = {
    summary,
    relevantFields: {
      documentId: document.id,
      documentName: document.name,
      entityTypes: annotation.body.entityTypes || [],
    },
    context: {
      before: before.substring(Math.max(0, before.length - 200)), // Last 200 chars
      selected,
      after: after.substring(0, 200), // First 200 chars
    },
  };

  return c.json(response);
});

// Register SSE route for document generation progress
registerGenerateDocumentStream(operationsRouter);