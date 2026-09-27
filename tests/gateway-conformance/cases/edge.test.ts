/**
 * What every response carries (docs/protocol/TRANSPORT-HTTP.md § Every
 * response), and the routes that describe the gateway and the knowledge base.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { spec } from '../harness/spec';
import { eachPlane } from '../harness/world';

const SECURITY_HEADERS: Record<string, string | RegExp> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'permissions-policy': /camera=\(\)/,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-xss-protection': '1; mode=block',
};

function edgeProblems(label: string, reply: Reply): string[] {
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
    const value = reply.headers.get(name);
    const ok = value !== null && (typeof expected === 'string' ? value === expected : expected.test(value));
    if (!ok) problems.push(`${label}: ${name} is ${JSON.stringify(value)}`);
  }
  if (!reply.headers.get('x-request-id')) problems.push(`${label}: no X-Request-ID`);
  return problems;
}

eachPlane('every response', (world) => {
  it('carries the security headers and a request id — success, error, bytes and stream alike', async () => {
    const token = await world().person('edge');
    const id = `res-${randomUUID()}`;
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain' });
    world().archivist.content.set(`file://${id}`, Buffer.from('bytes'));
    const replies: Array<[string, Reply]> = [
      ['health', await call(world().origin, 'GET', '/api/health')],
      ['a 401', await call(world().origin, 'GET', '/api/users/me')],
      ['a 404', await call(world().origin, 'GET', '/no/such/path')],
      ['content bytes', await call(world().origin, 'GET', `/resources/${id}`, { token })],
      ['a 400', await call(world().origin, 'POST', '/bus/emit', { token, json: {} })],
    ];
    const problems = replies.flatMap(([label, reply]) => edgeProblems(label, reply));

    const controller = new AbortController();
    const stream = await fetch(`${world().origin}/bus/subscribe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: randomUUID(), global: ['beckon:focus'] }),
      signal: controller.signal,
    });
    problems.push(...edgeProblems('the stream', { status: stream.status, headers: stream.headers, text: '', json: undefined, bytes: Buffer.alloc(0) }));
    controller.abort();
    expect(problems).toEqual([]);

    const ids = new Set(replies.map(([, r]) => r.headers.get('x-request-id')));
    expect(ids.size).toBe(replies.length);
  });

  it('allows any origin, and never credentials', async () => {
    const preflight = await call(world().origin, 'OPTIONS', '/bus/emit', {
      headers: { origin: 'https://anywhere.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();

    const simple = await call(world().origin, 'GET', '/api/health', { headers: { origin: 'https://anywhere.example' } });
    expect(simple.headers.get('access-control-allow-origin')).toBe('*');
    expect(simple.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('the gateway hosts no documentation UI: the OpenAPI document is what it publishes', async () => {
    for (const path of ['/api', '/api/docs', '/api/swagger']) {
      const reply = await call(world().origin, 'GET', path, { headers: { accept: 'text/html' } });
      expect(reply.status, path).toBe(404);
      expect(spec().component('ErrorResponse')(reply.json), `${path}: ${reply.text.slice(0, 100)}`).toBe(true);
    }
  });

  it('the OpenAPI document names this build\'s version and this gateway\'s public URL', async () => {
    const health = await call(world().origin, 'GET', '/api/health');
    const doc = await call(world().origin, 'GET', '/api/openapi.json');
    expect(doc.status).toBe(200);
    expect(nonConformance('get', '/api/openapi.json', doc)).toEqual([]);
    const { info, servers } = doc.json as { info: { version: string }; servers: Array<{ url: string }> };
    expect(info.version).toBe((health.json as { version: string }).version);
    expect(servers.map((s) => s.url)).toEqual([world().gateway.settings.publicUrl]);
  });

  it('the resource metadata names this knowledge base, its issuer, and the header a token rides in', async () => {
    const reply = await call(world().origin, 'GET', '/.well-known/oauth-protected-resource');
    expect(reply.status).toBe(200);
    expect(nonConformance('get', '/.well-known/oauth-protected-resource', reply)).toEqual([]);
    expect(reply.json).toEqual({
      resource: world().kb.resource,
      authorization_servers: [world().issuer.origin],
      bearer_methods_supported: ['header'],
      resource_name: world().kb.name,
    });
  });

  it('the challenge on a 401 points at the resource metadata on the origin the caller reached', async () => {
    const reply = await call(world().origin, 'GET', '/api/status');
    expect(reply.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${world().origin}/.well-known/oauth-protected-resource"`);
  });

  it('the status names the gateway and who is asking, and asks the Archivist nothing', async () => {
    const token = await world().person('status-reader');
    const before = world().archivist.calls.length;
    const reply = await call(world().origin, 'GET', '/api/status', { token });
    expect(reply.status).toBe(200);
    expect(nonConformance('get', '/api/status', reply)).toEqual([]);
    expect((reply.json as { authenticatedAs?: string }).authenticatedAs).toBe('status-reader@people.example');
    expect(world().archivist.calls.slice(before)).toEqual([]);
  });
});
