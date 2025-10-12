import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import { generateDocumentSummary, generateReferenceSuggestions } from '../../../inference/factory';
import type { DocumentsRouterType } from '../shared';
import {
  DocumentLLMContextResponseSchema as DocumentLLMContextResponseSchema,
  type DocumentLLMContextResponse,
} from '@semiont/sdk';


export const getDocumentLLMContextRoute = createRoute({
  method: 'get',
  path: '/api/documents/{id}/llm-context',
  summary: 'Get Document LLM Context',
  description: 'Get document with full context for LLM processing',
  tags: ['Documents', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: z.object({
      depth: z.coerce.number().min(1).max(3).default(2),
      maxDocuments: z.coerce.number().min(1).max(20).default(10),
      includeContent: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).default(true),
      includeSummary: z.union([
        z.literal('true').transform(() => true),
        z.literal('false').transform(() => false),
        z.boolean()
      ]).default(false),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DocumentLLMContextResponseSchema as any,
        },
      },
      description: 'LLM context',
    },
  },
});

export function registerGetDocumentLLMContext(router: DocumentsRouterType) {
  router.openapi(getDocumentLLMContextRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { maxDocuments, includeContent, includeSummary } = c.req.valid('query');
    const graphDb = await getGraphDatabase();
    const storage = getStorageService();

    const mainDoc = await graphDb.getDocument(id);
    if (!mainDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Get content for main document
    const mainContent = includeContent ?
      (await storage.getDocument(id)).toString('utf-8') : undefined;

    // Get related documents through graph connections
    const connections = await graphDb.getDocumentConnections(id);
    const relatedDocs = connections.map(conn => conn.targetDocument);
    const limitedRelatedDocs = relatedDocs.slice(0, maxDocuments - 1);

    // Get content for related documents if requested
    const relatedWithContent = includeContent ?
      await Promise.all(limitedRelatedDocs.map(async (doc) => {
        try {
          const content = await storage.getDocument(doc.id);
          return { ...doc, content: content.toString('utf-8') };
        } catch {
          return doc;
        }
      })) : limitedRelatedDocs;

    // Get all annotations for the main document
    const highlights = await graphDb.getHighlights(id);
    const references = await graphDb.getReferences(id);

    // Build graph representation
    const nodes = [
      {
        id: mainDoc.id,
        type: 'document',
        label: mainDoc.name,
        metadata: { entityTypes: mainDoc.entityTypes },
      },
      ...limitedRelatedDocs.map(doc => ({
        id: doc.id,
        type: 'document',
        label: doc.name,
        metadata: { entityTypes: doc.entityTypes },
      })),
    ];

    const edges = connections.map(conn => ({
      source: id,
      target: conn.targetDocument.id,
      type: conn.relationshipType || 'link',
      metadata: {},
    }));

    // Generate summary if requested
    const summary = includeSummary && mainContent ?
      await generateDocumentSummary(mainDoc.name, mainContent, mainDoc.entityTypes || []) : undefined;

    // Generate reference suggestions if we have content
    const suggestedReferences = mainContent ?
      await generateReferenceSuggestions(mainContent) : undefined;

    const response: DocumentLLMContextResponse = {
      mainDocument: {
        ...mainDoc,
        ...(mainContent ? { content: mainContent } : {}),
      },
      relatedDocuments: relatedWithContent,
      annotations: [...highlights, ...references],
      graph: { nodes, edges },
      ...(summary ? { summary } : {}),
      ...(suggestedReferences ? { suggestedReferences } : {}),
    };

    return c.json(response);
  });
}