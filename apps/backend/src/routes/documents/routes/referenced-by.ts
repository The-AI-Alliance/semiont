/**
 * Referenced By Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - No request body validation needed (GET route with only path params)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { getGraphDatabase } from '../../../graph/factory';
import { getExactText } from '@semiont/api-client';
import { getTargetSource, getTargetSelector } from '../../../lib/annotation-utils';
import type { DocumentsRouterType } from '../shared';
import type { components } from '@semiont/api-client';

type GetReferencedByResponse = components['schemas']['GetReferencedByResponse'];

export function registerGetReferencedBy(router: DocumentsRouterType) {
  /**
   * GET /api/documents/:id/referenced-by
   *
   * Get documents that reference this document
   * Requires authentication
   * Returns list of documents with references to this document
   */
  router.get('/api/documents/:id/referenced-by', async (c) => {
    const { id } = c.req.param();
    const graphDb = await getGraphDatabase();

    // Get all annotations that reference this document
    const references = await graphDb.getDocumentReferencedBy(id);

    // Get unique documents from the selections
    const docIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
    const documents = await Promise.all(docIds.map(docId => graphDb.getDocument(docId)));

    // Build document map for lookup
    const docMap = new Map(documents.filter(doc => doc !== null).map(doc => [doc.id, doc]));

    // Transform into ReferencedBy structure
    const referencedBy = references.map(ref => {
      const targetSource = getTargetSource(ref.target);
      const targetSelector = getTargetSelector(ref.target);
      const doc = docMap.get(targetSource);
      return {
        id: ref.id,
        documentName: doc?.name || 'Untitled Document',
        target: {
          source: targetSource,
          selector: {
            exact: targetSelector ? getExactText(targetSelector) : '',
          },
        },
      };
    });

    const response: GetReferencedByResponse = {
      referencedBy,
    };

    return c.json(response);
  });
}
