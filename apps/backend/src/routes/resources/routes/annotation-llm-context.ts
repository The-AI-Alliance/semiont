/**
 * Annotation LLM Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { AnnotationContextService } from '../../../services/annotation-context';
import { resourceId } from '@semiont/core';
import { annotationUri } from '@semiont/api-client';

export function registerGetAnnotationLLMContext(router: ResourcesRouterType) {
  /**
   * GET /resources/:resourceId/annotations/:annotationId/llm-context
   *
   * Get annotation with full context for LLM processing
   * Includes source context (text around annotation), target context (referenced resource if applicable), and metadata
   *
   * Query parameters:
   * - includeSourceContext: true/false (default: true)
   * - includeTargetContext: true/false (default: true)
   * - contextWindow: 100-5000 (default: 1000) - characters before/after selection
   */
  router.get('/resources/:resourceId/annotations/:annotationId/llm-context', async (c) => {
    const { resourceId: resourceIdParam, annotationId: annotationIdParam } = c.req.param();
    const query = c.req.query();
    const config = c.get('config');

    // Parse and validate query parameters
    const includeSourceContext = query.includeSourceContext === 'false' ? false : true;
    const includeTargetContext = query.includeTargetContext === 'false' ? false : true;
    const contextWindow = query.contextWindow ? Number(query.contextWindow) : 1000;

    // Validate contextWindow range
    if (contextWindow < 100 || contextWindow > 5000) {
      throw new HTTPException(400, { message: 'Query parameter "contextWindow" must be between 100 and 5000' });
    }

    try {
      // Construct full annotation URI (annotations in views use full URIs as their id)
      const fullAnnotationUri = `${config.services.backend!.publicURL}/annotations/${annotationIdParam}`;

      // Use shared service to build context
      const response = await AnnotationContextService.buildLLMContext(annotationUri(fullAnnotationUri), resourceId(resourceIdParam), config, {
        includeSourceContext,
        includeTargetContext,
        contextWindow
      });

      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Annotation not found') {
          throw new HTTPException(404, { message: 'Annotation not found' });
        }
        if (error.message === 'Source resource not found') {
          throw new HTTPException(404, { message: 'Source resource not found' });
        }
        if (error.message === 'Source content not found') {
          throw new HTTPException(404, { message: 'Source content not found' });
        }
      }
      throw error;
    }
  });
}
