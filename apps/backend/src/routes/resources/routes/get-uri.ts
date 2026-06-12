/**
 * Get Resource URI Route
 *
 * Single endpoint for all resource representations:
 * - Accept: application/ld+json (default) or application/json -> JSON-LD
 *   metadata via EventBus. application/json is itself a registry media type,
 *   but on these routes it keeps its metadata meaning (accepted ambiguity —
 *   .plans/MEDIA-TYPES.md decision 2); a raw JSON representation is fetched
 *   via application/octet-stream instead.
 * - Accept naming any other supported media type, or a wildcard -> the stored
 *   representation: charset-decoded text for registry rows marked 'decode',
 *   verbatim bytes for everything else (images, PDFs, archives, ...).
 * - Accept: application/octet-stream -> stored representation bytes verbatim,
 *   true media type in Content-Type (byte-fidelity mode for checksum
 *   consumers — see .plans/SMELTER-AXIOMS.md, S12)
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import {
  busLog,
  getPrimaryMediaType,
  decodeRepresentation,
  baseMediaType,
  isSupportedMediaType,
  textExtractionOf,
  resourceId,
} from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import { eventBusRequest } from '../../../utils/event-bus-request';
import { getLogger } from '../../../logger';
import { SpanKind, withSpan, withTraceparent } from '@semiont/observability';

const getRouteLogger = () => getLogger().child({ component: 'get-resource-uri' });

// Media types that mean "JSON-LD metadata" on these routes. application/json
// is a registry member, but here it keeps its metadata meaning (accepted
// ambiguity — .plans/MEDIA-TYPES.md decision 2): a raw application/json
// representation cannot be content-negotiated by name; clients fetch it via
// Accept: application/octet-stream.
const METADATA_MEDIA_TYPES = new Set(['application/ld+json', 'application/json']);

// Does the Accept header name the stored representation rather than JSON-LD
// metadata? Registry-driven (big tent): any supported media type asks for the
// representation (Accept: application/zip serves the ZIP; this includes
// application/octet-stream, the verbatim mode), as does any wildcard —
// */* or type wildcards like image/*, which browsers send.
function acceptsRepresentation(acceptHeader: string): boolean {
  return acceptHeader.split(',').some((entry) => {
    const type = baseMediaType(entry);
    if (METADATA_MEDIA_TYPES.has(type)) return false;
    if (type === '*/*' || type.endsWith('/*')) return true;
    return isSupportedMediaType(type);
  });
}

// Registry-driven representation dispatch: only formats the registry says to
// charset-decode take the text path; everything else — images, PDFs,
// archives, unknown binaries — is served verbatim, never mojibake.
// Registry-miss text/* still decodes (RFC 2046); a media type missing from
// the stored metadata is unknowable bytes, served as application/octet-stream.
function serveRepresentation(c: Context, content: Buffer, mediaType: string | undefined) {
  if (mediaType && textExtractionOf(mediaType) === 'decode') {
    return c.text(decodeRepresentation(content, mediaType));
  }
  return c.newResponse(new Uint8Array(content), 200, {
    'Content-Type': mediaType || 'application/octet-stream',
  });
}

export function registerGetResourceUri(router: ResourcesRouterType) {
  // /api/resources/:id — browser-friendly alias used by <img>, PDF.js, etc.
  // Strips JSON-LD/JSON from Accept header so content negotiation always returns
  // raw representations (browsers cannot read httpOnly cookies for auth headers,
  // but the semiont-token cookie is sent automatically). Stripping
  // application/json mirrors the negotiation on /resources/:id, where it means
  // "JSON-LD metadata", never the stored representation — see
  // METADATA_MEDIA_TYPES above.
  router.get('/api/resources/:id', async (c) => {
    const { id } = c.req.param();
    let acceptHeader = c.req.header('Accept') || '*/*';
    acceptHeader = acceptHeader
      .split(',')
      .map(t => t.trim())
      .filter(t => t !== 'application/ld+json' && t !== 'application/json')
      .join(', ') || '*/*';
    busLog('GET', 'content', { resourceId: id, accept: acceptHeader });

    const traceparent = c.req.header('traceparent');
    const tracestate = c.req.header('tracestate');
    const carrier = traceparent
      ? (tracestate ? { traceparent, tracestate } : { traceparent })
      : undefined;

    return withTraceparent(carrier, () =>
      withSpan(
        'content.get.server',
        async () => {
          const { knowledgeSystem: { kb } } = c.get('makeMeaning');

          let resource: any;
          try {
            resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
          } catch {
            throw new HTTPException(500, { message: 'Failed to retrieve resource' });
          }
          if (!resource) throw new HTTPException(404, { message: 'Resource not found' });
          if (!resource.storageUri) throw new HTTPException(404, { message: 'Resource representation not found' });

          const content = await kb.content.retrieve(resource.storageUri);
          if (!content) throw new HTTPException(404, { message: 'Resource representation not found' });

          const mediaType = getPrimaryMediaType(resource);
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          if (mediaType) c.header('Content-Type', mediaType);

          return serveRepresentation(c, content, mediaType);
        },
        {
          kind: SpanKind.SERVER,
          attrs: { 'resource.id': id, 'http.accept': acceptHeader },
        },
      ),
    );
  });

  router.get('/resources/:id', async (c) => {
    const { id } = c.req.param();

    // Check Accept header for content negotiation
    const acceptHeader = c.req.header('Accept') || 'application/ld+json';

    // Verbatim mode: the stored representation's bytes, untouched, with the
    // true media type in Content-Type. For byte-fidelity consumers — the
    // smelter's checksum stamp must hash exactly the bytes the catalog's
    // checksum was computed from (SMELTER-AXIOMS.md, S12), so no charset
    // decode/re-encode is allowed on this path.
    const wantsVerbatim = acceptHeader.includes('application/octet-stream');

    // Raw representation when the Accept header names any supported media
    // type or a wildcard (see acceptsRepresentation); JSON-LD metadata
    // otherwise. Binary content stays direct — excluded from EventBus by design
    if (wantsVerbatim || acceptsRepresentation(acceptHeader)) {
      busLog('GET', 'content', { resourceId: id, accept: acceptHeader });

      const traceparent = c.req.header('traceparent');
      const tracestate = c.req.header('tracestate');
      const carrier = traceparent
        ? (tracestate ? { traceparent, tracestate } : { traceparent })
        : undefined;

      return withTraceparent(carrier, () =>
        withSpan(
          'content.get.server',
          async () => {
            const { knowledgeSystem: { kb } } = c.get('makeMeaning');

            let resource: any;
            try {
              resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
            } catch (error: any) {
              getRouteLogger().error('Failed to get resource metadata', {
                resourceId: id,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
              });
              throw new HTTPException(500, { message: 'Failed to retrieve resource' });
            }

            if (!resource) {
              throw new HTTPException(404, { message: 'Resource not found' });
            }

            if (!resource.storageUri) {
              throw new HTTPException(404, { message: 'Resource representation not found' });
            }

            const content = await kb.content.retrieve(resource.storageUri);
            if (!content) {
              throw new HTTPException(404, { message: 'Resource representation not found' });
            }

            const mediaType = getPrimaryMediaType(resource);
            if (mediaType) {
              c.header('Content-Type', mediaType);
            }

            if (wantsVerbatim) {
              return c.newResponse(new Uint8Array(content), 200, {
                'Content-Type': mediaType || 'application/octet-stream',
              });
            }

            return serveRepresentation(c, content, mediaType);
          },
          {
            kind: SpanKind.SERVER,
            attrs: { 'resource.id': id, 'http.accept': acceptHeader },
          },
        ),
      );
    }

    // JSON-LD metadata path — delegate to EventBus → Gatherer
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:resource-requested',
        { correlationId, resourceId: resourceId(id) },
        'browse:resource-result',
        'browse:resource-failed',
      );

      c.header('Content-Type', 'application/ld+json; charset=utf-8');
      return c.json(response);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Resource not found') {
          throw new HTTPException(404, { message: 'Resource not found' });
        }
        if (error.name === 'TimeoutError') {
          throw new HTTPException(504, { message: 'Request timed out' });
        }
      }
      throw error;
    }
  });
}
