/**
 * Get Resource URI Routes
 *
 * Pure pipe + dereferenceable description (.plans/SIMPLER-JSON-LD.md):
 *
 * - GET /resources/:id — the stored representation's bytes, verbatim, with
 *   the stored media type in Content-Type (application/octet-stream when
 *   unknown). The Accept header is never read: no content negotiation, no
 *   transcoding, so byte fidelity (SMELTER-AXIOMS.md, S12) holds on every
 *   response. A Link: rel="describedby" header points machine clients at
 *   the JSON-LD description.
 * - GET /resources/:id/jsonld — the JSON-LD description (GetResourceResponse:
 *   descriptor + annotations + inbound entity references) via the bus
 *   gateway. Live data — Cache-Control: no-cache.
 * - GET /api/resources/:id — browser-friendly alias of the pipe. Exists only
 *   as the ?token= auth affordance for <img>, PDF.js, and download links,
 *   which cannot carry Authorization headers (bearer + ?token= only — no
 *   cookie, per SDK-AUTH-CORS Phase 3).
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { busLog, getPrimaryMediaType, resourceId } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
import { ResourceContext } from '@semiont/make-meaning';
import type { KnowledgeBase } from '@semiont/make-meaning';
import { eventBusRequest } from '../../../utils/event-bus-request';
import { getLogger } from '../../../logger';
import { SpanKind, withSpan, withTraceparent } from '@semiont/observability';

const getRouteLogger = () => getLogger().child({ component: 'get-resource-uri' });

function traceCarrier(c: Context) {
  const traceparent = c.req.header('traceparent');
  const tracestate = c.req.header('tracestate');
  return traceparent
    ? (tracestate ? { traceparent, tracestate } : { traceparent })
    : undefined;
}

/** Metadata lookup + existence checks + content retrieval for the pipe. */
async function loadRepresentation(
  id: string,
  kb: KnowledgeBase,
): Promise<{ content: Buffer; mediaType: string | undefined }> {
  let resource: ResourceDescriptor | null;
  try {
    resource = await ResourceContext.getResourceMetadata(resourceId(id), kb);
  } catch (error) {
    getRouteLogger().error('Failed to get resource metadata', {
      resourceId: id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
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
  return { content, mediaType: getPrimaryMediaType(resource) };
}

// The pipe: stored bytes, verbatim, stored media type in Content-Type. No
// decode, no transcode — the only decoders live at consumers that want text
// (sdk resourceContent, the viewer hook, the smelter).
function pipeRepresentation(c: Context, content: Buffer, mediaType: string | undefined) {
  return c.newResponse(new Uint8Array(content), 200, {
    'Content-Type': mediaType || 'application/octet-stream',
  });
}

// The LD face (FAIR-Signposting / LDP): content responses advertise the
// JSON-LD description's location instead of content-negotiating for it.
function describedByLink(id: string): string {
  return `</resources/${id}/jsonld>; rel="describedby"; type="application/ld+json"`;
}

export function registerGetResourceUri(router: ResourcesRouterType) {
  // GET /resources/:id/jsonld — the JSON-LD description, via the bus
  // gateway (Gatherer). Hono params don't span '/', so this cannot collide
  // with the pipe route below.
  router.get('/resources/:id/jsonld', async (c) => {
    const { id } = c.req.param();
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

      // Headers passed to c.json directly: Hono's c.json overwrites a
      // prepared content-type (set via c.header) with application/json.
      return c.json(response, 200, {
        'Content-Type': 'application/ld+json; charset=utf-8',
        // Live data: annotations and inbound references change.
        'Cache-Control': 'no-cache',
      });
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

  // GET /resources/:id — the pipe. Accept is never read; the JSON-LD
  // description lives at the /jsonld subpath, advertised by the Link header.
  router.get('/resources/:id', async (c) => {
    const { id } = c.req.param();
    busLog('GET', 'content', { resourceId: id });

    return withTraceparent(traceCarrier(c), () =>
      withSpan(
        'content.get.server',
        async () => {
          const { knowledgeSystem: { kb } } = c.get('makeMeaning');
          const { content, mediaType } = await loadRepresentation(id, kb);

          // private, not public: this route is bearer-authenticated, and
          // public would let shared caches store and re-serve the bytes
          // without auth (RFC 9111 §3.5; SIMPLER-JSON-LD.md decision 6).
          c.header('Cache-Control', 'private, max-age=31536000, immutable');
          c.header('Link', describedByLink(id));
          return pipeRepresentation(c, content, mediaType);
        },
        { kind: SpanKind.SERVER, attrs: { 'resource.id': id } },
      ),
    );
  });

  // GET /api/resources/:id — browser-friendly alias of the pipe. Exists
  // only as the auth affordance for <img>, PDF.js, and download links:
  // browsers cannot attach Authorization headers there, so they pass a
  // short-lived, resource-scoped media token via ?token= (the middleware
  // checks it first; see middleware/auth.ts). Auth is bearer + ?token= only —
  // no cookie (SDK-AUTH-CORS Phase 3).
  // (Folding the alias into /resources/:id is an auth-design question —
  // out of scope; see .plans/SIMPLER-JSON-LD.md §3.)
  router.get('/api/resources/:id', async (c) => {
    const { id } = c.req.param();
    busLog('GET', 'content', { resourceId: id });

    return withTraceparent(traceCarrier(c), () =>
      withSpan(
        'content.get.server',
        async () => {
          const { knowledgeSystem: { kb } } = c.get('makeMeaning');
          const { content, mediaType } = await loadRepresentation(id, kb);

          // public is safe here, unlike the main route: the ?token= is part
          // of the cache key (SIMPLER-JSON-LD.md decision 6).
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          c.header('Link', describedByLink(id));
          return pipeRepresentation(c, content, mediaType);
        },
        { kind: SpanKind.SERVER, attrs: { 'resource.id': id } },
      ),
    );
  });
}
