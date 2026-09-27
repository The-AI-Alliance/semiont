/**
 * The Archivist's HTTP surface: the /health probe, the D1 sequence-ranged
 * event read path (EXTRACT-ARCHIVIST P2a), the content read path
 * (SINGLE-KB-MOUNT P3), the recording upload, and the linked-data
 * description (GATEWAY-SIMPLIFY P3).
 *
 * ⚠️ STANDING RULE, load-bearing: **this surface serves the KB tree and
 * each resource's linked-data description, and nothing else.** Every other
 * `browse:*`, and `match:*` and `gather:*`, stay on the bus. The rule's
 * history: exactly one customer, the gateway's SSE resume, until
 * SINGLE-KB-MOUNT D1 (2026-08-29) made the Archivist the knowledge base's
 * storage authority and this surface the way bytes and record reads reach it
 * (D2: bytes ride HTTP, never the bus); then the user's ruling of 2026-09-27
 * on GATEWAY-SIMPLIFY S2 — "(a) Archivist over HTTP" — added the description,
 * so the gateway, which proxies bytes, proxies it too and makes no bus
 * request of its own. An endpoint that is none of these still does not
 * belong here.
 *
 * D1 (settled 2026-08-27): moving the event store out of the gateway breaks
 * `/bus/subscribe`'s `Last-Event-ID` replay, which reads the log in-process
 * (apps/gateway/src/routes/bus.ts). The answer is one narrow call —
 * the events for ONE resource from ONE sequence — which the gateway calls
 * directly:
 *
 *   GET /events/:resourceId?fromSequence=N   (inclusive, like the filter it
 *   mirrors: `queryEvents(rId, { fromSequence })`; the caller does the +1)
 *
 * The gateway proxies bytes and descriptions here —
 *
 *   POST /resources                                 (the client's multipart
 *   upload, forwarded untouched, with the principal the gateway verified in
 *   `Semiont-Principal` and its roles in `Semiont-Roles`: the bytes are
 *   stored `noGit` at their storageUri and the resource is recorded — by the
 *   Stower, or the CloneTokenManager for an upload carrying a clone token —
 *   and the answer is its id. The user's ruling on GATEWAY-SIMPLIFY S3,
 *   2026-09-27: "(a) Archivist records it".)
 *
 *   GET /resources/:id/content                      (the bytes, streamed,
 *   with the media type the record stores; the 404 carries `reason` so the
 *   gateway can serve its two different not-found messages)
 *
 *   GET /resources/:id/jsonld                       (the description: the
 *   descriptor, its annotations, and the annotations that reference it)
 *
 * The principal headers are believed because every path here requires a
 * service account's token: only the fleet's own services call this surface,
 * and they are the ones that verify people.
 *
 * Auth: callers present a token from the knowledge base's trusted issuer
 * carrying the `semiont-service` role — the same credential a sidecar uses to
 * buy an agent token from the gateway. This is a real boundary, not a
 * formality: these paths serve the EVENT LOG and accept BYTE WRITES into the
 * working tree.
 *
 * It used to be a shared static string compared by equality, held by six
 * processes and rotatable only by restarting the stack. With no verifier
 * configured, every path but /health refuses rather than serving
 * unauthenticated: absence fails, it is never a default-open.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { AccessToken, CreateResourceInput, Emitter, Logger, ResourceId, components } from '@semiont/core';
import { resourceId as makeResourceId, userId as makeUserId, errField, hasServiceRole, baseMediaType, isSupportedMediaType } from '@semiont/core';
import type { IssuerVerifier } from '@semiont/core/identity';
import { validators } from '@semiont/core/openapi';

import type { EventLog, ViewStorage } from '@semiont/event-sourcing';
import { RepresentationMissing, type WorkingTreeStore } from '@semiont/content';
import { resolveRepresentation } from './representation';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

/** An upload clone: the bytes are stored, and the token names the resource cloned. */
export interface CloneUploadInput {
  token: string;
  name: string;
  storageUri: string;
  contentChecksum: string;
  byteSize: number;
  format: string;
  archiveOriginal?: boolean;
}

/** What `record` is asked to write, once the bytes are stored. */
export type RecordedUpload =
  | { kind: 'create'; input: CreateResourceInput; emitter: Emitter }
  | { kind: 'clone'; input: CloneUploadInput; emitter: Emitter };

/** A refusal of the request itself — answered 400 with its message. */
class BadUpload extends Error {}

export interface ArchivistServerDeps {
  /** The record's log — the read half only. */
  events: Pick<EventLog, 'queryEvents'>;
  /** The KB tree's byte paths. `register` and the git index stay the
   *  Stower's on event apply; reads go through `resolveRepresentation`. */
  content: Pick<WorkingTreeStore, 'store' | 'retrieveStream'>;
  /** The record's views — the resource half of the one resolution. */
  views: Pick<ViewStorage, 'get'>;
  /** A resource's linked-data description, or undefined when the record holds no such resource. */
  describe: (resourceId: ResourceId) => Promise<GetResourceResponse | undefined>;
  /** Record an upload whose bytes are stored; resolves with the new resource's id, rejects with the record's reason. */
  record: (upload: RecordedUpload) => Promise<ResourceId>;
  /**
   * Verifies caller tokens against the issuer this knowledge base trusts.
   * `null` disables everything but /health, never opens it.
   */
  verifier: IssuerVerifier | null;
  /** Liveness payload for /health — actor states, counters. */
  health: () => Record<string, unknown>;
  logger: Logger;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function createArchivistServer(deps: ArchivistServerDeps): Server {
  const { events, content, views, verifier, describe, record, health, logger } = deps;

  /**
   * The 401 posture every authenticated path shares. True = request may proceed.
   *
   * Every refusal is 401, including "no issuer is configured here". That is
   * deployment state, and a caller who has not proved who they are has not
   * earned it — the same reason the gateway's agent exchange answers one
   * status for every refusal.
   */
  const authorized = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!bearer || !verifier) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    try {
      const claims = await verifier.verify(bearer as AccessToken);
      if (!hasServiceRole(claims)) {
        json(res, 401, { error: 'unauthorized' });
        return false;
      }
    } catch {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  };

  return createServer((req, res) => void (async () => {
    const url = new URL(req.url ?? '/', 'http://archivist');

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, health());
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
      if (!(await authorized(req, res))) return;

      const rawId = decodeURIComponent(url.pathname.slice('/events/'.length));
      const rawFrom = url.searchParams.get('fromSequence');
      const fromSequence = rawFrom === null ? NaN : Number(rawFrom);
      // The seam is sequence-ranged by definition — a missing fromSequence
      // would be a whole-log read, which is the widening this rule forbids.
      if (!rawId || !Number.isInteger(fromSequence) || fromSequence < 1) {
        json(res, 400, { error: 'resourceId path segment and integer fromSequence >= 1 are required' });
        return;
      }

      events.queryEvents(makeResourceId(rawId), { fromSequence })
        .then((replay) => json(res, 200, { events: replay }))
        .catch((error: unknown) => {
          logger.error('D1 read path failed', { resourceId: rawId, fromSequence, error: errField(error) });
          json(res, 500, { error: 'event read failed' });
        });
      return;
    }

    // GET /resources/:id/content — the bytes, streamed, with the media type
    // the record stores. Addressed by resourceId because that is the key the
    // one resolution takes and the key `IContentTransport.getBinary` brings:
    // a caller never converts to a tree address only to have this side
    // convert back. Matched before the `/resources/` prefix is split so a
    // resourceId containing '/' cannot masquerade as another route.
    const contentMatch = req.method === 'GET' && /^\/resources\/(.+)\/content$/.exec(url.pathname);
    if (contentMatch) {
      if (!(await authorized(req, res))) return;

      const rid = decodeURIComponent(contentMatch[1]!);
      resolveRepresentation({ views, content }, makeResourceId(rid))
        .then(async ({ stream, mediaType }) => {
          res.writeHead(200, { 'Content-Type': mediaType });
          // Streamed, never buffered (D7): this process serves content for
          // every reader in the fleet, so its memory is bounded by the chunk.
          await pipeline(stream, res);
        })
        .catch((error: unknown) => {
          if (error instanceof RepresentationMissing) {
            // `reason` rides the wire because the gateway serves two
            // different client-visible messages for these two cases.
            json(res, 404, { error: error.message, reason: error.reason });
            return;
          }
          logger.error('Content read failed', { resourceId: rid, error: errField(error) });
          // A stream that failed mid-flight has already sent 200 and some
          // bytes; destroying the socket is the only honest signal left —
          // a truncated body must not look like a complete one.
          if (res.headersSent) res.destroy();
          else json(res, 500, { error: 'content read failed' });
        });
      return;
    }

    // GET /resources/:id/jsonld — the description. Matched before the
    // `/content` suffix below cannot claim it: both end a resource path.
    const describeMatch = req.method === 'GET' && /^\/resources\/(.+)\/jsonld$/.exec(url.pathname);
    if (describeMatch) {
      if (!(await authorized(req, res))) return;
      const described = await describe(makeResourceId(decodeURIComponent(describeMatch[1]!)));
      if (!described) {
        json(res, 404, { error: 'Resource not found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/ld+json; charset=utf-8' });
      res.end(JSON.stringify(described));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/resources') {
      if (!(await authorized(req, res))) return;
      let upload: RecordedUpload;
      let file: File;
      try {
        ({ upload, file } = await readUpload(req));
      } catch (error) {
        if (error instanceof BadUpload) {
          json(res, 400, { error: error.message });
          return;
        }
        throw error;
      }
      // Streamed from the parsed part: the store hashes as it writes, and the
      // record is asked only once the bytes are in place.
      const stored = await content.store(Readable.fromWeb(file.stream()), upload.input.storageUri, { noGit: true });
      upload.input.contentChecksum = stored.checksum;
      upload.input.byteSize = stored.byteSize;
      try {
        json(res, 200, { resourceId: String(await record(upload)) });
      } catch (error) {
        logger.warn('Upload not recorded', { storageUri: upload.input.storageUri, error: errField(error) });
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    res.writeHead(404);
    res.end();
  })().catch((error: unknown) => {
    // An async handler's rejection has nowhere to go but here: without this the
    // socket would hang and the process would log an unhandled rejection.
    logger.error('Archivist request failed', { error: errField(error) });
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }));
}

/**
 * The upload, read and checked: the multipart fields `POST /resources`
 * declares in the gateway's spec, and the principal the gateway vouches for.
 * Every refusal is a `BadUpload` naming what is wrong. The checksum and size
 * are filled in once the bytes are stored.
 */
async function readUpload(req: IncomingMessage): Promise<{ upload: RecordedUpload; file: File }> {
  const did = req.headers['semiont-principal'];
  if (typeof did !== 'string' || did === '') {
    throw new BadUpload('Semiont-Principal is required: the record attributes every resource to someone');
  }
  const rolesHeader = req.headers['semiont-roles'];
  const emitter: Emitter = {
    did: makeUserId(did),
    roles: typeof rolesHeader === 'string' && rolesHeader !== '' ? rolesHeader.split(',').map((r) => r.trim()) : [],
  };

  let form: FormData;
  try {
    form = await new Request('http://archivist/resources', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
    }).formData();
  } catch {
    throw new BadUpload('The body is not multipart/form-data');
  }
  const text = (field: string): string | undefined => {
    const value = form.get(field);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const json = (field: string): unknown => {
    const value = text(field);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      throw new BadUpload(`${field} is not JSON`);
    }
  };

  const name = text('name');
  const format = text('format');
  const storageUri = text('storageUri');
  const file = form.get('file');
  const missing = [
    ['name', name],
    ['file', file instanceof File ? file : undefined],
    ['format', format],
    ['storageUri', storageUri],
  ].filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0 || !(file instanceof File) || !name || !format || !storageUri) {
    throw new BadUpload(`Missing required fields: ${missing.join(', ')}`);
  }
  // A format may carry parameters ("text/plain; charset=iso-8859-1"); the base
  // type is what must be supported, and the parameters stay on the record.
  const base = baseMediaType(format);
  if (!isSupportedMediaType(base)) throw new BadUpload(`Unsupported media type: ${base}`);

  const common = { name, storageUri, contentChecksum: '', byteSize: 0, format };
  const cloneToken = text('cloneToken');
  if (cloneToken !== undefined) {
    const archiveOriginal = text('archiveOriginal');
    return {
      file,
      upload: { kind: 'clone', emitter, input: { token: cloneToken, ...common, ...(archiveOriginal === undefined ? {} : { archiveOriginal: archiveOriginal === 'true' }) } },
    };
  }

  const entityTypes = json('entityTypes');
  if (entityTypes !== undefined && !isNameList(entityTypes)) {
    throw new BadUpload('entityTypes is not a JSON array of names');
  }
  // One agent: the record binds one generator to the executor.
  const generator = json('generator');
  if (generator !== undefined && !validators.Agent(generator)) {
    throw new BadUpload('generator is not an Agent');
  }
  const sourceResourceId = text('sourceResourceId');
  const sourceAnnotationId = text('sourceAnnotationId');
  const language = text('language');
  const generationPrompt = text('generationPrompt');
  const jobId = text('jobId');
  const isDraft = text('isDraft');
  const input: CreateResourceInput = {
    ...common,
    ...(language === undefined ? {} : { language }),
    ...(entityTypes === undefined ? {} : { entityTypes }),
    ...(sourceResourceId || sourceAnnotationId
      ? { generatedFrom: { ...(sourceResourceId ? { resourceId: sourceResourceId } : {}), ...(sourceAnnotationId ? { annotationId: sourceAnnotationId } : {}) } }
      : {}),
    ...(generationPrompt === undefined ? {} : { generationPrompt }),
    ...(generator === undefined ? {} : { generator }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(isDraft === undefined ? {} : { isDraft: isDraft === 'true' }),
  };
  return { file, upload: { kind: 'create', emitter, input } };
}

const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
