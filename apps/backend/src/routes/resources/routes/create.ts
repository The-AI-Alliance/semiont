/**
 * Create Resource Route
 *
 * Handles binary content upload via multipart/form-data.
 * Writes content to disk first, then emits yield:create with storageUri.
 * Returns 202 with { resourceId } — frontend navigates using the ID
 * and reconciles full state via SSE domain events.
 */

import { HTTPException } from 'hono/http-exception';
import { userId, userToDid, type CreationMethod } from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/core';
import { ResourceOperations } from '@semiont/make-meaning';
import { deriveStorageUri } from '@semiont/content';

type ContentFormat = components['schemas']['ContentFormat'];
type Agent = components['schemas']['Agent'];

export function registerCreateResource(router: ResourcesRouterType) {
  router.post('/resources', async (c) => {
    const user = c.get('user');

    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Parse multipart/form-data
    const formData = await c.req.formData();

    // Extract fields
    const name = formData.get('name') as string;
    const file = formData.get('file') as File;
    const formatRaw = formData.get('format') as string;
    const language = formData.get('language') as string | null;
    const entityTypesStr = formData.get('entityTypes') as string | null;
    const creationMethod = formData.get('creationMethod') as string | null;
    const storageUri = formData.get('storageUri') as string | null;
    const sourceAnnotationId = formData.get('sourceAnnotationId') as string | null;
    const sourceResourceId = formData.get('sourceResourceId') as string | null;
    const generationPrompt = formData.get('generationPrompt') as string | null;
    const generatorStr = formData.get('generator') as string | null;
    const isDraftStr = formData.get('isDraft') as string | null;

    // Validate required fields
    if (!name || !file || !formatRaw) {
      throw new HTTPException(400, {
        message: 'Missing required fields: name, file, format'
      });
    }

    // Type-cast to ContentFormat (OpenAPI validates this enum at spec level)
    const format = formatRaw as ContentFormat;

    // Parse entityTypes from JSON string
    const entityTypes = entityTypesStr ? JSON.parse(entityTypesStr) : [];
    const generator = generatorStr ? (JSON.parse(generatorStr) as Agent | Agent[]) : undefined;

    // Flat HTTP wire → nested bus-command shape. The HTTP form keeps
    // names flat for multipart convenience; the bus/event schema uses
    // nested `generatedFrom` per the W3C prov-style semantics.
    const generatedFrom = (sourceResourceId || sourceAnnotationId)
      ? {
          ...(sourceResourceId ? { resourceId: sourceResourceId } : {}),
          ...(sourceAnnotationId ? { annotationId: sourceAnnotationId } : {}),
        }
      : undefined;

    // Write content to disk before emitting on the bus (no Buffer on bus)
    const arrayBuffer = await file.arrayBuffer();
    const contentBuffer = Buffer.from(arrayBuffer);
    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    const resolvedUri = storageUri || deriveStorageUri(name, format);
    const stored = await kb.content.store(contentBuffer, resolvedUri);

    // Delegate to make-meaning for resource creation (via EventBus)
    const eventBus = c.get('eventBus');
    const resourceId = await ResourceOperations.createResource(
      {
        name,
        storageUri: resolvedUri,
        contentChecksum: stored.checksum,
        byteSize: stored.byteSize,
        format,
        language: language || undefined,
        entityTypes,
        creationMethod: (creationMethod || undefined) as CreationMethod | undefined,
        generatedFrom,
        generationPrompt: generationPrompt || undefined,
        generator,
        isDraft: isDraftStr ? isDraftStr === 'true' : undefined,
      },
      userId(userToDid(user)),
      eventBus,
    );

    return c.json({ resourceId }, 202);
  });
}
