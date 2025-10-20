/**
 * Create Document Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { getStorageService } from '../../../storage/filesystem';
import {
  CREATION_METHODS,
  type CreationMethod,
  calculateChecksum,
} from '@semiont/core';
import type { DocumentsRouterType } from '../shared';
import { getEventStore } from '../../../events/event-store';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';

type CreateDocumentRequest = components['schemas']['CreateDocumentRequest'];
type CreateDocumentResponse = components['schemas']['CreateDocumentResponse'];
type Document = components['schemas']['Document'];

export function registerCreateDocument(router: DocumentsRouterType) {
  /**
   * POST /api/documents
   *
   * Create a new document
   * Requires authentication
   * Validates request body against CreateDocumentRequest schema
   */
  router.post('/api/documents',
    validateRequestBody('CreateDocumentRequest'),
    async (c) => {
      const body = c.get('validatedBody') as CreateDocumentRequest;
      const user = c.get('user');
      const storage = getStorageService();

      const checksum = calculateChecksum(body.content);
      const documentId = `doc-sha256:${checksum}`;

      // Save to filesystem (Layer 1)
      await storage.saveDocument(documentId, Buffer.from(body.content));

      // Subscribe GraphDB consumer to new document BEFORE emitting event
      // This ensures the consumer receives the document.created event
      try {
        const { getGraphConsumer } = await import('../../../events/consumers/graph-consumer');
        const consumer = await getGraphConsumer();
        await consumer.subscribeToDocument(documentId);
      } catch (error) {
        console.error('[CreateDocument] Failed to subscribe GraphDB consumer:', error);
        // Don't fail the request - consumer can catch up later
      }

      // Validate and use creationMethod from request body, or default to API
      const validCreationMethods = Object.values(CREATION_METHODS) as string[];
      const creationMethod: CreationMethod = body.creationMethod && validCreationMethods.includes(body.creationMethod)
        ? body.creationMethod as CreationMethod
        : CREATION_METHODS.API;

      // Emit document.created event (consumer will update GraphDB)
      const eventStore = await getEventStore();
      await eventStore.appendEvent({
        type: 'document.created',
        documentId,
        userId: user.id,
        version: 1,
        payload: {
          name: body.name,
          format: body.format,
          contentHash: checksum,
          creationMethod,
          entityTypes: body.entityTypes,
          metadata: body.locale ? { locale: body.locale } : undefined,
        },
      });

      // Return optimistic response
      const documentMetadata: Document = {
        id: documentId,
        name: body.name,
        archived: false,
        format: body.format,
        entityTypes: body.entityTypes,
        locale: body.locale,
        creationMethod,
        contentChecksum: checksum,
        creator: userToAgent(user),
        created: new Date().toISOString(),
      };

      const response: CreateDocumentResponse = {
        document: documentMetadata,
        annotations: [],
      };

      return c.json(response, 201);
    }
  );
}
