/**
 * The credentials the gateway accepts and mints — the `bearerAuth` and
 * `mediaToken` schemes in specs/src/openapi.json.
 */
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { kbIdentity, principals } from '../harness/spec';
import { eachPlane } from '../harness/world';

function decode(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = token.split('.');
  const part = (s: string | undefined) => JSON.parse(Buffer.from(s ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: part(header), payload: part(payload) };
}

function expectRefused(reply: Reply, method: 'get' | 'post', path: string): void {
  expect(reply.status, reply.text).toBe(401);
  expect(nonConformance(method, path, reply)).toEqual([]);
  expect(reply.headers.get('www-authenticate') ?? '').toMatch(/^Bearer error="invalid_token"/);
}

/** No credential at all: the challenge names no error, and the body a hint naming the header. */
function expectNoCredential(reply: Reply, method: 'get' | 'post', path: string, why: string): void {
  expect(reply.status, why).toBe(401);
  expect(nonConformance(method, path, reply), why).toEqual([]);
  expect(reply.headers.get('www-authenticate') ?? '', why).not.toContain('error=');
  expect((reply.json as { hint?: string }).hint ?? '', why).toContain('Authorization: Bearer');
}

const now = () => Math.floor(Date.now() / 1000);

eachPlane('credentials', (world) => {
  it('an issuer token names a person under the knowledge base\'s domain, by the subject claim', async () => {
    const token = await world().person('alice', { name: 'Alice Liddell', picture: 'https://pictures.example/alice.png' });
    const reply = await call(world().origin, 'GET', '/api/users/me', { token });
    expect(reply.status).toBe(200);
    expect(nonConformance('get', '/api/users/me', reply)).toEqual([]);
    expect(reply.json).toEqual({
      did: world().personDid('alice'),
      email: 'alice@people.example',
      name: 'Alice Liddell',
      image: 'https://pictures.example/alice.png',
      domain: world().kb.domain,
    });
  });

  it('an issuer token is refused when its audience, issuer, expiry, signature or claims are wrong', async () => {
    const { fixture } = world().issuer;
    const refused: Array<[string, string]> = [
      ['another audience', await fixture.token({ audience: 'https://elsewhere.example/kb', claims: { sub: 'x', email: 'x@people.example' } })],
      ['another issuer', await fixture.token({ issuer: 'http://elsewhere.example', claims: { sub: 'x', email: 'x@people.example' } })],
      ['expired', await fixture.token({ expiresIn: new Date(Date.now() - 60_000), claims: { sub: 'x', email: 'x@people.example' } })],
      ['a key the issuer does not publish', await fixture.token({ kid: 'k1', privateKey: await fixture.unpublishedKey(), claims: { sub: 'x', email: 'x@people.example' } })],
      ['no email', await fixture.token({ claims: { sub: 'x' } })],
      ['an unverified email', await world().person('x', { email_verified: false })],
      ['an empty subject', await world().person('')],
    ];
    for (const [why, token] of refused) {
      const reply = await call(world().origin, 'GET', '/api/users/me', { token });
      expect(reply.status, why).toBe(401);
      expect(nonConformance('get', '/api/users/me', reply), why).toEqual([]);
      expect(reply.headers.get('www-authenticate') ?? '', why).toMatch(/^Bearer error="invalid_token"/);
    }
  });

  const { people, agents } = principals(kbIdentity().domain);

  for (const person of people) {
    it(`a person is named exactly by their subject (principals/cases.json): ${person.why}`, async () => {
      const me = await call(world().origin, 'GET', '/api/users/me', { token: await world().person(person.subject) });
      expect(me.status, me.text).toBe(200);
      expect((me.json as { did: string }).did).toBe(person.did);
    });
  }

  it('a service account exchanges its token for an agent token naming a (provider, model)', async () => {
    const agent = agents[0]!;
    const service = await world().issuer.service('a-sidecar', [SERVICE_ROLE]);
    const reply = await call(world().origin, 'POST', '/api/tokens/agent', { token: service, json: { provider: agent.provider, model: agent.model } });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('post', '/api/tokens/agent', reply)).toEqual([]);
    const { token, did } = reply.json as { token: string; did: string };
    expect(did).toBe(agent.did);

    const { header, payload } = decode(token);
    expect(header['alg']).toBe('HS256');
    expect(payload['iss']).toBe(world().kb.domain);
    expect(payload['did']).toBe(did);
    expect(payload['domain']).toBe(world().kb.domain);
    expect(Number(payload['exp']) - Number(payload['iat'])).toBe(3600);
    expect(payload['roles']).toBeUndefined();

    const me = await call(world().origin, 'GET', '/api/users/me', { token });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ did, domain: world().kb.domain });
  });

  it('an agent token minted for a worker carries the worker role', async () => {
    const { token } = await world().agent('ollama', 'gemma2:27b', [SERVICE_ROLE, WORKER_ROLE]);
    expect(decode(token).payload['roles']).toEqual([WORKER_ROLE]);
    expect(Object.keys(decode(token).payload).sort()).toEqual(['did', 'domain', 'email', 'exp', 'iat', 'iss', 'name', 'roles']);
  });

  for (const agent of agents) {
    it(`an agent token names its agent exactly (principals/cases.json): ${agent.why}`, async () => {
      const { token, did } = await world().agent(agent.provider, agent.model);
      expect(did).toBe(agent.did);
      expect(Object.keys(decode(token).payload).sort()).toEqual(['did', 'domain', 'email', 'exp', 'iat', 'iss', 'name']);

      const me = await call(world().origin, 'GET', '/api/users/me', { token });
      expect(me.status, me.text).toBe(200);
      expect(me.json).toEqual({ did, email: agent.email, name: agent.name, image: null, domain: world().kb.domain });
    });
  }

  it('the agent exchange refuses a caller without the service role, and a body without provider and model', async () => {
    const person = await world().person('not-a-service');
    const roleless = await call(world().origin, 'POST', '/api/tokens/agent', { token: person, json: { provider: 'p', model: 'm' } });
    expectRefused(roleless, 'post', '/api/tokens/agent');
    expect((roleless.json as { error: string }).error).toContain(SERVICE_ROLE);

    const service = await world().issuer.service('a-sidecar', [SERVICE_ROLE]);
    for (const body of [{ provider: 'p' }, { model: 'm' }, { provider: 7, model: 'm' }]) {
      const reply = await call(world().origin, 'POST', '/api/tokens/agent', { token: service, json: body });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(nonConformance('post', '/api/tokens/agent', reply)).toEqual([]);
    }
  });

  it('the agent exchange verifies the service token as every route does, and says only that it was refused', async () => {
    const { fixture } = world().issuer;
    const service = { sub: 'service-account-x', azp: 'x', email: 'x@people.example' };
    const refused: Array<[string, string, string | undefined]> = [
      ['the role nested rather than in a flat roles claim', await fixture.token({ claims: { ...service, realm_access: { roles: [SERVICE_ROLE] } } }), SERVICE_ROLE],
      ['another audience', await fixture.token({ audience: 'https://elsewhere.example/kb', claims: { ...service, roles: [SERVICE_ROLE] } }), undefined],
      ['a key the issuer does not publish', await fixture.token({ kid: 'k1', privateKey: await fixture.unpublishedKey(), claims: { ...service, roles: [SERVICE_ROLE] } }), undefined],
      ['expired', await fixture.token({ expiresIn: new Date(Date.now() - 60_000), claims: { ...service, roles: [SERVICE_ROLE] } }), undefined],
    ];
    for (const [why, token, names] of refused) {
      const reply = await call(world().origin, 'POST', '/api/tokens/agent', { token, json: { provider: 'p', model: 'm' } });
      expect(reply.status, why).toBe(401);
      expect(nonConformance('post', '/api/tokens/agent', reply), why).toEqual([]);
      expect(reply.headers.get('www-authenticate'), why).toBe(`Bearer error="invalid_token", resource_metadata="${world().origin}/.well-known/oauth-protected-resource"`);
      if (names) expect((reply.json as { error: string }).error, why).toContain(names);
      else expect(reply.json, why).toEqual({ error: 'Invalid token' });
    }
  });

  it('a cookie is not a credential: alone it is none, and beside a bearer token it changes nothing', async () => {
    const { token } = await world().agent('p', 'cookie');
    const person = await world().person('cookie-eater');
    for (const cookie of [`semiont-token=${token}`, `semiont-token=${person}`]) {
      expectNoCredential(await call(world().origin, 'GET', '/api/users/me', { headers: { cookie } }), 'get', '/api/users/me', cookie.slice(0, 30));
    }
    const both = await call(world().origin, 'GET', '/api/users/me', { token: person, headers: { cookie: 'semiont-token=junk' } });
    expect(both.status, both.text).toBe(200);
  });

  it('an Authorization header that is not a bearer credential is none; the scheme is matched in any case, and whatever follows it is the token', async () => {
    const person = await world().person('header-shapes');
    const none: Array<[string, string]> = [
      ['another scheme', 'Basic dXNlcjpwYXNz'],
      ['a token with no scheme', person],
      ['the scheme alone', 'Bearer'],
      ['the scheme and blanks', 'Bearer   '],
    ];
    for (const [why, authorization] of none) {
      expectNoCredential(await call(world().origin, 'GET', '/api/users/me', { headers: { authorization } }), 'get', '/api/users/me', why);
    }
    for (const scheme of ['bearer', 'BEARER', 'bEaReR']) {
      const reply = await call(world().origin, 'GET', '/api/users/me', { headers: { authorization: `${scheme} ${person}` } });
      expect(reply.status, scheme).toBe(200);
    }
    const invalid: Array<[string, string]> = [
      ['a 10,000-character token', 'a'.repeat(10_000)],
      ['a token with a space in it', `${person} extra`],
      ['a token with quotes and backslashes', `"${person}\\"`],
    ];
    for (const [why, token] of invalid) {
      const reply = await call(world().origin, 'GET', '/api/users/me', { headers: { authorization: `Bearer ${token}` } });
      expect(reply.status, why).toBe(401);
      expect(nonConformance('get', '/api/users/me', reply), why).toEqual([]);
      expect(reply.json, why).toEqual({ error: 'Invalid token' });
    }
  });

  it('a token signed with the gateway\'s own key is refused when it has expired, is not yet valid, names no principal, or claims no signature', async () => {
    const principal = { did: `${world().kb.did}:agents:p:forged`, email: 'p-forged@agents.example', name: 'p forged', domain: world().kb.domain, iss: world().kb.domain };
    const control = await world().signed({ ...principal, iat: now(), exp: now() + 600 });
    expect((await call(world().origin, 'GET', '/api/users/me', { token: control })).status).toBe(200);

    const body = control.split('.')[1];
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${body}.`;
    const refused: Array<[string, string]> = [
      ['expired', await world().signed({ ...principal, iat: now() - 7200, exp: now() - 3600 })],
      ['not yet valid', await world().signed({ ...principal, iat: now(), nbf: now() + 3600, exp: now() + 7200 })],
      ['only a did', await world().signed({ did: principal.did, iat: now(), exp: now() + 600 })],
      ['a did that is not one', await world().signed({ ...principal, did: 'agents:p:m', iat: now(), exp: now() + 600 })],
      ['signed by no key', unsigned],
    ];
    for (const [why, token] of refused) {
      const reply = await call(world().origin, 'GET', '/api/users/me', { token });
      expect(reply.status, why).toBe(401);
      expectRefused(reply, 'get', '/api/users/me');
    }
  });

  it('a media token is refused when it is not one, has expired, or was signed with a key the gateway does not hold; and it never opens a write', async () => {
    const id = 'res-media-edges';
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain' });
    world().archivist.content.set(`file://${id}`, Buffer.from('media bytes'));
    const person = await world().person('viewer');
    const media = ((await call(world().origin, 'POST', '/api/tokens/media', { token: person, json: { resourceId: id } })).json as { token: string }).token;
    const opened = await call(world().origin, 'GET', `/api/resources/${id}?token=${media}`);
    expect(opened.status, opened.text).toBe(200);
    expect(opened.text).toBe('media bytes');

    const refused: Array<[string, string]> = [
      ['garbage', 'garbage'],
      ['expired', await world().signed({ purpose: 'media', sub: id, iat: now() - 600, exp: now() - 300 })],
      ['another key', await world().signed({ purpose: 'media', sub: id, iat: now(), exp: now() + 300 }, randomBytes(32).toString('hex'))],
      ['not a media token', await world().signed({ purpose: 'download', sub: id, iat: now(), exp: now() + 300 })],
    ];
    for (const [why, token] of refused) {
      const reply = await call(world().origin, 'GET', `/api/resources/${id}?token=${token}`);
      expect(reply.status, why).toBe(401);
      expect(nonConformance('get', '/api/resources/{id}', reply), why).toEqual([]);
    }

    // Anywhere but that GET, a media token is no credential at all.
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const reply = await call(world().origin, method, `/api/resources/${id}?token=${media}`);
      expect(reply.status, method).toBe(401);
      expect(reply.headers.get('www-authenticate') ?? '', method).not.toContain('error=');
    }
    expectNoCredential(await call(world().origin, 'GET', `/api/users/me?token=${media}`), 'get', '/api/users/me', 'a media token on another route');
  });

  it('a person is named by their subject: a changed address keeps the DID, and absent name and picture are null', async () => {
    const before = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('carol', { email: 'carol@old.example' }) });
    const after = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('carol', { email: 'carol@new.example' }) });
    expect((before.json as { did: string }).did).toBe(world().personDid('carol'));
    expect(after.json).toMatchObject({ did: world().personDid('carol'), email: 'carol@new.example' });

    const plain = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('dave', { name: undefined }) });
    expect(plain.status, plain.text).toBe(200);
    expect(nonConformance('get', '/api/users/me', plain)).toEqual([]);
    expect(plain.json).toMatchObject({ did: world().personDid('dave'), name: null, image: null });
  });

  it('an agent token signed with another key is refused', async () => {
    const { token } = await world().agent('p', 'm');
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.${Buffer.from('not the signature').toString('base64url')}`;
    expectRefused(await call(world().origin, 'GET', '/api/users/me', { token: forged }), 'get', '/api/users/me');
  });

  it('a media token names one resource for five minutes', async () => {
    const token = await world().person('viewer');
    const reply = await call(world().origin, 'POST', '/api/tokens/media', { token, json: { resourceId: 'res-media-1' } });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('post', '/api/tokens/media', reply)).toEqual([]);
    const { payload, header } = decode((reply.json as { token: string }).token);
    expect(header['alg']).toBe('HS256');
    expect(payload).toMatchObject({ purpose: 'media', sub: 'res-media-1' });
    expect(Number(payload['exp']) - Number(payload['iat'])).toBe(300);

    const missing = await call(world().origin, 'POST', '/api/tokens/media', { token, json: {} });
    expect(missing.status).toBe(400);
    expect(nonConformance('post', '/api/tokens/media', missing)).toEqual([]);
  });

  it('a media token opens only the resource it names, and only on the media route', async () => {
    const person = await world().person('viewer');
    const media = ((await call(world().origin, 'POST', '/api/tokens/media', { token: person, json: { resourceId: 'res-media-2' } })).json as { token: string }).token;

    const other = await call(world().origin, 'GET', `/api/resources/res-media-3?token=${media}`);
    expect(other.status).toBe(401);
    expect(nonConformance('get', '/api/resources/{id}', other)).toEqual([]);

    const bearerRoute = await call(world().origin, 'GET', `/resources/res-media-2?token=${media}`);
    expect(bearerRoute.status).toBe(401);

    const asBearer = await call(world().origin, 'GET', '/api/users/me', { token: media });
    expect(asBearer.status).toBe(401);
  });
});

// Plane-independent: which claim names a person is the knowledge base's choice.
eachPlane('a knowledge base that names people by another claim', (world) => {
  it('names a person by the claim identity.subjectClaim selects, and refuses a token without it', async () => {
    const named = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('sub-is-ignored', { preferred_username: 'erin' }) });
    expect(named.status, named.text).toBe(200);
    expect((named.json as { did: string }).did).toBe(world().personDid('erin'));

    const unnamed = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('frank') });
    expectRefused(unnamed, 'get', '/api/users/me');
  });
}, { settings: (s) => ({ ...s, identity: { ...s.identity, subjectClaim: 'preferred_username' } }) }, ['in-process']);

// Plane-independent: the issuer's keys are fetched when first needed, so an
// issuer gone before then leaves nothing to verify with.
eachPlane('an issuer that cannot be reached', (world) => {
  it('refuses its tokens as unverifiable — a 401, never a 5xx', async () => {
    const token = await world().person('stranded');
    await world().issuer.close();
    expectRefused(await call(world().origin, 'GET', '/api/users/me', { token }), 'get', '/api/users/me');
  });
}, {}, ['in-process']);

// Plane-independent, and slow: the verifier refetches the issuer's keys on a
// kid it has not seen at most once per cooldown (30 s), so the case waits one
// out. Its own world, because every token signed after it uses the new key.
eachPlane('issuer key rotation', (world) => {
  it('a key the issuer adds is accepted without restarting the gateway, once the key-fetch cooldown has passed', async () => {
    const before = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('before') });
    expect(before.status).toBe(200);
    await world().issuer.fixture.addKey('k-rotated');
    await new Promise((r) => setTimeout(r, 31_000));
    const after = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('after') });
    expect(after.status, after.text).toBe(200);
  }, 60_000);
}, {}, ['in-process']);
