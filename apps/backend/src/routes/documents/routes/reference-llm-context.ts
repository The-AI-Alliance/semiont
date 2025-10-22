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
import { getStorageService } from '../../../storage/filesystem';
import { generateDocumentSummary } from '../../../inference/factory';
import { getBodySource, getTargetSource, getTargetSelector } from '../../../lib/annotation-utils';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';

type ReferenceLLMContextResponse = components['schemas']['ReferenceLLMContextResponse'];

export function registerGetReferenceLLMContext(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:documentId/references/:referenceId/llm-context
   *
   * Get reference with full context for LLM processing
   * Includes source context (text around reference), target context (referenced document), and metadata
   *
   * Query parameters:
   * - includeSourceContext: true/false (default: true)
   * - includeTargetContext: true/false (default: true)
   * - contextWindow: 100-5000 (default: 1000) - characters before/after selection
   */
  router.get('/api/documents/:documentId/references/:referenceId/llm-context', async (c) => {
    const { documentId, referenceId } = c.req.param();
    const query = c.req.query();

    // Parse and validate query parameters
    const includeSourceContext = query.includeSourceContext === 'false' ? false : true;
    const includeTargetContext = query.includeTargetContext === 'false' ? false : true;
    const contextWindow = query.contextWindow ? Number(query.contextWindow) : 1000;

    // Validate contextWindow range
    if (contextWindow < 100 || contextWindow > 5000) {
      throw new HTTPException(400, { message: 'Query parameter "contextWindow" must be between 100 and 5000' });
    }

    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    // Get the reference
    const reference = await graphDb.getAnnotation(referenceId);
    if (!reference || getTargetSource(reference.target) !== documentId) {
      throw new HTTPException(404, { message: 'Reference not found' });
    }

    // Get source document
    const sourceDoc = await graphDb.getDocument(documentId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // Get target document if reference is resolved
    const bodySource = getBodySource(reference.body);
    const targetDoc = bodySource ? await graphDb.getDocument(bodySource) : null;

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const sourceContent = await storage.getDocument(documentId);
      const contentStr = sourceContent.toString('utf-8');

      const targetSelector = getTargetSelector(reference.target);
      if (targetSelector && 'offset' in targetSelector) {
        const offset = targetSelector.offset as number;
        const length = targetSelector.length as number;

        const before = contentStr.slice(Math.max(0, offset - contextWindow), offset);
        const selected = contentStr.slice(offset, offset + length);
        const after = contentStr.slice(offset + length, Math.min(contentStr.length, offset + length + contextWindow));

        sourceContext = { before, selected, after };
      }
    }

    // Build target context if requested and available
    let targetContext;
    if (includeTargetContext && targetDoc) {
      const targetContent = await storage.getDocument(targetDoc.id);
      const contentStr = targetContent.toString('utf-8');

      targetContext = {
        content: contentStr.slice(0, contextWindow * 2),
        summary: await generateDocumentSummary(targetDoc.name, contentStr, targetDoc.entityTypes || []),
      };
    }

    // TODO: Generate suggested resolution using AI
    const suggestedResolution = undefined;

    const response: ReferenceLLMContextResponse = {
      reference,
      sourceDocument: sourceDoc,
      targetDocument: targetDoc,
      ...(sourceContext ? { sourceContext } : {}),
      ...(targetContext ? { targetContext } : {}),
      ...(suggestedResolution ? { suggestedResolution } : {}),
    };

    return c.json(response);
  });
}
