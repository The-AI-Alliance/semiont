/**
 * A stand-in Archivist: the knowledge base's record and bytes, over the HTTP
 * surface the Archivist serves (`specs/src/archivist/openapi.json`) — the
 * recording upload, byte reads by resource, the linked-data description, and
 * the sequence-ranged event read that backs replay. It checks the caller's
 * token as the real one does (an issuer token carrying the service role) and
 * records every call, so a case can see what the gateway sent it.
 *
 * It is held to the Archivist's spec, as the real Archivist's own tests are:
 * every request the gateway sends must be a declared operation carrying what
 * the operation requires, and every reply the stand-in gives must match its
 * declaration. Anything else lands in `violations`, which fail the case.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { archivistNonConformance } from './http';
import type { IssuerServer } from './issuer';
import { SERVICE_ROLE } from './roles';
import { archivistSpec, errorsOf, spec, type Method } from './spec';

/** A persisted event, as `StoredEventResponse` states it. */
export interface StoredEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  resourceId: string;
  version: number;
  payload: Record<string, unknown>;
  metadata: { sequenceNumber: number };
}

export interface ArchivistCall {
  method: string;
  path: string;
  claims: JWTPayload | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** An upload the stand-in stored and recorded: the multipart fields, the file, and who the gateway named. */
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
  /** Everything the gateway or the stand-in did outside the Archivist's spec. */
  readonly violations: string[];
  /** Bytes by storageUri, as written. */
  readonly content: Map<string, Buffer>;
  /** Where a resource's bytes are, and their media type. */
  readonly resources: Map<string, { storageUri: string; mediaType: string }>;
  /** The record's events, per resource. */
  readonly events: Map<string, StoredEvent[]>;
  /** Linked-data descriptions, per resource. */
  readonly descriptions: Map<string, unknown>;
  /** Every upload recorded, in order. */
  readonly uploads: RecordedUpload[];
  /** Behaviour switches a case flips. */
  readonly mode: {
    /** Every token is refused: the gateway's service account has lost the Archivist. */
    refusesGateway: boolean;
    /** The event read waits this long before answering. */
    replayDelayMs: number;
    /** The event read answers 500. */
    replayFails: boolean;
    /**
     * The event read answers this body instead, whatever it is — for a case
     * that needs the Archivist to answer outside its spec. It lands in
     * `violations` like any off-spec reply; the case expects that, and clears it.
     */
    replayAnswer: unknown;
    /** An upload is refused by the record: answered 500 with this reason. */
    refuseUploads: string | undefined;
  };
  close(): Promise<void>;
}

interface Operation {
  method: Method;
  path: string;
  pattern: RegExp;
  op: Record<string, unknown>;
}

/** The Archivist's operations, each with a pattern its concrete paths match. */
function operations(): Operation[] {
  return archivistSpec()
    .operations()
    .map(({ method, path, op }) => ({ method, path, op, pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '([^/]+)')}$`) }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the operation requires of a request that the gateway, not its client, controls: its parameters. */
function requestProblems(operation: Operation, req: IncomingMessage, url: URL): string[] {
  const where = `the gateway's ${operation.method.toUpperCase()} ${url.pathname}`;
  const problems: string[] = [];
  const parameters = Array.isArray(operation.op['parameters']) ? operation.op['parameters'] : [];
  for (const parameter of parameters) {
    const p = archivistSpec().deref(parameter as never);
    if (!isRecord(p) || typeof p['name'] !== 'string') continue;
    const name = p['name'];
    const value = p['in'] === 'header' ? req.headers[name.toLowerCase()] : p['in'] === 'query' ? url.searchParams.get(name) ?? undefined : 'path';
    if (value === undefined) {
      if (p['required'] === true) problems.push(`${where} carries no ${p['in']} parameter ${name}`);
      continue;
    }
    if (p['in'] === 'query' && isRecord(p['schema'])) {
      const validate = archivistSpec().validator(p['schema'] as never);
      const typed = p['schema']['type'] === 'integer' ? Number(value) : value;
      if (!validate(typed)) problems.push(`${where}: query ${name}=${String(value)} (${errorsOf(validate)})`);
    }
  }
  const security = operation.op['security'];
  if (Array.isArray(security) && security.length > 0 && !req.headers.authorization?.startsWith('Bearer ')) {
    problems.push(`${where} carries no bearer token`);
  }
  return problems;
}

export async function startArchivist(issuer: IssuerServer, audience: string): Promise<FakeArchivist> {
  const calls: ArchivistCall[] = [];
  const violations: string[] = [];
  const content = new Map<string, Buffer>();
  const resources = new Map<string, { storageUri: string; mediaType: string }>();
  const events = new Map<string, StoredEvent[]>();
  const descriptions = new Map<string, unknown>();
  const uploads: RecordedUpload[] = [];
  const mode: FakeArchivist['mode'] = { refusesGateway: false, replayDelayMs: 0, replayFails: false, replayAnswer: undefined, refuseUploads: undefined };
  const supported = new Set(spec().schema('SupportedMediaType')['enum'] as string[]);
  const uploadRequired = archivistSpec().schema('ResourceUpload')['required'] as string[];

  const authorize = async (req: IncomingMessage): Promise<JWTPayload | undefined> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ') || mode.refusesGateway) return undefined;
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
      calls.push({ method: req.method ?? '', path: url.pathname + url.search, claims, headers: req.headers });

      const method = (req.method ?? '').toLowerCase();
      const operation = operations().find((o) => o.method === method && o.pattern.test(url.pathname));
      if (!operation) {
        violations.push(`the gateway called ${req.method} ${url.pathname}, which the Archivist's spec does not declare`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      violations.push(...requestProblems(operation, req, url));

      /** Answer, and check the answer against the operation's declaration first. */
      const reply = (status: number, headers: Record<string, string>, body: Buffer) => {
        const text = body.toString('utf8');
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const problems = archivistNonConformance(operation.method, operation.path, { status, headers: new Headers(headers), text, json, bytes: body });
        violations.push(...problems.map((p) => `the stand-in Archivist, ${operation.method.toUpperCase()} ${url.pathname}: ${p}`));
        res.writeHead(status, headers);
        res.end(body);
      };
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        reply(status, { 'content-type': 'application/json', ...headers }, Buffer.from(JSON.stringify(body)));

      const secured = Array.isArray(operation.op['security']) && operation.op['security'].length > 0;
      if (secured && !claims) {
        const presented = req.headers.authorization?.startsWith('Bearer ') === true;
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': presented ? 'Bearer error="invalid_token"' : 'Bearer' });
      }

      if (operation.path === '/resources') {
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
        const missing = uploadRequired.filter((k) => (k === 'file' ? !file : !fields[k]));
        if (missing.length > 0) return json(400, { error: `Missing required fields: ${missing.join(', ')}` });
        const base = fields['format']!.split(';')[0]!.trim().toLowerCase();
        if (!supported.has(base)) return json(400, { error: `Unsupported media type: ${base}` });
        if (mode.refuseUploads) return json(500, { error: mode.refuseUploads });
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
        return json(200, { resourceId });
      }

      const id = decodeURIComponent(operation.pattern.exec(url.pathname)![1]!);

      if (operation.path === '/resources/{id}/jsonld') {
        const description = descriptions.get(id);
        if (description === undefined) return json(404, { error: 'Resource not found' });
        return reply(200, { 'content-type': 'application/ld+json; charset=utf-8' }, Buffer.from(JSON.stringify(description)));
      }

      if (operation.path === '/resources/{id}/content') {
        const stored = resources.get(id);
        if (!stored) return json(404, { error: `Resource not found: ${id}`, code: 'resource' });
        const bytes = content.get(stored.storageUri);
        if (!bytes) return json(404, { error: `Resource representation not found: ${id}`, code: 'representation' });
        return reply(200, { 'content-type': stored.mediaType }, bytes);
      }

      if (operation.path === '/events/{resourceId}') {
        const from = Number(url.searchParams.get('fromSequence'));
        if (!Number.isInteger(from) || from < 1) return json(400, { error: 'integer fromSequence >= 1 is required' });
        if (mode.replayDelayMs > 0) await new Promise((r) => setTimeout(r, mode.replayDelayMs));
        if (mode.replayFails) return json(500, { error: 'event read failed' });
        if (mode.replayAnswer !== undefined) return json(200, mode.replayAnswer);
        return json(200, { events: (events.get(id) ?? []).filter((e) => e.metadata.sequenceNumber >= from) });
      }

      violations.push(`the stand-in Archivist serves no ${operation.method.toUpperCase()} ${operation.path}, which the gateway called`);
      json(500, { error: 'not served by the stand-in' });
    })().catch((error: unknown) => {
      violations.push(`the stand-in Archivist failed: ${String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      } else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: '127.0.0.1',
    port,
    calls,
    violations,
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
    id: `evt-${resourceId}-${sequenceNumber}`,
    type,
    timestamp: new Date(0).toISOString(),
    userId: 'did:web:record.example:users:someone',
    resourceId,
    version: 1,
    payload: {},
    metadata: { sequenceNumber },
  };
}
