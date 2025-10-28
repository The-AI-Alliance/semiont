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
import { generateDocumentSummary, generateReferenceSuggestions } from '../../../inference/factory';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getResourceId, getPrimaryRepresentation, getEntityTypes } from '../../../utils/resource-helpers';

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
    const basePath = getFilesystemConfig().path;

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
    const repStore = new FilesystemRepresentationStore({ basePath });

    const mainDoc = await graphDb.getDocument(id);
    if (!mainDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Get content for main document
    let mainContent: string | undefined;
    if (includeContent) {
      const primaryRep = getPrimaryRepresentation(mainDoc);
      if (primaryRep?.storageUri) {
        const buffer = await repStore.retrieve(primaryRep.storageUri);
        mainContent = buffer.toString('utf-8');
      }
    }

    // Get related documents through graph connections
    const connections = await graphDb.getDocumentConnections(id);
    const relatedDocs = connections.map(conn => conn.targetDocument);
    const limitedRelatedDocs = relatedDocs.slice(0, maxDocuments - 1);

    // Get content for related documents if requested
    const relatedDocumentsContent: { [id: string]: string } = {};
    if (includeContent) {
      await Promise.all(limitedRelatedDocs.map(async (doc) => {
        try {
          const primaryRep = getPrimaryRepresentation(doc);
          if (primaryRep?.storageUri) {
            const buffer = await repStore.retrieve(primaryRep.storageUri);
            relatedDocumentsContent[getResourceId(doc)] = buffer.toString('utf-8');
          }
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
        id: getResourceId(mainDoc),
        type: 'document',
        label: mainDoc.name,
        metadata: { entityTypes: getEntityTypes(mainDoc) },
      },
      ...limitedRelatedDocs.map(doc => ({
        id: getResourceId(doc),
        type: 'document',
        label: doc.name,
        metadata: { entityTypes: getEntityTypes(doc) },
      })),
    ];

    const edges = connections.map(conn => ({
      source: id,
      target: getResourceId(conn.targetDocument),
      type: conn.relationshipType || 'link',
      metadata: {},
    }));

    // Generate summary if requested
    const summary = includeSummary && mainContent ?
      await generateDocumentSummary(mainDoc.name, mainContent, getEntityTypes(mainDoc)) : undefined;

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
