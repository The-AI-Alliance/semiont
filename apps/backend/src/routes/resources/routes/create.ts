/**
 * Create Resource Route
 *
 * Handles binary content upload via multipart/form-data.
 * Writes content to disk first, then emits yield:create with storageUri.
 * Returns 202 with { resourceId } — frontend navigates using the ID
 * and reconciles full state via SSE domain events.
 */

import { HTTPException } from 'hono/http-exception';
import { busLog, userId, baseMediaType, isSupportedMediaType } from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/core';
import { ResourceOperations } from '@semiont/make-meaning';
import { SpanKind, withSpan, withTraceparent } from '@semiont/observability';

type ContentFormat = components['schemas']['ContentFormat'];
type Agent = components['schemas']['Agent'];

export function registerCreateResource(router: ResourcesRouterType) {
  router.post('/resources', async (c) => {
    const user = c.get('user');
    const principalDid = c.get('principalDid');

    if (!user || !principalDid) {
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
    const storageUri = formData.get('storageUri') as string | null;
    const sourceAnnotationId = formData.get('sourceAnnotationId') as string | null;
    const sourceResourceId = formData.get('sourceResourceId') as string | null;
    const generationPrompt = formData.get('generationPrompt') as string | null;
    const generatorStr = formData.get('generator') as string | null;
    const isDraftStr = formData.get('isDraft') as string | null;

    // Validate required fields. storageUri is required: the client names the
    // content's location (the typed PutBinaryRequest.storageUri is required,
    // and every client supplies one), so the server does not invent a path.
    if (!name || !file || !formatRaw || !storageUri) {
      throw new HTTPException(400, {
        message: 'Missing required fields: name, file, format, storageUri'
      });
    }

    // ContentFormat is a free-form string that may carry parameters
    // ("text/plain; charset=iso-8859-1"); admission is gated on the base
    // type's registry membership. Parameters are preserved on the stored
    // format as metadata.
    const formatBase = baseMediaType(formatRaw);
    if (!isSupportedMediaType(formatBase)) {
      throw new HTTPException(400, {
        message: `Unsupported media type: ${formatBase}`,
      });
    }
    const format: ContentFormat = formatRaw;

    busLog('PUT', 'content', {
      name,
      format,
      storageUri,
      sizeBytes: file.size,
    });

    // Tier 2: parent the server span on the client transport's
    // traceparent header (sent by HttpContentTransport.putBinary).
    const traceparent = c.req.header('traceparent');
    const tracestate = c.req.header('tracestate');
    const carrier = traceparent
      ? (tracestate ? { traceparent, tracestate } : { traceparent })
      : undefined;

    const resourceId = await withTraceparent(carrier, () =>
      withSpan(
        'content.put.server',
        async () => {
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
          const stored = await kb.content.store(contentBuffer, storageUri);

          // Delegate to make-meaning for resource creation (via EventBus)
          const eventBus = c.get('eventBus');
          return ResourceOperations.createResource(
            {
              name,
              storageUri,
              contentChecksum: stored.checksum,
              byteSize: stored.byteSize,
              format,
              language: language || undefined,
              entityTypes,
              generatedFrom,
              generationPrompt: generationPrompt || undefined,
              generator,
              isDraft: isDraftStr ? isDraftStr === 'true' : undefined,
            },
            userId(principalDid),
            eventBus,
          );
        },
        {
          kind: SpanKind.SERVER,
          attrs: {
            'content.format': format,
            'content.size_bytes': file.size,
          },
        },
      ),
    );

    return c.json({ resourceId }, 202);
  });
}
