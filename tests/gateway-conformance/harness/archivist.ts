/**
 * A fake Archivist: the knowledge base's record and bytes, over the same
 * HTTP surface the real one serves the gateway
 * (packages/make-meaning/src/archivist-read-path.ts) — the recording upload,
 * byte reads by resource, the linked-data description, and the
 * sequence-ranged event read that backs replay. It checks the caller's token
 * as the real one does (an issuer token carrying the service role) and
 * records every call, so a case can see what the gateway sent it.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { IssuerServer } from './issuer';
import { SERVICE_ROLE } from './roles';
import { spec } from './spec';

export interface StoredEvent {
  type: string;
  metadata: { sequenceNumber: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ArchivistCall {
  method: string;
  path: string;
  claims: JWTPayload | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** An upload the fake stored and recorded: the multipart fields, the file, and who the gateway named. */
export interface RecordedUpload {
  fields: Record<string, string>;
  file: Buffer;
  principal: string | undefined;
  roles: string | undefined;
  resourceId: string;
}

export interface FakeArchivist {
  readonly host: string;
  readonly port: number;
  readonly calls: ArchivistCall[];
  /** Bytes by storageUri, as written. */
  readonly content: Map<string, Buffer>;
  /** What a resource id resolves to: its storageUri and media type. */
  readonly resources: Map<string, { storageUri: string; mediaType: string }>;
  /** The record's events, per resource. */
  readonly events: Map<string, StoredEvent[]>;
  /** Linked-data descriptions, per resource. */
  readonly descriptions: Map<string, unknown>;
  /** Every upload recorded, in order. */
  readonly uploads: RecordedUpload[];
  /** Behaviour switches a case flips. */
  readonly mode: {
    /** Every path answers 503: the Archivist is up and cannot serve. */
    failing: boolean;
    /** The event read waits this long before answering. */
    replayDelayMs: number;
    /** The event read answers 500. */
    replayFails: boolean;
    /** An upload is refused by the record: answered 500 with this reason. */
    refuseUploads: string | undefined;
  };
  close(): Promise<void>;
}

export async function startArchivist(issuer: IssuerServer, audience: string): Promise<FakeArchivist> {
  const calls: ArchivistCall[] = [];
  const content = new Map<string, Buffer>();
  const resources = new Map<string, { storageUri: string; mediaType: string }>();
  const events = new Map<string, StoredEvent[]>();
  const descriptions = new Map<string, unknown>();
  const uploads: RecordedUpload[] = [];
  const mode: FakeArchivist['mode'] = { failing: false, replayDelayMs: 0, replayFails: false, refuseUploads: undefined };
  const supported = new Set(spec().schema('SupportedMediaType')['enum'] as string[]);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const authorize = async (req: IncomingMessage): Promise<JWTPayload | undefined> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    try {
      const { payload } = await jwtVerify(header.slice(7), createLocalJWKSet(issuer.fixture.jwks()), {
        issuer: issuer.origin,
        audience,
      });
      const roles = payload['roles'];
      return Array.isArray(roles) && roles.includes(SERVICE_ROLE) ? payload : undefined;
    } catch {
      return undefined;
    }
  };

  const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://archivist');
      const claims = await authorize(req);
      const call: ArchivistCall = { method: req.method ?? '', path: url.pathname + url.search, claims, headers: req.headers };
      calls.push(call);
      if (!claims) return json(res, 401, { error: 'unauthorized' });
      if (mode.failing) return json(res, 503, { error: 'unavailable on purpose' });

      if (req.method === 'POST' && url.pathname === '/resources') {
        const form = await new Request('http://archivist/resources', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] ?? '' },
          body: new Uint8Array(await readBody(req)),
        }).formData();
        const fields: Record<string, string> = {};
        let file: Buffer | undefined;
        for (const [key, value] of form) {
          if (typeof value === 'string') fields[key] = value;
          else file = Buffer.from(await value.arrayBuffer());
        }
        const missing = ['name', 'format', 'storageUri'].filter((k) => !fields[k]);
        if (!file) missing.splice(1, 0, 'file');
        if (missing.length > 0) return json(res, 400, { error: `Missing required fields: ${missing.join(', ')}` });
        const base = fields['format']!.split(';')[0]!.trim().toLowerCase();
        if (!supported.has(base)) return json(res, 400, { error: `Unsupported media type: ${base}` });
        if (mode.refuseUploads) return json(res, 500, { error: mode.refuseUploads });
        const resourceId = `res-${randomUUID()}`;
        content.set(fields['storageUri']!, file!);
        resources.set(resourceId, { storageUri: fields['storageUri']!, mediaType: fields['format']! });
        const principal = req.headers['semiont-principal'];
        const roles = req.headers['semiont-roles'];
        uploads.push({
          fields,
          file: file!,
          principal: typeof principal === 'string' ? principal : undefined,
          roles: typeof roles === 'string' ? roles : undefined,
          resourceId,
        });
        return json(res, 200, { resourceId });
      }

      const describeMatch = req.method === 'GET' && /^\/resources\/(.+)\/jsonld$/.exec(url.pathname);
      if (describeMatch) {
        const description = descriptions.get(decodeURIComponent(describeMatch[1]!));
        if (description === undefined) return json(res, 404, { error: 'Resource not found' });
        res.writeHead(200, { 'content-type': 'application/ld+json; charset=utf-8' });
        res.end(JSON.stringify(description));
        return;
      }

      const contentMatch = req.method === 'GET' && /^\/resources\/(.+)\/content$/.exec(url.pathname);
      if (contentMatch) {
        const id = decodeURIComponent(contentMatch[1]!);
        const resource = resources.get(id);
        if (!resource) return json(res, 404, { error: 'no such resource', reason: 'resource' });
        const bytes = content.get(resource.storageUri);
        if (!bytes) return json(res, 404, { error: 'no representation', reason: 'representation' });
        res.writeHead(200, { 'content-type': resource.mediaType });
        res.end(bytes);
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
        const id = decodeURIComponent(url.pathname.slice('/events/'.length));
        const from = Number(url.searchParams.get('fromSequence'));
        if (!Number.isInteger(from) || from < 1) return json(res, 400, { error: 'integer fromSequence >= 1 is required' });
        if (mode.replayDelayMs > 0) await new Promise((r) => setTimeout(r, mode.replayDelayMs));
        if (mode.replayFails) return json(res, 500, { error: 'event read failed' });
        return json(res, 200, { events: (events.get(id) ?? []).filter((e) => e.metadata.sequenceNumber >= from) });
      }

      json(res, 404, { error: 'not found' });
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: '127.0.0.1',
    port,
    calls,
    content,
    resources,
    events,
    descriptions,
    uploads,
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A persisted event as the record stores it, for replay. */
export function storedEvent(type: string, resourceId: string, sequenceNumber: number): StoredEvent {
  return {
    type,
    resourceId,
    userId: 'did:web:record.example:users:someone',
    payload: {},
    metadata: { sequenceNumber, timestamp: new Date(0).toISOString() },
  };
}
