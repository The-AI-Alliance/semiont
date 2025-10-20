/**
 * Create Document from Annotation Route - Spec-First Version
 *
 * Migrated from code-first to spec-first architecture:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Validates request body with validateRequestBody middleware
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import { getGraphDatabase } from '../../../graph/factory';
import { getStorageService } from '../../../storage/filesystem';
import type { Document, CreateDocumentInput, CreationMethod } from '@semiont/core';
import { CREATION_METHODS } from '@semiont/core';
import { calculateChecksum } from '@semiont/core';
import type { DocumentsRouterType } from '../shared';
import { AnnotationQueryService } from '../../../services/annotation-queries';
import { validateRequestBody } from '../../../middleware/validate-openapi';
import type { components } from '@semiont/api-client';
import { userToAgent } from '../../../utils/id-generator';

type CreateFromAnnotationRequest = components['schemas']['CreateFromAnnotationRequest'];
type CreateFromAnnotationResponse = components['schemas']['CreateFromAnnotationResponse'];

export function registerCreateDocumentFromAnnotation(router: DocumentsRouterType) {
  /**
   * POST /api/documents/from-annotation/:annotationId
   *
   * Create a new document from an annotation/reference
   * Requires authentication
   * Validates request body against CreateFromAnnotationRequest schema
   * Returns 201 with document and annotations
   */
  router.post('/api/documents/from-annotation/:annotationId',
    validateRequestBody('CreateFromAnnotationRequest'),
    async (c) => {
      const { annotationId } = c.req.param();
      const body = c.get('validatedBody') as CreateFromAnnotationRequest;
      const user = c.get('user');
      const graphDb = await getGraphDatabase();
      const storage = getStorageService();

      const annotation = await AnnotationQueryService.getAnnotation(annotationId);
      if (!annotation) {
        throw new HTTPException(404, { message: 'Annotation not found' });
      }

      const checksum = calculateChecksum(body.content);
      const document: Document = {
        id: Math.random().toString(36).substring(2, 11),
        name: body.name,
        archived: false,
        format: body.format,
        entityTypes: annotation.body.entityTypes,
        creationMethod: CREATION_METHODS.REFERENCE as CreationMethod,
        sourceAnnotationId: annotationId,
        sourceDocumentId: annotation.target.source,
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
        creationMethod: CREATION_METHODS.REFERENCE,
        sourceAnnotationId: document.sourceAnnotationId,
        sourceDocumentId: document.sourceDocumentId,
      };

      const savedDoc = await graphDb.createDocument(createInput);
      await storage.saveDocument(documentId, Buffer.from(body.content));

      // Update the annotation to resolve to the new document
      await graphDb.resolveReference(annotationId, savedDoc.id);

      const result = await graphDb.listAnnotations({ documentId: savedDoc.id });

      const response: CreateFromAnnotationResponse = {
        document: savedDoc,
        annotations: result.annotations,
      };

      return c.json(response, 201);
    }
  );
}
