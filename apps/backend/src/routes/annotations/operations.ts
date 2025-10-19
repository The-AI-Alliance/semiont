/**
 * Annotation Operations Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { createAnnotationRouter, type AnnotationsRouterType } from './shared';
import { getStorageService } from '../../storage/filesystem';
import { generateDocumentFromTopic, generateText } from '../../inference/factory';
import { calculateChecksum } from '@semiont/core';
import { userToAgent } from '../../utils/id-generator';
import {
  CREATION_METHODS,
  getAnnotationExactText,
  getTextPositionSelector,
  type Document,
  type Annotation,
} from '@semiont/core';
import { registerGenerateDocumentStream } from './routes/generate-document-stream';
import { registerGenerateDocument } from './routes/generate-document';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { DocumentQueryService } from '../../services/document-queries';
import { getEventStore } from '../../events/event-store';
import { validateRequestBody } from '../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';

type CreateDocumentFromSelectionRequest = components['schemas']['CreateDocumentFromSelectionRequest'];
type GenerateDocumentFromAnnotationRequest = components['schemas']['GenerateDocumentFromAnnotationRequest'];
type CreateDocumentFromSelectionResponse = components['schemas']['CreateDocumentFromSelectionResponse'];
type GenerateDocumentFromAnnotationResponse = components['schemas']['GenerateDocumentFromAnnotationResponse'];
type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];

// Create router with auth middleware
export const operationsRouter: AnnotationsRouterType = createAnnotationRouter();

/**
 * POST /api/annotations/:id/create-document
 *
 * Create a new document from an annotation and resolve the annotation to it
 * Requires authentication
 */
operationsRouter.post('/api/annotations/:id/create-document',
  validateRequestBody('CreateDocumentFromSelectionRequest'),
  async (c) => {
    const { id } = c.req.param();
    const body = c.get('validatedBody') as CreateDocumentFromSelectionRequest;
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
    const eventStore = await getEventStore();
    await eventStore.appendEvent({
      type: 'document.created',
      documentId,
      userId: user.id,
      version: 1,
      payload: {
        name: body.name,
        format: body.format,
        contentHash: checksum,
        creationMethod: CREATION_METHODS.API,
        entityTypes: body.entityTypes || [],
        metadata: body.metadata || {},
      },
    });

    // Emit reference.resolved event to link the annotation to the new document
    await eventStore.appendEvent({
      type: 'reference.resolved',
      documentId: annotation.target.source,
      userId: user.id,
      version: 1,
      payload: {
        referenceId: id,
        targetDocumentId: documentId,
      },
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
      modified: new Date().toISOString(),
      generator: userToAgent(user),
    };

    const documentMetadata: Document = {
      id: documentId,
      name: body.name,
      format: body.format,
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
  }
);

/**
 * POST /api/annotations/:id/generate-document
 *
 * Use AI to generate document content from an annotation
 * Requires authentication
 */
operationsRouter.post('/api/annotations/:id/generate-document',
  validateRequestBody('GenerateDocumentFromAnnotationRequest'),
  async (c) => {
    const { id } = c.req.param();
    const body = c.get('validatedBody') as GenerateDocumentFromAnnotationRequest;
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
      body.prompt,
      body.locale
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
    const eventStore = await getEventStore();
    await eventStore.appendEvent({
      type: 'document.created',
      documentId,
      userId: user.id,
      version: 1,
      payload: {
        name: documentName,
        format: 'text/markdown',
        contentHash: checksum,
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: body.entityTypes || annotation.body.entityTypes || [],
        metadata: {
          generatedFrom: id,
          prompt: body.prompt,
          locale: body.locale,
        },
      },
    });

    // Emit reference.resolved event to link the annotation to the new document
    await eventStore.appendEvent({
      type: 'reference.resolved',
      documentId: annotation.target.source,
      userId: user.id,
      version: 1,
      payload: {
        referenceId: id,
        targetDocumentId: documentId,
      },
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
      modified: new Date().toISOString(),
      generator: userToAgent(user),
    };

    const documentMetadata: Document = {
      id: documentId,
      name: documentName,
      format: 'text/markdown',
      entityTypes: body.entityTypes || annotation.body.entityTypes || [],
      locale: body.locale,
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
  }
);

/**
 * GET /api/annotations/:id/context
 *
 * Get the context around an annotation
 * Requires authentication
 *
 * Query parameters:
 * - contextBefore: Characters before selection (0-5000, default: 100)
 * - contextAfter: Characters after selection (0-5000, default: 100)
 */
operationsRouter.get('/api/annotations/:id/context', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query();

  // Parse and validate query parameters
  const contextBefore = query.contextBefore ? Number(query.contextBefore) : 100;
  const contextAfter = query.contextAfter ? Number(query.contextAfter) : 100;

  // Validate ranges
  if (contextBefore < 0 || contextBefore > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextBefore" must be between 0 and 5000' });
  }
  if (contextAfter < 0 || contextAfter > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextAfter" must be between 0 and 5000' });
  }

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
      format: document.format,
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

/**
 * GET /api/annotations/:id/summary
 *
 * Get an AI-generated summary of the annotation in context
 * Requires authentication
 */
operationsRouter.get('/api/annotations/:id/summary', async (c) => {
  const { id } = c.req.param();
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
// Register non-SSE route for job-based document generation
registerGenerateDocument(operationsRouter);
