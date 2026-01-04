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
import { generateText } from '@semiont/inference';
import {
  getTargetSource,
  getTargetSelector,
  type components,
  getTextPositionSelector,
  getPrimaryRepresentation,
  decodeRepresentation,
  getEntityTypes,
} from '@semiont/api-client';
import { uriToResourceId } from '@semiont/core';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import {
  annotationId,
  resourceId as makeResourceId,
} from '@semiont/core';

import { AnnotationQueryService } from '../../services/annotation-queries';
import { ResourceQueryService } from '../../services/resource-queries';

type Annotation = components['schemas']['Annotation'];

type AnnotationContextResponse = components['schemas']['AnnotationContextResponse'];
type ContextualSummaryResponse = components['schemas']['ContextualSummaryResponse'];

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
  const config = c.get('config');

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

  const basePath = config.services.filesystem!.path;
  const projectRoot = config._metadata?.projectRoot;
  const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

  // Get annotation from view storage
  const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(resourceId), config);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get resource metadata from view storage
  const resource = await ResourceQueryService.getResourceMetadata(uriToResourceId(getTargetSource(annotation.target)), config);
  if (!resource) {
    throw new HTTPException(404, { message: 'Resource not found' });
  }

  // Get content from representation store
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) {
    throw new HTTPException(404, { message: 'Resource content not found' });
  }
  const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
  const contentStr = decodeRepresentation(content, primaryRep.mediaType);

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
  const config = c.get('config');
  const basePath = config.services.filesystem!.path;
  const projectRoot = config._metadata?.projectRoot;
  const repStore = new FilesystemRepresentationStore({ basePath }, projectRoot);

  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  }

  // Get annotation from view storage
  const annotation = await AnnotationQueryService.getAnnotation(annotationId(id), makeResourceId(resourceId), config);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  }

  // Get resource from view storage
  const resource = await ResourceQueryService.getResourceMetadata(uriToResourceId(getTargetSource(annotation.target)), config);
  if (!resource) {
    throw new HTTPException(404, { message: 'Resource not found' });
  }

  // Get content from representation store
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) {
    throw new HTTPException(404, { message: 'Resource content not found' });
  }
  const content = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
  const contentStr = decodeRepresentation(content, primaryRep.mediaType);

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

  const summary = await generateText(summaryPrompt, config, 500, 0.5);

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
