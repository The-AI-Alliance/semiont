/**
 * Resource LLM Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { LLMContextService } from '../../../services/llm-context-service';

export function registerGetResourceLLMContext(router: ResourcesRouterType) {
  /**
   * GET /resources/:id/llm-context
   *
   * Get resource with full context for LLM processing
   * Includes related resources, annotations, graph representation, and optional summary
   *
   * Query parameters:
   * - depth: 1-3 (default: 2)
   * - maxResources: 1-20 (default: 10)
   * - includeContent: true/false (default: true)
   * - includeSummary: true/false (default: false)
   */
  router.get('/resources/:id/llm-context', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();
    const config = c.get('config');

    // Parse and validate query parameters
    const depth = query.depth ? Number(query.depth) : 2;
    const maxResources = query.maxResources ? Number(query.maxResources) : 10;
    const includeContent = query.includeContent === 'false' ? false : true;
    const includeSummary = query.includeSummary === 'true' ? true : false;

    // Validate depth range
    if (depth < 1 || depth > 3) {
      throw new HTTPException(400, { message: 'Query parameter "depth" must be between 1 and 3' });
    }

    // Validate maxResources range
    if (maxResources < 1 || maxResources > 20) {
      throw new HTTPException(400, { message: 'Query parameter "maxResources" must be between 1 and 20' });
    }

    // Delegate to service for LLM context building
    try {
      const response = await LLMContextService.getResourceLLMContext(
        id,
        {
          depth,
          maxResources,
          includeContent,
          includeSummary,
        },
        config
      );

      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.message === 'Resource not found') {
        throw new HTTPException(404, { message: 'Resource not found' });
      }
      throw error;
    }
  });
}
