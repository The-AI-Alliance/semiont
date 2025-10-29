/**
 * Token Routes - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request bodies with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import {
  CREATION_METHODS,
  generateUuid,
} from '@semiont/core';
import type { DocumentsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
import { getFilesystemConfig } from '../../../config/environment-loader';
import { FilesystemRepresentationStore } from '../../../storage/representation/representation-store';
import { getPrimaryRepresentation, getResourceId, getEntityTypes } from '../../../utils/resource-helpers';

type GetDocumentByTokenResponse = components['schemas']['GetDocumentByTokenResponse'];
type CreateDocumentFromTokenRequest = components['schemas']['CreateDocumentFromTokenRequest'];
type CreateDocumentFromTokenResponse = components['schemas']['CreateDocumentFromTokenResponse'];
type CloneDocumentWithTokenResponse = components['schemas']['CloneDocumentWithTokenResponse'];

// Simple in-memory token store (replace with Redis/DB in production)
const cloneTokens = new Map<string, { documentId: string; expiresAt: Date }>();

export function registerTokenRoutes(router: DocumentsRouterType) {
  /**
   * GET /api/documents/token/:token
   *
   * Retrieve a document using a clone token
   * Requires authentication
   */
  router.get('/api/documents/token/:token', async (c) => {
    const { token } = c.req.param();

    const tokenData = cloneTokens.get(token);
    if (!tokenData) {
      throw new HTTPException(404, { message: 'Invalid or expired token' });
    }

    if (new Date() > tokenData.expiresAt) {
      cloneTokens.delete(token);
      throw new HTTPException(404, { message: 'Token expired' });
    }

    const graphDb = await getGraphDatabase();
    const sourceDoc = await graphDb.getDocument(tokenData.documentId);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Source document not found' });
    }

    // NOTE: Content is NOT included - frontend should fetch via GET /documents/:id/content

    const response: GetDocumentByTokenResponse = {
      sourceDocument: sourceDoc,
      expiresAt: tokenData.expiresAt.toISOString(),
    };

    return c.json(response);
  });

  /**
   * POST /api/documents/create-from-token
   *
   * Create a new document using a clone token
   * Requires authentication
   * Validates request body against CreateDocumentFromTokenRequest schema
   */
  router.post('/api/documents/create-from-token',
    validateRequestBody('CreateDocumentFromTokenRequest'),
    async (c) => {
      const body = c.get('validatedBody') as CreateDocumentFromTokenRequest;
      const user = c.get('user');
      const basePath = getFilesystemConfig().path;

      const tokenData = cloneTokens.get(body.token);
      if (!tokenData) {
        throw new HTTPException(404, { message: 'Invalid or expired token' });
      }

      if (new Date() > tokenData.expiresAt) {
        cloneTokens.delete(body.token);
        throw new HTTPException(404, { message: 'Token expired' });
      }

      const graphDb = await getGraphDatabase();
      const repStore = new FilesystemRepresentationStore({ basePath });

      // Get source document
      const sourceDoc = await graphDb.getDocument(tokenData.documentId);
      if (!sourceDoc) {
        throw new HTTPException(404, { message: 'Source document not found' });
      }

      // Create new document
      const documentId = generateUuid();

      // Get source format and validate it's a supported ContentFormat
      const primaryRep = getPrimaryRepresentation(sourceDoc);
      const mediaType = primaryRep?.mediaType || 'text/plain';

      // Validate mediaType is a supported ContentFormat (validation at periphery)
      const validFormats = ['text/plain', 'text/markdown'] as const;
      const format: 'text/plain' | 'text/markdown' = validFormats.includes(mediaType as any)
        ? (mediaType as 'text/plain' | 'text/markdown')
        : 'text/plain';

      // Store representation
      const storedRep = await repStore.store(Buffer.from(body.content), {
        mediaType: format,
        rel: 'original',
      });

      const document: ResourceDescriptor = {
        '@context': 'https://schema.org/',
        '@id': `http://localhost:4000/documents/${documentId}`,
        name: body.name,
        entityTypes: getEntityTypes(sourceDoc),
        representations: [{
          mediaType: format,
          checksum: storedRep.checksum,
          rel: 'original',
        }],
        archived: false,
        dateCreated: new Date().toISOString(),
        wasAttributedTo: userToAgent(user),
        creationMethod: CREATION_METHODS.CLONE,
        sourceDocumentId: getResourceId(sourceDoc),
      };

      const savedDoc = await graphDb.createDocument(document);

      // Store representation
      await repStore.store(Buffer.from(body.content), {
        mediaType: format,
        rel: 'original',
      });

      // Archive original if requested
      if (body.archiveOriginal) {
        await graphDb.updateDocument(tokenData.documentId, {
          archived: true
        });
      }

      // Clean up token
      cloneTokens.delete(body.token);

      // Get annotations
      const result = await graphDb.listAnnotations({ documentId: getResourceId(savedDoc) });

      const response: CreateDocumentFromTokenResponse = {
        document: savedDoc,
        annotations: result.annotations,
      };

      return c.json(response, 201);
    }
  );

  /**
   * POST /api/documents/:id/clone-with-token
   *
   * Generate a temporary token for cloning a document
   * Requires authentication
   */
  router.post('/api/documents/:id/clone-with-token', async (c) => {
    const { id } = c.req.param();
    const basePath = getFilesystemConfig().path;
    const graphDb = await getGraphDatabase();
    const repStore = new FilesystemRepresentationStore({ basePath });

    const sourceDoc = await graphDb.getDocument(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Check if content exists
    const primaryRep = getPrimaryRepresentation(sourceDoc);
    if (!primaryRep?.checksum || !primaryRep?.mediaType) {
      throw new HTTPException(404, { message: 'Document content not found' });
    }

    try {
      await repStore.retrieve(primaryRep.checksum, primaryRep.mediaType);
    } catch {
      throw new HTTPException(404, { message: 'Document content not found' });
    }

    // Create token
    const token = `clone_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    cloneTokens.set(token, {
      documentId: id,
      expiresAt,
    });

    const response: CloneDocumentWithTokenResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      document: sourceDoc,
    };

    return c.json(response);
  });
}
