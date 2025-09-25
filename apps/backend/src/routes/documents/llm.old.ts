import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createDocumentRouter, type DocumentsRouterType } from './shared';
import { formatDocument, formatSelection, detectSelectionsInDocument } from './helpers';
import { DetectSelectionsRequestSchema, DetectSelectionsResponseSchema } from '@semiont/api-contracts';
import { getGraphDatabase } from '../../graph/factory';
import { getStorageService } from '../../storage/filesystem';
import { generateDocumentSummary, generateReferenceSuggestions } from '../../inference/factory';
import type { Document, CreateSelectionInput } from '@semiont/core-types';

// Create router with auth middleware
export const llmRouter: DocumentsRouterType = createDocumentRouter();

// DETECT SELECTIONS
const detectSelectionsRoute = createRoute({
  method: 'post',
  path: '/api/documents/{id}/detect-selections',
  summary: 'Detect Selections',
  description: 'Use AI to detect entity references in document',
  tags: ['Documents', 'AI'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: DetectSelectionsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: DetectSelectionsResponseSchema,
        },
      },
      description: 'Detected selections',
    },
  },
});
llmRouter.openapi(detectSelectionsRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const user = c.get('user');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const document = await graphDb.getDocument(id);
  if (!document) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  const content = await storage.getDocument(id);
  const docWithContent = { ...document, content: content.toString('utf-8') };

  // Detect selections using AI
  const detectedSelections = await detectSelectionsInDocument(docWithContent, body.entityTypes);

  // Save the provisional selections
  const savedSelections = [];
  for (const detected of detectedSelections) {
    const selectionInput: CreateSelectionInput = {
      documentId: id,
      selectionType: detected.selection.selectionType,
      selectionData: detected.selection.selectionData,
      entityTypes: detected.selection.entityTypes,
      provisional: true,
      metadata: detected.selection.metadata,
      createdBy: user.id,
    };
    const saved = await graphDb.createSelection(selectionInput);
    savedSelections.push(saved);
  }

  return c.json({
    detected: savedSelections.map(formatSelection),
  });
});

// GET DOCUMENT LLM CONTEXT
const getDocumentLLMContextRoute = createRoute({
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
          schema: z.object({
            mainDocument: z.any(),
            relatedDocuments: z.array(z.any()),
            selections: z.array(z.any()),
            graph: z.object({
              nodes: z.array(z.object({
                id: z.string(),
                type: z.string(),
                label: z.string(),
                metadata: z.any(),
              })),
              edges: z.array(z.object({
                source: z.string(),
                target: z.string(),
                type: z.string(),
                metadata: z.any(),
              })),
            }),
            summary: z.string().optional(),
            suggestedReferences: z.array(z.object({
              text: z.string(),
              potentialEntity: z.string(),
              confidence: z.number(),
            })).optional(),
          }),
        },
      },
      description: 'LLM context',
    },
  },
});
llmRouter.openapi(getDocumentLLMContextRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { depth, maxDocuments, includeContent, includeSummary } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  const mainDoc = await graphDb.getDocument(id);
  if (!mainDoc) {
    throw new HTTPException(404, { message: 'Document not found' });
  }

  // Get content for main document
  const mainContent = includeContent ?
    (await storage.getDocument(id)).toString('utf-8') : undefined;

  // Get related documents through graph traversal
  const relatedDocs = await graphDb.getConnectedDocuments(id, depth);
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

  // Get all selections for the main document
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

  const connections = await graphDb.getDocumentConnections(id, depth);
  const edges = connections.map(conn => ({
    source: conn.sourceId,
    target: conn.targetId,
    type: conn.connectionType,
    metadata: conn.metadata,
  }));

  // Generate summary if requested
  const summary = includeSummary && mainContent ?
    await generateDocumentSummary(mainContent) : undefined;

  // Generate reference suggestions if we have content
  const suggestedReferences = mainContent ?
    await generateReferenceSuggestions(mainContent) : undefined;

  return c.json({
    mainDocument: {
      ...formatDocument(mainDoc),
      ...(mainContent ? { content: mainContent } : {}),
    },
    relatedDocuments: relatedWithContent.map(formatDocument),
    selections: [...highlights, ...references].map(formatSelection),
    graph: { nodes, edges },
    ...(summary ? { summary } : {}),
    ...(suggestedReferences ? { suggestedReferences } : {}),
  });
});

// GET REFERENCE LLM CONTEXT
const getReferenceLLMContextRoute = createRoute({
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
llmRouter.openapi(getReferenceLLMContextRoute, async (c) => {
  const { documentId, referenceId } = c.req.valid('param');
  const { includeSourceContext, includeTargetContext, contextWindow } = c.req.valid('query');
  const graphDb = await getGraphDatabase();
  const storage = getStorageService();

  // Get the reference
  const reference = await graphDb.getSelection(referenceId);
  if (!reference || reference.documentId !== documentId) {
    throw new HTTPException(404, { message: 'Reference not found' });
  }

  // Get source document
  const sourceDoc = await graphDb.getDocument(documentId);
  if (!sourceDoc) {
    throw new HTTPException(404, { message: 'Source document not found' });
  }

  // Get target document if reference is resolved
  const targetDoc = reference.resolvedDocumentId ?
    await graphDb.getDocument(reference.resolvedDocumentId) : null;

  // Build source context if requested
  let sourceContext;
  if (includeSourceContext) {
    const sourceContent = await storage.getDocument(documentId);
    const contentStr = sourceContent.toString('utf-8');

    if (reference.selectionData && 'offset' in reference.selectionData) {
      const offset = reference.selectionData.offset as number;
      const length = reference.selectionData.length as number;

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
      summary: await generateDocumentSummary(contentStr),
    };
  }

  // TODO: Generate suggested resolution using AI
  const suggestedResolution = undefined;

  return c.json({
    reference: formatSelection(reference),
    sourceDocument: formatDocument(sourceDoc),
    targetDocument: targetDoc ? formatDocument(targetDoc) : null,
    ...(sourceContext ? { sourceContext } : {}),
    ...(targetContext ? { targetContext } : {}),
    ...(suggestedResolution ? { suggestedResolution } : {}),
  });
});