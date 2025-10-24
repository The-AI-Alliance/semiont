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
import { createContentManager } from '../../../services/storage-service';
import { calculateChecksum } from '@semiont/core';
import {
  CREATION_METHODS,
  type CreationMethod,
  type CreateDocumentInput,
} from '@semiont/core';
import type { DocumentsRouterType } from '../shared';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';
import { getFilesystemConfig } from '../../../config/environment-loader';

type GetDocumentByTokenResponse = components['schemas']['GetDocumentByTokenResponse'];
type CreateDocumentFromTokenRequest = components['schemas']['CreateDocumentFromTokenRequest'];
type CreateDocumentFromTokenResponse = components['schemas']['CreateDocumentFromTokenResponse'];
type CloneDocumentWithTokenResponse = components['schemas']['CloneDocumentWithTokenResponse'];
type Document = components['schemas']['Document'];

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
      const contentManager = createContentManager(basePath);

      // Get source document
      const sourceDoc = await graphDb.getDocument(tokenData.documentId);
      if (!sourceDoc) {
        throw new HTTPException(404, { message: 'Source document not found' });
      }

      // Create new document
      const checksum = calculateChecksum(body.content);
      const document: Document = {
        id: Math.random().toString(36).substring(2, 11),
        name: body.name,
        archived: false,
        format: sourceDoc.format,
        entityTypes: sourceDoc.entityTypes || [],

        // Clone context
        creationMethod: CREATION_METHODS.CLONE as CreationMethod,
        sourceDocumentId: tokenData.documentId,
        contentChecksum: checksum,

        creator: userToAgent(user),
        created: new Date().toISOString(),
      };

      const documentId = `doc-sha256:${checksum}`;

      const createInput: CreateDocumentInput & { id: string } = {
        id: documentId,
        name: document.name,
        entityTypes: document.entityTypes,
        content: body.content,
        format: document.format,
        contentChecksum: document.contentChecksum!,
        creator: document.creator!,
        creationMethod: CREATION_METHODS.CLONE,
        sourceDocumentId: document.sourceDocumentId,
      };

      const savedDoc = await graphDb.createDocument(createInput);
      await contentManager.save(documentId, Buffer.from(body.content));

      // Archive original if requested
      if (body.archiveOriginal) {
        await graphDb.updateDocument(tokenData.documentId, {
          archived: true
        });
      }

      // Clean up token
      cloneTokens.delete(body.token);

      // Get annotations
      const result = await graphDb.listAnnotations({ documentId: savedDoc.id });

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
    const contentManager = createContentManager(basePath);

    const sourceDoc = await graphDb.getDocument(id);
    if (!sourceDoc) {
      throw new HTTPException(404, { message: 'Document not found' });
    }

    // Check if content exists
    try {
      await contentManager.get(id);
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
