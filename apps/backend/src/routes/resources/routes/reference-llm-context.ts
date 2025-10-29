/**
 * Reference LLM Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { generateResourceSummary } from '../../../inference/factory';
import { getBodySource, getTargetSource, getTargetSelector } from '../../../lib/annotation-utils';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getEntityTypes as getResourceEntityTypes } from '../../../utils/resource-helpers';

type ReferenceLLMContextResponse = components['schemas']['ReferenceLLMContextResponse'];

export function registerGetReferenceLLMContext(router: ResourcesRouterType) {
  /**
   * GET /api/resources/:resourceId/references/:referenceId/llm-context
   *
   * Get reference with full context for LLM processing
   * Includes source context (text around reference), target context (referenced resource), and metadata
   *
   * Query parameters:
   * - includeSourceContext: true/false (default: true)
   * - includeTargetContext: true/false (default: true)
   * - contextWindow: 100-5000 (default: 1000) - characters before/after selection
   */
  router.get('/api/resources/:resourceId/references/:referenceId/llm-context', async (c) => {
    const { resourceId, referenceId } = c.req.param();
    const query = c.req.query();
    const basePath = getFilesystemConfig().path;

    // Parse and validate query parameters
    const includeSourceContext = query.includeSourceContext === 'false' ? false : true;
    const includeTargetContext = query.includeTargetContext === 'false' ? false : true;
    const contextWindow = query.contextWindow ? Number(query.contextWindow) : 1000;

    // Validate contextWindow range
    if (contextWindow < 100 || contextWindow > 5000) {
      throw new HTTPException(400, { message: 'Query parameter "contextWindow" must be between 100 and 5000' });
    }

    const graphDb = await getGraphDatabase();
    const repStore = new FilesystemRepresentationStore({ basePath });

    // Get the reference
    const reference = await graphDb.getAnnotation(referenceId);
    if (!reference || getTargetSource(reference.target) !== resourceId) {
      throw new HTTPException(404, { message: 'Reference not found' });
    }

    // Get source resource
    const sourceDoc = await graphDb.getResource(resourceId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source resource not found' });
    }

    // Get target resource if reference is resolved
    const bodySource = getBodySource(reference.body);
    const targetDoc = bodySource ? await graphDb.getResource(bodySource) : null;

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      if (!primaryRep?.checksum || !primaryRep?.mediaType) {
        throw new HTTPException(404, { message: 'Source content not found' });
      }
      const sourceContent = await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
      const contentStr = sourceContent.toString('utf-8');

      const targetSelector = getTargetSelector(reference.target);
      if (targetSelector && 'start' in targetSelector && 'end' in targetSelector) {
        const start = targetSelector.start as number;
        const end = targetSelector.end as number;

        const before = contentStr.slice(Math.max(0, start - contextWindow), start);
        const selected = contentStr.slice(start, end);
        const after = contentStr.slice(end, Math.min(contentStr.length, end + contextWindow));

        sourceContext = { before, selected, after };
      }
    }

    // Build target context if requested and available
    let targetContext;
    if (includeTargetContext && targetDoc) {
      const targetRep = getPrimaryRepresentation(targetDoc);
      if (targetRep?.checksum && targetRep?.mediaType) {
        const targetContent = await repStore.retrieve(targetRep.checksum, targetRep.mediaType);
        const contentStr = targetContent.toString('utf-8');

        targetContext = {
          content: contentStr.slice(0, contextWindow * 2),
          summary: await generateResourceSummary(targetDoc.name, contentStr, getResourceEntityTypes(targetDoc)),
        };
      }
    }

    // TODO: Generate suggested resolution using AI
    const suggestedResolution = undefined;

    const response: ReferenceLLMContextResponse = {
      reference,
      sourceResource: sourceDoc,
      targetResource: targetDoc,
      ...(sourceContext ? { sourceContext } : {}),
      ...(targetContext ? { targetContext } : {}),
      ...(suggestedResolution ? { suggestedResolution } : {}),
    };

    return c.json(response);
  });
}
