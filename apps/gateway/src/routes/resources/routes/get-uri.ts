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
 *   descriptor + annotations + inbound entity references), read from the
 *   Archivist over HTTP like the bytes (GATEWAY-SIMPLIFY S2, the user's
 *   ruling of 2026-09-27: "(a) Archivist over HTTP"). Live data —
 *   Cache-Control: no-cache.
 * No anchored-text face (ANCHORED-TEXT-TO-SMELTER P4): the store is reached
 * over the bus, the Smelter writes it, and the Archivist answers reads.
 *
 * - GET /api/resources/:id — browser-friendly alias of the pipe. Exists only
 *   as the ?token= auth affordance for <img>, PDF.js, and download links,
 *   which cannot carry Authorization headers (bearer + ?token= only — no
 *   cookie, per SDK-AUTH-CORS Phase 3).
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ResourcesRouterType } from '../shared';
import { busLog } from '@semiont/core';
import { describeResource, getContent } from '../../../lib/archivist';
import { SpanKind, withSpan, withTraceparent } from '@semiont/observability';

function traceCarrier(c: Context) {
  const traceparent = c.req.header('traceparent');
  const tracestate = c.req.header('tracestate');
  return traceparent
    ? (tracestate ? { traceparent, tracestate } : { traceparent })
    : undefined;
}

// The pipe: stored bytes, verbatim, stored media type in Content-Type. No
// decode, no transcode — the only decoders live at consumers that want text
// (sdk resourceContent, the viewer hook, the smelter). Streamed rather than
// buffered (D7): the gateway's memory is bounded by the chunk, not by the
// largest representation anyone requests.
function pipeRepresentation(c: Context, body: ReadableStream<Uint8Array>, mediaType: string) {
  return c.newResponse(body, 200, { 'Content-Type': mediaType });
}

// The LD face (FAIR-Signposting / LDP): content responses advertise the
// JSON-LD description's location instead of content-negotiating for it.
function describedByLink(id: string): string {
  return `</resources/${id}/jsonld>; rel="describedby"; type="application/ld+json"`;
}

export function registerGetResourceUri(router: ResourcesRouterType) {
  // GET /resources/:id/jsonld — the JSON-LD description, the Archivist's
  // answer. Hono params don't span '/', so this cannot collide with the pipe
  // route below.
  router.get('/resources/:id/jsonld', async (c) => {
    const { id } = c.req.param();
    // The caller's trace continues into the Archivist read.
    const description = await withTraceparent(traceCarrier(c), () => describeResource(c.get('archivist'), id));
    if (description === undefined) throw new HTTPException(404, { message: 'Resource not found' });
    // Headers passed to c.json directly: Hono's c.json overwrites a prepared
    // content-type (set via c.header) with application/json.
    return c.json(description, 200, {
      'Content-Type': 'application/ld+json; charset=utf-8',
      // Live data: annotations and inbound references change.
      'Cache-Control': 'no-cache',
    });
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
          const { body, mediaType } = await getContent(c.get('archivist'), id);

          // private, not public: this route is bearer-authenticated, and
          // public would let shared caches store and re-serve the bytes
          // without auth (RFC 9111 §3.5; SIMPLER-JSON-LD.md decision 6).
          c.header('Cache-Control', 'private, max-age=31536000, immutable');
          c.header('Link', describedByLink(id));
          return pipeRepresentation(c, body, mediaType);
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
          const { body, mediaType } = await getContent(c.get('archivist'), id);

          // public is safe here, unlike the main route: the ?token= is part
          // of the cache key (SIMPLER-JSON-LD.md decision 6).
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
          c.header('Link', describedByLink(id));
          return pipeRepresentation(c, body, mediaType);
        },
        { kind: SpanKind.SERVER, attrs: { 'resource.id': id } },
      ),
    );
  });
}
