import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { formatDocument } from '../helpers';
import { generateDocumentSummary } from '../../../inference/factory';
import type { DocumentsRouterType } from '../shared';

export const getReferenceLLMContextRoute = createRoute({
  method: 'get',
  path: '/api/documents/{documentId}/references/{referenceId}/llm-context',
  summary: 'Get Reference LLM Context',
  description: 'Get reference with full context for LLM processing',
  tags: ['Documents', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      documentId: z.string(),
      referenceId: z.string(),
    }),
    query: z.object({
      includeSourceContext: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).default(true),
      includeTargetContext: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).default(true),
      contextWindow: z.coerce.number().min(100).max(5000).default(1000),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            reference: z.any(),
            sourceDocument: z.any(),
            targetDocument: z.any().nullable(),
            sourceContext: z.object({
              before: z.string(),
              selection: z.string(),
              after: z.string(),
            }).optional(),
            targetContext: z.object({
              content: z.string(),
              summary: z.string().optional(),
            }).optional(),
            suggestedResolution: z.object({
              documentId: z.string(),
              documentName: z.string(),
              confidence: z.number(),
              reasoning: z.string(),
            }).optional(),
          }),
        },
      },
      description: 'Reference LLM context',
    },
  },
});

export function registerGetReferenceLLMContext(router: DocumentsRouterType) {
  router.openapi(getReferenceLLMContextRoute, async (c) => {
    const { documentId, referenceId } = c.req.valid('param');
    const { includeSourceContext, includeTargetContext, contextWindow } = c.req.valid('query');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    // Get the reference
    const reference = await graphDb.getAnnotation(referenceId);
    if (!reference || reference.target.source !== documentId) {
      throw new HTTPException(404, { message: 'Reference not found' });
    }

    // Get source document
    const sourceDoc = await graphDb.getDocument(documentId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // Get target document if reference is resolved
    const targetDoc = reference.body.referencedDocumentId ?
      await graphDb.getDocument(reference.body.referencedDocumentId) : null;

    // Build source context if requested
    let sourceContext;
    if (includeSourceContext) {
      const sourceContent = await storage.getDocument(documentId);
      const contentStr = sourceContent.toString('utf-8');

      if (reference.target.selector && 'offset' in reference.target.selector) {
        const offset = reference.target.selector.offset as number;
        const length = reference.target.selector.length as number;

        const before = contentStr.slice(Math.max(0, offset - contextWindow), offset);
        const selection = contentStr.slice(offset, offset + length);
        const after = contentStr.slice(offset + length, Math.min(contentStr.length, offset + length + contextWindow));

        sourceContext = { before, selection, after };
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

    return c.json({
      reference,
      sourceDocument: formatDocument(sourceDoc),
      targetDocument: targetDoc ? formatDocument(targetDoc) : null,
      ...(sourceContext ? { sourceContext } : {}),
      ...(targetContext ? { targetContext } : {}),
      ...(suggestedResolution ? { suggestedResolution } : {}),
    });
  });
}