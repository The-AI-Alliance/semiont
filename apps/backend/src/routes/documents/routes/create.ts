/**
 * Create Document Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import {
  CREATION_METHODS,
  type CreationMethod,
  calculateChecksum,
} from '@semiont/core';
import type { DocumentsRouterType } from '../shared';
import { createEventStore } from '../../../services/event-store-service';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';

type CreateDocumentRequest = components['schemas']['CreateDocumentRequest'];
type CreateDocumentResponse = components['schemas']['CreateDocumentResponse'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

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
      const basePath = getFilesystemConfig().path;
      const repStore = new FilesystemRepresentationStore(basePath);

      const checksum = calculateChecksum(body.content);
      const documentId = `doc-sha256:${checksum}`;

      // Store representation (Layer 1)
      const contentBuffer = Buffer.from(body.content);
      const storedRep = await repStore.store(contentBuffer, {
        mediaType: body.format,
        language: body.language,
        rel: 'original',
      });

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
      const eventStore = await createEventStore(basePath);
      await eventStore.appendEvent({
        type: 'document.created',
        documentId,
        userId: user.id,
        version: 1,
        payload: {
          name: body.name,
          format: body.format,
          contentChecksum: checksum,
          creationMethod,
          entityTypes: body.entityTypes,
          language: body.language,
          isDraft: false,
          generatedFrom: undefined,
          generationPrompt: undefined,
        },
      });

      // Return optimistic response
      const documentMetadata: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': `urn:semiont:resource:${documentId}`,
        name: body.name,
        archived: false,
        entityTypes: body.entityTypes || [],
        creationMethod,
        dateCreated: new Date().toISOString(),
        wasAttributedTo: userToAgent(user),
        representations: [{
          mediaType: body.format,
          checksum: storedRep.checksum,
          storageUri: storedRep.storageUri,
          rel: 'original',
          language: body.language,
          byteSize: storedRep.byteSize,
        }],
      };

      const response: CreateDocumentResponse = {
        document: documentMetadata,
        annotations: [],
      };

      return c.json(response, 201);
    }
  );
}
