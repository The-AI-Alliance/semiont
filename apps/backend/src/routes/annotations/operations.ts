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
import { generateResourceFromTopic, generateText } from '../../inference/factory';
import { userToAgent } from '../../utils/id-generator';
import { getTargetSource, getTargetSelector } from '../../lib/annotation-utils';
import { uriToResourceId } from '../../lib/uri-utils';
import { getFilesystemConfig } from '../../config/config';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getTextPositionSelector } from '@semiont/api-client';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation } from '../../utils/resource-helpers';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
  userId,
  annotationId,
  resourceId as makeResourceId,
} from '@semiont/core';

import { registerGenerateResourceStream } from './routes/generate-resource-stream';
import { registerGenerateResource } from './routes/generate-resource';
import { AnnotationQueryService } from '../../services/annotation-queries';
import { ResourceQueryService } from '../../services/resource-queries';
import { createEventStore } from '../../services/event-store-service';
import { validateRequestBody } from '../../middleware/validate-openapi';
import { getEntityTypes } from '@semiont/api-client';
import type { User } from '@prisma/client';

type Annotation = components['schemas']['Annotation'];

type CreateResourceFromSelectionRequest = components['schemas']['CreateResourceFromSelectionRequest'];
type GenerateResourceFromAnnotationRequest = components['schemas']['GenerateResourceFromAnnotationRequest'];
type CreateResourceFromSelectionResponse = components['schemas']['CreateResourceFromSelectionResponse'];
type GenerateResourceFromAnnotationResponse = components['schemas']['GenerateResourceFromAnnotationResponse'];
type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];

// Helper: Create resolved annotation with SpecificResource body
function createResolvedAnnotation(annotation: Annotation, resourceId: string, user: User): Annotation {
  const bodyArray = Array.isArray(annotation.body) ? annotation.body : [];
  return {
    ...annotation,
    motivation: 'linking' as const,
    body: [
      ...bodyArray.filter(b => b.type !== 'SpecificResource'),
      {
        type: 'SpecificResource' as const,
        source: resourceId,
        purpose: 'linking' as const,
      },
    ],
    modified: new Date().toISOString(),
    generator: userToAgent(user),
  };
}

// Helper: Extract annotation context from resource content
interface AnnotationContext {
  before: string;
  selected: string;
  after: string;
}

function getAnnotationContext(
  annotation: Annotation,
  contentStr: string,
  contextBefore: number,
  contextAfter: number
): AnnotationContext {
  const targetSelector = getTargetSelector(annotation.target);
  const posSelector = targetSelector ? getTextPositionSelector(targetSelector) : null;
  if (!posSelector) {
    throw new HTTPException(400, { message: 'TextPositionSelector required for context' });
  }
  const selStart = posSelector.start;
  const selEnd = posSelector.end;
  const start = Math.max(0, selStart - contextBefore);
  const end = Math.min(contentStr.length, selEnd + contextAfter);

  return {
    before: contentStr.substring(start, selStart),
    selected: contentStr.substring(selStart, selEnd),
    after: contentStr.substring(selEnd, end),
  };
}

// Create router with auth middleware
export const operationsRouter: AnnotationsRouterType = createAnnotationRouter();

/**
 * POST /api/annotations/:id/create-resource
 *
 * Create a new resource from an annotation and resolve the annotation to it
 * Requires authentication
 */
operationsRouter.post('/api/annotations/:id/create-resource',
  validateRequestBody('CreateResourceFromSelectionRequest'),
  async (c) => {
    const { id } = c.req.param();
    const body = c.get('validatedBody') as CreateResourceFromSelectionRequest;
    const user = c.get('user');
    const basePath = getFilesystemConfig().path;
    const repStore = new FilesystemRepresentationStore({ basePath });

    if (!body.content) {
      throw new HTTPException(400, { message: 'Content is required when creating a resource' });
    }

    if (!body.resourceId) {
      throw new HTTPException(400, { message: 'resourceId is required' });
    }

    // Get annotation from Layer 3
    const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(body.resourceId));
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Create the new resource
    const rId = makeResourceId(generateUuid());

    // Store representation
    const storedRep = await repStore.store(Buffer.from(body.content), {
      mediaType: body.format,
      rel: 'original',
    });

    // Emit resource.created event (event store updates Layer 3, graph consumer updates Layer 4)
    const eventStore = await createEventStore(basePath);
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId: userId(user.id),
      version: 1,
      payload: {
        name: body.name,
        format: body.format,
        contentChecksum: storedRep.checksum,
        creationMethod: CREATION_METHODS.API,
        entityTypes: body.entityTypes || [],
        language: undefined,  // Not provided in this flow
        isDraft: false,     // Created from selection, not a draft
        generatedFrom: undefined,
        generationPrompt: undefined,
      },
    });

    // Build HTTP URI for the new resource
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
    const resourceUri = `${normalizedBase}/resources/${rId}`;

    // Emit annotation.body.updated event to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: resourceUri,
        purpose: 'linking',
      },
    }];

    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: uriToResourceId(getTargetSource(annotation.target)),
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(id),
        operations,
      },
    });

    // Return optimistic response - Add SpecificResource to body array
    const resolvedAnnotation = createResolvedAnnotation(annotation, resourceUri, user);

    // Build ResourceDescriptor for response
    const resourceMetadata = {
      '@context': 'https://schema.org/',
      '@id': resourceUri,
      name: body.name,
      entityTypes: body.entityTypes || [],
      representations: [{
        mediaType: body.format,
        checksum: storedRep.checksum,
        rel: 'original' as const,
      }],
      creationMethod: CREATION_METHODS.API,
      wasAttributedTo: userToAgent(user),
      dateCreated: new Date().toISOString(),
      archived: false,
    };

    const response: CreateResourceFromSelectionResponse = {
      resource: resourceMetadata,
      annotation: resolvedAnnotation,
    };

    return c.json(response, 201);
  }
);

/**
 * POST /api/annotations/:id/generate-resource
 *
 * Use AI to generate resource content from an annotation
 * Requires authentication
 */
operationsRouter.post('/api/annotations/:id/generate-resource',
  validateRequestBody('GenerateResourceFromAnnotationRequest'),
  async (c) => {
    const { id } = c.req.param();
    const body = c.get('validatedBody') as GenerateResourceFromAnnotationRequest;
    const user = c.get('user');
    const basePath = getFilesystemConfig().path;
    const repStore = new FilesystemRepresentationStore({ basePath });

    if (!body.resourceId) {
      throw new HTTPException(400, { message: 'resourceId is required' });
    }

    // Get annotation from Layer 3
    const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(body.resourceId));
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    }

    // Get the original resource metadata from Layer 3
    const originalDoc = await ResourceQueryService.getResourceMetadata(getTargetSource(annotation.target));
    if (!originalDoc) {
      throw new HTTPException(404, { message: 'Original resource not found' });
    }

    // Use annotation text
    const selectedText = getAnnotationExactText(annotation);

    // Extract entity types from annotation body
    const annotationEntityTypes = getEntityTypes(annotation);

    // Generate content using the proper resource generation function
    const { title, content: generatedContent } = await generateResourceFromTopic(
      selectedText,
      body.entityTypes || annotationEntityTypes,
      body.prompt,
      body.language
    );

    if (!generatedContent) {
      throw new HTTPException(500, { message: 'No content returned from generation service' });
    }

    // Create the new resource
    const resourceName = body.name || title;
    const rId = makeResourceId(generateUuid());

    // Build HTTP URI for the new resource
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
    const resourceUri = `${normalizedBase}/resources/${rId}`;

    // Store generated representation
    const storedRep = await repStore.store(Buffer.from(generatedContent), {
      mediaType: 'text/plain',
      rel: 'original',
    });

    // Emit resource.created event (event store updates Layer 3, graph consumer updates Layer 4)
    const eventStore = await createEventStore(basePath);
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId: rId,
      userId: userId(user.id),
      version: 1,
      payload: {
        name: resourceName,
        format: 'text/markdown',
        contentChecksum: storedRep.checksum,
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: body.entityTypes || annotationEntityTypes,
        language: body.language,
        isDraft: false,
        generatedFrom: id,
        generationPrompt: body.prompt,
      },
    });

    // Emit annotation.body.updated event to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: resourceUri,
        purpose: 'linking',
      },
    }];

    await eventStore.appendEvent({
      type: 'annotation.body.updated',
      resourceId: uriToResourceId(getTargetSource(annotation.target)),
      userId: userId(user.id),
      version: 1,
      payload: {
        annotationId: annotationId(id),
        operations,
      },
    });

    // Return optimistic response - Add SpecificResource to body array
    const resolvedAnnotation = createResolvedAnnotation(annotation, resourceUri, user);

    // Build ResourceDescriptor for response
    const resourceMetadata = {
      '@context': 'https://schema.org/',
      '@id': resourceUri,
      name: resourceName,
      entityTypes: body.entityTypes || annotationEntityTypes,
      representations: [{
        mediaType: 'text/markdown',
        checksum: storedRep.checksum,
        rel: 'original' as const,
        language: body.language,
      }],
      sourceAnnotationId: id,
      creationMethod: CREATION_METHODS.GENERATED,
      wasAttributedTo: userToAgent(user),
      dateCreated: new Date().toISOString(),
      archived: false,
    };

    const response: GenerateResourceFromAnnotationResponse = {
      resource: resourceMetadata,
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

  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

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

  const basePath = getFilesystemConfig().path;
  const repStore = new FilesystemRepresentationStore({ basePath });

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(resourceId));
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get resource metadata from Layer 3
  const resource = await ResourceQueryService.getResourceMetadata(getTargetSource(annotation.target));
  if (!resource) {
    throw new HTTPException(404, { message: 'Resource not found' });
  }

  // Get content from representation store
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) {
    throw new HTTPException(404, { message: 'Resource content not found' });
  }
  const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
  const contentStr = content.toString('utf-8');

  // Extract context based on annotation position
  const { before, selected, after } = getAnnotationContext(annotation, contentStr, contextBefore, contextAfter);

  const response: AnnotationContextResponse = {
    annotation: annotation,  // Return full W3C annotation
    context: {
      before,
      selected,
      after,
    },
    resource: {
      '@context': resource['@context'],
      '@id': resource['@id'],
      name: resource.name,
      entityTypes: resource.entityTypes,
      representations: resource.representations,
      archived: resource.archived,
      creationMethod: resource.creationMethod,
      wasAttributedTo: resource.wasAttributedTo,
      dateCreated: resource.dateCreated,
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
  const query = c.req.query();
  const basePath = getFilesystemConfig().path;
  const repStore = new FilesystemRepresentationStore({ basePath });

  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(resourceId));
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get resource from Layer 3
  const resource = await ResourceQueryService.getResourceMetadata(getTargetSource(annotation.target));
  if (!resource) {
    throw new HTTPException(404, { message: 'Resource not found' });
  }

  // Get content from representation store
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) {
    throw new HTTPException(404, { message: 'Resource content not found' });
  }
  const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
  const contentStr = content.toString('utf-8');

  // Extract annotation text with context
  const contextSize = 500; // Fixed context for summary
  const { before, selected, after } = getAnnotationContext(annotation, contentStr, contextSize, contextSize);

  // Extract entity types from annotation body
  const annotationEntityTypes = getEntityTypes(annotation);

  // Generate summary using the proper inference function
  const summaryPrompt = `Summarize this text in context:

Context before: "${before.substring(Math.max(0, before.length - 200))}"
Selected exact: "${selected}"
Context after: "${after.substring(0, 200)}"

Resource: ${resource.name}
Entity types: ${annotationEntityTypes.join(', ')}`;

  const summary = await generateText(summaryPrompt, 500, 0.5);

  const response: ContextualSummaryResponse = {
    summary,
    relevantFields: {
      resourceId: resource.id,
      resourceName: resource.name,
      entityTypes: annotationEntityTypes,
    },
    context: {
      before: before.substring(Math.max(0, before.length - 200)), // Last 200 chars
      selected,
      after: after.substring(0, 200), // First 200 chars
    },
  };

  return c.json(response);
});

// Register SSE route for resource generation progress
registerGenerateResourceStream(operationsRouter);
// Register non-SSE route for job-based resource generation
registerGenerateResource(operationsRouter);
