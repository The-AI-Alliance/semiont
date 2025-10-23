/**
 * Update Document Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import { DocumentQueryService } from '../../../services/document-queries';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { extractEntityTypes } from '../../../graph/annotation-body-utils';

type UpdateDocumentRequest = components['schemas']['UpdateDocumentRequest'];
type GetDocumentResponse = components['schemas']['GetDocumentResponse'];

export function registerUpdateDocument(router: DocumentsRouterType) {
  /**
   * PATCH /api/documents/:id
   *
   * Update document metadata (append-only operations - name and content are immutable)
   * Requires authentication
   * Validates request body against UpdateDocumentRequest schema
   */
  router.patch('/api/documents/:id',
    validateRequestBody('UpdateDocumentRequest'),
    async (c) => {
      const { id } = c.req.param();
      const body = c.get('validatedBody') as UpdateDocumentRequest;
      const user = c.get('user');

      // Check document exists using Layer 3
      const doc = await DocumentQueryService.getDocumentMetadata(id);
      if (!doc) {
        throw new HTTPException(404, { message: 'Document not found' });
      }

      const eventStore = await getEventStore();

      // Emit archived/unarchived events (event store updates Layer 3, graph consumer updates Layer 4)
      if (body.archived !== undefined && body.archived !== doc.archived) {
        if (body.archived) {
          await eventStore.appendEvent({
            type: 'document.archived',
            documentId: id,
            userId: user.id,
            version: 1,
            payload: {
              reason: undefined,
            },
          });
        } else {
          await eventStore.appendEvent({
            type: 'document.unarchived',
            documentId: id,
            userId: user.id,
            version: 1,
            payload: {},
          });
        }
      }

      // Emit entity tag change events (event store updates Layer 3, graph consumer updates Layer 4)
      if (body.entityTypes && doc.entityTypes) {
        const added = body.entityTypes.filter((et: string) => !doc.entityTypes.includes(et));
        const removed = doc.entityTypes.filter((et: string) => !body.entityTypes!.includes(et));

        for (const entityType of added) {
          await eventStore.appendEvent({
            type: 'entitytag.added',
            documentId: id,
            userId: user.id,
            version: 1,
            payload: {
              entityType,
            },
          });
        }
        for (const entityType of removed) {
          await eventStore.appendEvent({
            type: 'entitytag.removed',
            documentId: id,
            userId: user.id,
            version: 1,
            payload: {
              entityType,
            },
          });
        }
      }

      // Read annotations from Layer 3
      const annotations = await AnnotationQueryService.getAllAnnotations(id);
      const entityReferences = annotations.filter(a => {
        if (a.motivation !== 'linking') return false;
        const entityTypes = extractEntityTypes(a.body);
        return entityTypes.length > 0;
      });

      // Return optimistic response (content NOT included - must be fetched separately)
      const response: GetDocumentResponse = {
        document: {
          ...doc,
          archived: body.archived !== undefined ? body.archived : doc.archived,
          entityTypes: body.entityTypes !== undefined ? body.entityTypes : doc.entityTypes,
        },
        annotations,
        entityReferences,
      };

      return c.json(response);
    }
  );
}
