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
import { getFilesystemConfig } from '../../config/environment-loader';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, getTextPositionSelector } from '@semiont/api-client';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { getPrimaryRepresentation } from '../../utils/resource-helpers';
import {
  CREATION_METHODS,
  generateUuid,
  type BodyOperation,
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
    before: contentStr.substring(start, selStart),
    selected: contentStr.substring(selStart, selEnd),
    after: contentStr.substring(selEnd, end),
// Create router with auth middleware
export const operationsRouter: AnnotationsRouterType = createAnnotationRouter();
 * POST /api/annotations/:id/create-resource
 * Create a new resource from an annotation and resolve the annotation to it
 * Requires authentication
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
    // Get annotation from Layer 3
    const annotation = await AnnotationQueryService.getAnnotation(id, body.resourceId);
    if (!annotation) {
      throw new HTTPException(404, { message: 'Annotation not found' });
    // Create the new resource
    const resourceId = generateUuid();
    // Store representation
    const storedRep = await repStore.store(Buffer.from(body.content), {
      mediaType: body.format,
      rel: 'original',
    });
    // Emit resource.created event (event store updates Layer 3, graph consumer updates Layer 4)
    const eventStore = await createEventStore(basePath);
    await eventStore.appendEvent({
      type: 'resource.created',
      resourceId,
      userId: user.id,
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
    // Build HTTP URI for the new resource
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    const normalizedBase = backendUrl.endsWith('/') ? backendUrl.slice(0, -1) : backendUrl;
    const resourceUri = `${normalizedBase}/resources/${resourceId}`;
    // Emit annotation.body.updated event to link the annotation to the new resource
    const operations: BodyOperation[] = [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: resourceUri,
        purpose: 'linking',
    }];
      type: 'annotation.body.updated',
      resourceId: getTargetSource(annotation.target),
        annotationId: id,
        operations,
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
    return c.json(response, 201);
);
 * POST /api/annotations/:id/generate-resource
 * Use AI to generate resource content from an annotation
operationsRouter.post('/api/annotations/:id/generate-resource',
  validateRequestBody('GenerateResourceFromAnnotationRequest'),
    const body = c.get('validatedBody') as GenerateResourceFromAnnotationRequest;
    // Get the original resource metadata from Layer 3
    const originalDoc = await ResourceQueryService.getResourceMetadata(getTargetSource(annotation.target));
    if (!originalDoc) {
      throw new HTTPException(404, { message: 'Original resource not found' });
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
    const resourceName = body.name || title;
    // Store generated representation
    const storedRep = await repStore.store(Buffer.from(generatedContent), {
      mediaType: 'text/plain',
        name: resourceName,
        format: 'text/markdown',
        creationMethod: CREATION_METHODS.GENERATED,
        entityTypes: body.entityTypes || annotationEntityTypes,
        language: body.language,
        isDraft: false,
        generatedFrom: id,
        generationPrompt: body.prompt,
      name: resourceName,
      entityTypes: body.entityTypes || annotationEntityTypes,
        mediaType: 'text/markdown',
      sourceAnnotationId: id,
      creationMethod: CREATION_METHODS.GENERATED,
    const response: GenerateResourceFromAnnotationResponse = {
      generated: true,
 * GET /api/annotations/:id/context
 * Get the context around an annotation
 * Query parameters:
 * - contextBefore: Characters before selection (0-5000, default: 100)
 * - contextAfter: Characters after selection (0-5000, default: 100)
operationsRouter.get('/api/annotations/:id/context', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query();
  // Require resourceId query parameter
  const resourceId = query.resourceId;
  if (!resourceId) {
    throw new HTTPException(400, { message: 'resourceId query parameter is required' });
  // Parse and validate query parameters
  const contextBefore = query.contextBefore ? Number(query.contextBefore) : 100;
  const contextAfter = query.contextAfter ? Number(query.contextAfter) : 100;
  // Validate ranges
  if (contextBefore < 0 || contextBefore > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextBefore" must be between 0 and 5000' });
  if (contextAfter < 0 || contextAfter > 5000) {
    throw new HTTPException(400, { message: 'Query parameter "contextAfter" must be between 0 and 5000' });
  const basePath = getFilesystemConfig().path;
  const repStore = new FilesystemRepresentationStore({ basePath });
  // Get annotation from Layer 3
  const annotation = await AnnotationQueryService.getAnnotation(id, resourceId);
  if (!annotation) {
    throw new HTTPException(404, { message: 'Annotation not found' });
  // Get resource metadata from Layer 3
  const resource = await ResourceQueryService.getResourceMetadata(getTargetSource(annotation.target));
  if (!resource) {
    throw new HTTPException(404, { message: 'Resource not found' });
  // Get content from representation store
  const primaryRep = getPrimaryRepresentation(resource);
  if (!primaryRep?.checksum || !primaryRep?.mediaType) {
    throw new HTTPException(404, { message: 'Resource content not found' });
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
  return c.json(response);
});
 * GET /api/annotations/:id/summary
 * Get an AI-generated summary of the annotation in context
operationsRouter.get('/api/annotations/:id/summary', async (c) => {
  // Get resource from Layer 3
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
      before: before.substring(Math.max(0, before.length - 200)), // Last 200 chars
      after: after.substring(0, 200), // First 200 chars
// Register SSE route for resource generation progress
registerGenerateResourceStream(operationsRouter);
// Register non-SSE route for job-based resource generation
registerGenerateResource(operationsRouter);
