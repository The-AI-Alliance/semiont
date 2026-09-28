/**
 * Cases generated from the spec itself: every declared operation, probed the
 * ways every operation can be probed. A route added to the spec is covered
 * here without anyone writing a case for it.
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { METHODS, spec, type Method } from '../harness/spec';
import { SERVICE_ROLE } from '../harness/roles';
import { eachPlane } from '../harness/world';

/** A concrete URL for an OpenAPI path: every `{param}` filled. */
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, 'conformance-probe');

const operations = () => spec().operations();
const isPublic = (op: Record<string, unknown>) => Array.isArray(op['security']) && op['security'].length === 0;
const takesJson = (op: Record<string, unknown>) =>
  'application/json' in ((op['requestBody'] as { content?: Record<string, unknown> } | undefined)?.content ?? {});

/**
 * A body of `size` bytes — `[]` then spaces, JSON at any size, and never the
 * operation's schema — sent with its length or in chunks without one. With its
 * length, the request asks to continue first and sends the body only if the
 * gateway asks for it; `askedForBody` says whether it did.
 */
function sized(
  origin: string,
  path: string,
  token: string,
  size: number,
  framing: 'length' | 'chunked',
): Promise<{ reply: Reply; askedForBody: boolean }> {
  const body = Buffer.alloc(size, ' ');
  body.write('[]');
  const url = new URL(path, origin);
  const headers: Record<string, string | number> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (framing === 'length') {
    headers['content-length'] = size;
    headers['expect'] = '100-continue';
  }
  return new Promise((resolve, reject) => {
    let askedForBody = false;
    let answered = false;
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        req.destroy();
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (typeof value === 'string') replyHeaders.set(name, value);
        resolve({ reply: { status: res.statusCode ?? 0, headers: replyHeaders, text, json, bytes }, askedForBody });
      });
    });
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    if (framing === 'length') {
      req.on('continue', () => {
        askedForBody = true;
        req.end(body);
      });
      req.flushHeaders();
    } else {
      for (let at = 0; at < size; at += 64 * 1024) req.write(body.subarray(at, at + 64 * 1024));
      req.end();
    }
  });
}

eachPlane('every operation the spec declares', (world) => {
  const metadata = () => `resource_metadata="${world().origin}/.well-known/oauth-protected-resource"`;

  it('a protected operation refuses a request with no credential — before reading its body — with 401, a challenge, and a hint naming the header', async () => {
    const problems: string[] = [];
    for (const { method, path, op } of operations()) {
      if (isPublic(op)) continue;
      // Another scheme is no credential either; and a body that is not JSON
      // would be a 400 if the gateway parsed it before authenticating.
      for (const [label, authorization] of [['no header', undefined], ['a Basic header', 'Basic dXNlcjpwYXNz']] as const) {
        const reply = await call(world().origin, method, concrete(path), {
          ...(authorization ? { headers: { authorization } } : {}),
          ...(takesJson(op) ? { json: '{"unterminated' } : {}),
        });
        const at = `${method.toUpperCase()} ${path} with ${label}`;
        if (reply.status !== 401) {
          problems.push(`${at}: ${reply.status}, not 401`);
          continue;
        }
        problems.push(...nonConformance(method, path, reply).map((p) => `${at}: ${p}`));
        const challenge = reply.headers.get('www-authenticate');
        if (challenge !== `Bearer ${metadata()}`) problems.push(`${at}: challenge ${JSON.stringify(challenge)}`);
        if (!((reply.json as { hint?: string }).hint ?? '').includes('Authorization: Bearer')) problems.push(`${at}: no hint naming the header: ${reply.text}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a protected operation refuses a credential it cannot verify: 401 with error="invalid_token"', async () => {
    const problems: string[] = [];
    for (const { method, path, op } of operations()) {
      if (isPublic(op)) continue;
      const reply = await call(world().origin, method, concrete(path), { token: 'not-a-token', ...(takesJson(op) ? { json: {} } : {}) });
      if (reply.status !== 401) {
        problems.push(`${method.toUpperCase()} ${path}: ${reply.status}, not 401`);
        continue;
      }
      problems.push(...nonConformance(method, path, reply).map((p) => `${method.toUpperCase()} ${path}: ${p}`));
      const challenge = reply.headers.get('www-authenticate');
      if (challenge !== `Bearer error="invalid_token", ${metadata()}`) problems.push(`${method.toUpperCase()} ${path}: challenge ${JSON.stringify(challenge)}`);
    }
    expect(problems).toEqual([]);
  });

  it('a public operation answers without a credential, as declared', async () => {
    const problems: string[] = [];
    for (const { method, path, op } of operations()) {
      if (!isPublic(op)) continue;
      const reply = await call(world().origin, method, concrete(path));
      if (reply.status !== 200) problems.push(`${method.toUpperCase()} ${path}: ${reply.status}`);
      problems.push(...nonConformance(method, path, reply).map((p) => `${method.toUpperCase()} ${path}: ${p}`));
      if (reply.headers.get('www-authenticate') !== null) problems.push(`${method.toUpperCase()} ${path}: a public route challenged: ${reply.headers.get('www-authenticate')}`);
    }
    expect(problems).toEqual([]);
  });

  it('a method the spec does not declare on a path it does is a 404 ErrorResponse, whoever asks', async () => {
    const token = await world().person('probe', { roles: [SERVICE_ROLE] });
    const declared = new Map<string, Set<string>>();
    for (const { method, path } of operations()) declared.set(path, (declared.get(path) ?? new Set()).add(method));
    const problems: string[] = [];
    for (const [path, methods] of declared) {
      for (const method of METHODS.filter((m) => !methods.has(m))) {
        const reply = await call(world().origin, method.toUpperCase(), concrete(path), { token, ...(method === 'get' ? {} : { json: {} }) });
        const at = `${method.toUpperCase()} ${path}`;
        if (reply.status !== 404) problems.push(`${at}: ${reply.status}, not 404`);
        else if (!spec().component('ErrorResponse')(reply.json)) problems.push(`${at}: ${reply.text.slice(0, 100)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a JSON request body that does not match its schema is a 400 ErrorResponse', async () => {
    // A person who also holds the service role: every protected route admits them.
    const token = await world().person('probe', { roles: [SERVICE_ROLE] });
    const problems: string[] = [];
    for (const { method, path, op } of operations()) {
      if (!takesJson(op)) continue;
      for (const [label, json] of [['an array', '[]'], ['not JSON', '{"unterminated']] as const) {
        const reply = await call(world().origin, method, concrete(path), { token, json });
        if (reply.status !== 400) problems.push(`${method.toUpperCase()} ${path} with ${label}: ${reply.status}`);
        else problems.push(...nonConformance(method as Method, path, reply).map((p) => `${method.toUpperCase()} ${path} with ${label}: ${p}`));
      }
    }
    expect(problems).toEqual([]);
  });

  it('a JSON body larger than maxBodyBytes is a 413 ErrorResponse — unread when its length says so — and one of exactly maxBodyBytes is read', async () => {
    const token = await world().person('body-limit', { roles: [SERVICE_ROLE] });
    const problems: string[] = [];
    for (const { method, path, op } of operations()) {
      if (!takesJson(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const limit = spec().limits(method as Method, path)['maxBodyBytes'];
      if (limit === undefined) {
        problems.push(`${where} takes a JSON body and the spec states no maxBodyBytes`);
        continue;
      }
      for (const framing of ['length', 'chunked'] as const) {
        const over = await sized(world().origin, concrete(path), token, limit + 1, framing);
        if (over.reply.status !== 413) problems.push(`${where}, ${limit + 1} bytes by ${framing}: ${over.reply.status}`);
        else problems.push(...nonConformance(method as Method, path, over.reply).map((p) => `${where}, ${limit + 1} bytes by ${framing}: ${p}`));
        if (over.askedForBody) problems.push(`${where}, ${limit + 1} bytes by length: the gateway asked for the body its Content-Length already ruled out`);

        const at = await sized(world().origin, concrete(path), token, limit, framing);
        if (at.reply.status !== 400) problems.push(`${where}, ${limit} bytes by ${framing}: ${at.reply.status}, where reading it finds an array`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a path the spec does not declare is a 404 ErrorResponse', async () => {
    for (const path of ['/no/such/path', '/api/no-such-route']) {
      const reply = await call(world().origin, 'GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.headers.get('content-type') ?? '', path).toMatch(/^application\/json/);
      expect(spec().component('ErrorResponse')(reply.json), `${path}: ${reply.text}`).toBe(true);
    }
  });

  it('every request limit the spec states is enforced, and not one below it', async () => {
    const token = await world().person('limits');
    const request = spec().schema('BusSubscribeRequest') as {
      properties: { pendingReplies: { maxItems: number }; scoped: { maxItems: number } };
    };
    const pendingMax = request.properties.pendingReplies.maxItems;
    const scopedMax = request.properties.scoped.maxItems;
    const body = (pending: number, scoped: number) => ({
      clientId: randomUUID(),
      global: ['beckon:focus'],
      pendingReplies: Array.from({ length: pending }, () => randomUUID()),
      scoped: Array.from({ length: scoped }, (_, i) => ({ scope: `limit-scope-${i}`, channels: ['mark:added'] })),
    });

    const atLimit = await world().subscribe(token, body(pendingMax, scopedMax));
    atLimit.close();

    for (const [label, over] of [['pendingReplies', body(pendingMax + 1, 0)], ['scoped', body(0, scopedMax + 1)]] as const) {
      const reply = await call(world().origin, 'POST', '/bus/subscribe', { token, json: over });
      expect(reply.status, label).toBe(400);
      expect(nonConformance('post', '/bus/subscribe', reply), label).toEqual([]);
    }
  });
});
