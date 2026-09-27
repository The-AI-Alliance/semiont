/**
 * Cases generated from the spec itself: every declared operation, probed the
 * ways every operation can be probed. A route added to the spec is covered
 * here without anyone writing a case for it.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance } from '../harness/http';
import { METHODS, spec, type Method } from '../harness/spec';
import { SERVICE_ROLE } from '../harness/roles';
import { eachPlane } from '../harness/world';

/** A concrete URL for an OpenAPI path: every `{param}` filled. */
const concrete = (path: string) => path.replace(/\{[^}]+\}/g, 'conformance-probe');

const operations = () => spec().operations();
const isPublic = (op: Record<string, unknown>) => Array.isArray(op['security']) && op['security'].length === 0;
const takesJson = (op: Record<string, unknown>) =>
  'application/json' in ((op['requestBody'] as { content?: Record<string, unknown> } | undefined)?.content ?? {});

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
