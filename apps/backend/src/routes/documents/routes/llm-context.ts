/**
 * Document LLM Context Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Manual query parameter parsing and validation
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { createContentManager } from '../../../services/storage-service';
import { generateDocumentSummary, generateReferenceSuggestions } from '../../../inference/factory';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';

type DocumentLLMContextResponse = components['schemas']['DocumentLLMContextResponse'];

export function registerGetDocumentLLMContext(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/llm-context
   *
   * Get document with full context for LLM processing
   * Includes related documents, annotations, graph representation, and optional summary
   *
   * Query parameters:
   * - depth: 1-3 (default: 2)
   * - maxDocuments: 1-20 (default: 10)
   * - includeContent: true/false (default: true)
   * - includeSummary: true/false (default: false)
   */
  router.get('/api/documents/:id/llm-context', async (c) => {
    const { id } = c.req.param();
    const query = c.req.query();

    // Parse and validate query parameters
    const depth = query.depth ? Number(query.depth) : 2;
    const maxDocuments = query.maxDocuments ? Number(query.maxDocuments) : 10;
    const includeContent = query.includeContent === 'false' ? false : true;
    const includeSummary = query.includeSummary === 'true' ? true : false;

    // Validate depth range
    if (depth < 1 || depth > 3) {
      throw new HTTPException(400, { message: 'Query parameter "depth" must be between 1 and 3' });
    }

    // Validate maxDocuments range
    if (maxDocuments < 1 || maxDocuments > 20) {
      throw new HTTPException(400, { message: 'Query parameter "maxDocuments" must be between 1 and 20' });
    }

    const graphDb = await getGraphDatabase();
    const contentManager = createContentManager();

    const mainDoc = await graphDb.getDocument(id);
    if (!mainDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Get content for main document
    const mainContent = includeContent ?
      (await contentManager.get(id)).toString('utf-8') : undefined;

    // Get related documents through graph connections
    const connections = await graphDb.getDocumentConnections(id);
    const relatedDocs = connections.map(conn => conn.targetDocument);
    const limitedRelatedDocs = relatedDocs.slice(0, maxDocuments - 1);

    // Get content for related documents if requested
    const relatedDocumentsContent: { [id: string]: string } = {};
    if (includeContent) {
      await Promise.all(limitedRelatedDocs.map(async (doc) => {
        try {
          const content = await contentManager.get(doc.id);
          relatedDocumentsContent[doc.id] = content.toString('utf-8');
        } catch {
          // Skip documents where content can't be loaded
        }
      }));
    }

    // Get all annotations for the main document
    const result = await graphDb.listAnnotations({ documentId: id });
    const annotations = result.annotations;

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
      mainDocument: mainDoc,
      relatedDocuments: limitedRelatedDocs,
      annotations,
      graph: { nodes, edges },
      ...(mainContent ? { mainDocumentContent: mainContent } : {}),
      ...(Object.keys(relatedDocumentsContent).length > 0 ? { relatedDocumentsContent } : {}),
      ...(summary ? { summary } : {}),
      ...(suggestedReferences ? { suggestedReferences } : {}),
    };

    return c.json(response);
  });
}
