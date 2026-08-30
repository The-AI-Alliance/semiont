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
import { busLog, resourceId, isObject, isString, isNumber, isArray } from '@semiont/core';
import type { ExtractionOutcome } from '@semiont/core';
import { getContent } from '../../../lib/archivist';
import { eventBusRequest } from '../../../utils/event-bus-request';
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

const EXTRACTION_METHODS = new Set(['text-passthrough', 'pdf-text-layer', 'table', 'form', 'ocr']);
const DECLINE_REASONS = new Set(['no-text-layer', 'encrypted', 'corrupt', 'too-large']);
const PDF_CLASSES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

/**
 * `integer` in the schema, not merely `number` — page indices and word counts.
 * Deliberately NOT used for `PdfTextItem` geometry: the spec types every field
 * there (`page` included) as `number`, so requiring integers would make this
 * guard stricter than the contract it enforces.
 */
const isInteger = (value: unknown): value is number => Number.isInteger(value);

/**
 * The anchored-text key is the content checksum of the bytes the map derives
 * from: `calculateChecksum` is `sha256().digest('hex')`, so 64 lowercase hex
 * characters and nothing else.
 *
 * Checked at the route because the store cannot report it. `AnchoredTextStore`
 * refuses a key it cannot shard by logging and returning — "a store that cannot
 * write is still a store", which is the right rule for a cache library whose
 * every failure is a miss. Through a PUT it becomes a lie: 204 tells the
 * producer the map is published while the artifact is permanently absent, and
 * the reconcile diff can never see the hole because nothing was recorded.
 *
 * Lowercase is load-bearing, not pedantry: the store shards on the key's
 * leading characters, so accepting `AB…` as well as `ab…` would file one
 * content identity under two paths.
 */
const CONTENT_CHECKSUM = /^[0-9a-f]{64}$/;

/**
 * Narrow a request body to `ExtractionOutcome` (PERSIST-ANCHORS D1): the
 * anchored text with its provenance, or a named decline.
 *
 * Hand-written rather than schema-driven because the geometry is the point: an
 * item missing `page` or carrying a string `x` would be stored happily and then
 * place an annotation rectangle nowhere, discovered much later by a reader who
 * cannot tell a bad write from a bad recognizer.
 */
function isExtractionOutcome(value: unknown): value is ExtractionOutcome {
  if (!isObject(value)) return false;
  if (value.kind === 'declined') return isString(value.declined) && DECLINE_REASONS.has(value.declined);
  if (value.kind !== 'extracted') return false;
  if (!isString(value.text) || !isArray(value.items)) return false;
  if (!isString(value.method) || !EXTRACTION_METHODS.has(value.method)) return false;
  if (value.pdfClass !== undefined && !(isString(value.pdfClass) && PDF_CLASSES.has(value.pdfClass))) return false;
  if (value.ocrConfidence !== undefined) {
    const c = value.ocrConfidence;
    if (!isObject(c) || !isNumber(c.mean) || !isInteger(c.lowConfidenceWords) || !isInteger(c.totalWords)) return false;
  }
  if (value.unreadPages !== undefined && !(isArray(value.unreadPages) && value.unreadPages.every(isInteger))) return false;
  return value.items.every((item) =>
    isObject(item)
    && isNumber(item.start) && isNumber(item.end) && isNumber(item.page)
    && isNumber(item.x) && isNumber(item.y)
    && isNumber(item.width) && isNumber(item.height));
}

export function registerGetResourceUri(router: ResourcesRouterType) {
  // PUT /anchored-text/:checksum — publish a derived coordinate map, keyed by
  // the content checksum of the bytes it was derived from (PERSIST-ANCHORS
  // decision A). The producer supplies the checksum because it alone knows
  // which bytes it read — deriving the key server-side from the resource's
  // CURRENT representation would file old geometry under a new checksum when
  // a byte change races the publish, and that entry would read as "present"
  // to the reconcile diff forever.
  //
  // The Smelter is the sole producer: it is the only process that reads a
  // representation's bytes at ingest, so it is the only one positioned to
  // derive a map cheaply. It runs separately from the backend, which is why
  // this crosses HTTP at all rather than writing the store directly the way
  // an in-process caller does.
  //
  // **Agents only.** A map is derived data every consumer trusts to place
  // annotation geometry; letting a browser session write one would let a user
  // poison where quotes land for everyone reading that document. `principalDid`
  // deliberately erases the human/software distinction, so this checks
  // `agentDid` instead.
  router.put('/anchored-text/:checksum', async (c) => {
    if (!c.get('agentDid')) {
      throw new HTTPException(403, { message: 'Only an agent may publish anchored text' });
    }

    const { checksum } = c.req.param();
    if (!CONTENT_CHECKSUM.test(checksum)) {
      throw new HTTPException(400, { message: 'Path segment must be a content checksum: 64 lowercase hex characters' });
    }
    const body: unknown = await c.req.json().catch(() => null);
    if (!isExtractionOutcome(body)) {
      throw new HTTPException(400, { message: 'Body must be an ExtractionOutcome: { text, items[], method, … } or { declined }' });
    }

    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    await kb.anchoredText.write(checksum, body);
    // 204: there is nothing to return, and the caller already holds the map.
    return c.body(null, 204);
  });

  // GET /anchored-text/keys — the store's would-hit keys, straight from the
  // store like the PUT above (no bus gateway, no settle barrier): this is the
  // reconcile planner's bulk existence read (PERSIST-ANCHORS P0), asking
  // presence rather than content at a moment. Agents only — projection-
  // maintenance planning data, the same trust boundary as publishing a map.
  router.get('/anchored-text/keys', async (c) => {
    if (!c.get('agentDid')) {
      throw new HTTPException(403, { message: 'Only an agent may list anchored-text keys' });
    }

    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    return c.json({ keys: await kb.anchoredText.list() }, 200, { 'Cache-Control': 'no-cache' });
  });

  // GET /anchored-text/:checksum — the cache-consult read (PERSIST-ANCHORS
  // P2c): the extraction seam asks "has this exact byte content already been
  // extracted?", and every cache consumer runs out of process (the smelter
  // worker, the detection workers), so the consult must cross the wire or
  // the cache is write-only from exactly the processes it exists to serve.
  //
  // Straight store read, no settle barrier: presence at this instant is the
  // question — the same semantics as the keys listing above. The barrier
  // belongs to the resource-addressed GET below, which resolves a mutable
  // pointer through the view index; a caller holding the checksum already
  // holds the content identity. Agents only, same trust boundary as the PUT.
  //
  // Registered AFTER /anchored-text/keys so the static segment wins —
  // though a 'keys' checksum would miss harmlessly anyway.
  router.get('/anchored-text/:checksum', async (c) => {
    if (!c.get('agentDid')) {
      throw new HTTPException(403, { message: 'Only an agent may read anchored text by checksum' });
    }

    const { checksum } = c.req.param();
    if (!CONTENT_CHECKSUM.test(checksum)) {
      throw new HTTPException(400, { message: 'Path segment must be a content checksum: 64 lowercase hex characters' });
    }
    const { knowledgeSystem: { kb } } = c.get('makeMeaning');
    const outcome = await kb.anchoredText.read(checksum);
    if (outcome === null) {
      return c.body(null, 204, { 'Cache-Control': 'no-cache' });
    }
    return c.json(outcome, 200, { 'Cache-Control': 'no-cache' });
  });

  // GET /resources/:id/anchored-text — the derived coordinate map, via the bus
  // gateway. Reading never derives: the map is written only by the PUT above,
  // and only by an agent, so no reader can provoke extraction from here.
  //
  // "No map" is the common answer and is a 204, not a 404 — a fact about
  // extraction, not a missing route. It is carried as an empty body rather
  // than a JSON `null` body because a typed client cannot represent the
  // difference: oapi-codegen unmarshals a 200 into `var dest AnchoredText`,
  // and `null` into a struct is a documented no-op in encoding/json, so
  // `JSON200` would come back non-nil pointing at a zero value. "No map" and
  // "an empty map" would be the same answer. With 204 no case matches, the
  // field stays nil, and nil means what it should.
  router.get('/resources/:id/anchored-text', async (c) => {
    const { id } = c.req.param();
    const eventBus = c.get('eventBus');
    const correlationId = crypto.randomUUID();

    try {
      const response = await eventBusRequest(
        eventBus,
        'browse:anchored-text-requested',
        { correlationId, resourceId: id },
        'browse:anchored-text-result',
        'browse:anchored-text-failed',
      );
      if (response === null || response === undefined) {
        return c.body(null, 204, { 'Cache-Control': 'no-cache' });
      }
      return c.json(response, 200, { 'Cache-Control': 'no-cache' });
    } catch (error) {
      if (error instanceof Error && error.message === 'Resource not found') {
        throw new HTTPException(404, { message: 'Resource not found' });
      }
      throw error;
    }
  });

  // GET /resources/:id/jsonld — the JSON-LD description, via
  // `browse:resource-requested`. Hono params don't span '/', so this cannot
  // collide with the pipe route below.
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
          const { body, mediaType } = await getContent(c.get('config'), id);

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
          const { body, mediaType } = await getContent(c.get('config'), id);

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
