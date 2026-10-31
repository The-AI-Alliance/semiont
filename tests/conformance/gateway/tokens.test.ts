/**
 * The credentials the gateway accepts and mints — the `bearerAuth` and
 * `mediaToken` schemes in specs/src/openapi.json. One kind of bearer, the
 * issuer's, for people and agents alike; the one token the gateway mints is a
 * media token.
 */
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { AGENT_KIND, KIND_CLAIM, SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { identifiers, kbIdentity, principalCases, spec, SUITE_KB } from '../harness/spec';
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

  const { people, agents } = principalCases(kbIdentity(SUITE_KB).domain);

  for (const person of people) {
    it(`a person is named exactly by their subject (principals/cases.json): ${person.why}`, async () => {
      const me = await call(world().origin, 'GET', '/api/users/me', { token: await world().person(person.subject) });
      expect(me.status, me.text).toBe(200);
      expect((me.json as { did: string }).did).toBe(person.did);
    });
  }

  for (const agent of agents) {
    it(`an agent is named exactly by its subject (principals/cases.json): ${agent.why}`, async () => {
      const token = await world().issuer.fixture.token({ claims: { sub: agent.subject, [KIND_CLAIM]: AGENT_KIND, roles: [SERVICE_ROLE] } });
      const me = await call(world().origin, 'GET', '/api/users/me', { token });
      expect(me.status, me.text).toBe(200);
      expect((me.json as { did: string }).did).toBe(agent.did);
    });
  }

  it('an issuer token whose kind is agent names an agent, with what its token carries and no address it lacks', async () => {
    const { token, did } = await world().agent('named-agent', [SERVICE_ROLE, WORKER_ROLE]);
    expect(decode(token).payload[KIND_CLAIM]).toBe(AGENT_KIND);
    const me = await call(world().origin, 'GET', '/api/users/me', { token });
    expect(me.status, me.text).toBe(200);
    expect(nonConformance('get', '/api/users/me', me)).toEqual([]);
    expect(me.json).toEqual({ did, email: null, name: null, image: null, domain: world().kb.domain });
    expect(did).toContain(':agents:');
  });

  it('a token that does not say it is an agent\'s names a person, whatever roles it carries', async () => {
    const { fixture } = world().issuer;
    for (const [why, claims] of [
      ['no kind', { sub: 'service-account-unmarked', roles: [SERVICE_ROLE, WORKER_ROLE] }],
      ['another kind', { sub: 'service-account-unmarked', roles: [SERVICE_ROLE], [KIND_CLAIM]: 'person' }],
    ] as const) {
      const me = await call(world().origin, 'GET', '/api/users/me', { token: await fixture.token({ claims }) });
      expect(me.status, `${why}: ${me.text}`).toBe(200);
      expect((me.json as { did: string }).did, why).toBe(world().personDid('service-account-unmarked'));
    }
  });

  it('a token without an email is admitted: an account need not have an address', async () => {
    const token = await world().issuer.fixture.token({ claims: { sub: 'no-address' } });
    const me = await call(world().origin, 'GET', '/api/users/me', { token });
    expect(me.status, me.text).toBe(200);
    expect(nonConformance('get', '/api/users/me', me)).toEqual([]);
    expect(me.json).toMatchObject({ did: world().personDid('no-address'), email: null });
  });

  it('the gateway mints no agent token: POST /api/tokens/agent is no route', async () => {
    const service = await world().issuer.service('a-sidecar', [SERVICE_ROLE]);
    const reply = await call(world().origin, 'POST', '/api/tokens/agent', { token: service, json: { provider: 'p', model: 'm' } });
    expect(reply.status, reply.text).toBe(404);
  });

  it('a cookie is not a credential: alone it is none, and beside a bearer token it changes nothing', async () => {
    const { token } = await world().agent('cookie');
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

  it('a token the gateway signed itself is no bearer: only the issuer\'s are', async () => {
    const forged = { did: `${world().kb.did}:agents:forged`, email: 'forged@agents.example', name: 'forged', domain: world().kb.domain, iss: world().kb.domain, sub: 'forged', [KIND_CLAIM]: AGENT_KIND };
    for (const [why, token] of [
      ['naming the knowledge base as its issuer', await world().signed({ ...forged, iat: now(), exp: now() + 600 })],
      ['naming the trusted issuer', await world().signed({ ...forged, iss: world().issuer.fixture.issuer, iat: now(), exp: now() + 600 })],
    ] as const) {
      const reply = await call(world().origin, 'GET', '/api/users/me', { token });
      expect(reply.status, why).toBe(401);
      expectRefused(reply, 'get', '/api/users/me');
    }
  });

  it('a media token is refused when it is not one, has expired, was signed with a key the gateway does not hold, or names another knowledge base or none; and it never opens a write', async () => {
    const id = 'res-media-edges';
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain' });
    world().archivist.content.set(`file://${id}`, Buffer.from('media bytes'));
    const person = await world().person('viewer');
    const media = ((await call(world().origin, 'POST', '/api/tokens/media', { token: person, json: { resourceId: id } })).json as { token: string }).token;
    const opened = await call(world().origin, 'GET', `/api/resources/${id}?token=${media}`);
    expect(opened.status, opened.text).toBe(200);
    expect(opened.text).toBe('media bytes');

    const iss = world().kb.domain;
    const refused: Array<[string, string]> = [
      ['garbage', 'garbage'],
      ['expired', await world().signed({ purpose: 'media', iss, sub: id, iat: now() - 600, exp: now() - 300 })],
      ['another key', await world().signed({ purpose: 'media', iss, sub: id, iat: now(), exp: now() + 300 }, randomBytes(32).toString('hex'))],
      ['not a media token', await world().signed({ purpose: 'download', iss, sub: id, iat: now(), exp: now() + 300 })],
      ['another knowledge base, on the same key ring', await world().signed({ purpose: 'media', iss: `another.${iss}`, sub: id, iat: now(), exp: now() + 300 })],
      ['no knowledge base', await world().signed({ purpose: 'media', sub: id, iat: now(), exp: now() + 300 })],
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

  it('an agent\'s token signed with another key is refused', async () => {
    const { token } = await world().agent('m');
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.${Buffer.from('not the signature').toString('base64url')}`;
    expectRefused(await call(world().origin, 'GET', '/api/users/me', { token: forged }), 'get', '/api/users/me');
  });

  it('a media token names its knowledge base and one resource, for five minutes', async () => {
    const token = await world().person('viewer');
    const reply = await call(world().origin, 'POST', '/api/tokens/media', { token, json: { resourceId: 'res-media-1' } });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('post', '/api/tokens/media', reply)).toEqual([]);
    const { payload, header } = decode((reply.json as { token: string }).token);
    expect(header['alg']).toBe('HS256');
    expect(payload).toMatchObject({ purpose: 'media', iss: world().kb.domain, sub: 'res-media-1' });
    expect(Number(payload['exp']) - Number(payload['iat'])).toBe(300);

    const missing = await call(world().origin, 'POST', '/api/tokens/media', { token, json: {} });
    expect(missing.status).toBe(400);
    expect(nonConformance('post', '/api/tokens/media', missing)).toEqual([]);
  });

  it('a media token is not minted for what is not a resource\'s id (identifiers/kinds.json)', async () => {
    const token = await world().person('viewer');
    for (const { id, why } of identifiers('ResourceId').refuses) {
      const reply = await call(world().origin, 'POST', '/api/tokens/media', { token, json: { resourceId: id } });
      expect(reply.status, `${JSON.stringify(id)}: ${why}`).toBe(400);
      expect(nonConformance('post', '/api/tokens/media', reply), why).toEqual([]);
    }
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
// kid it has not seen at most once per cooldown (`bearerAuth`'s
// `x-semiont-limits.keyRefetchCooldownSeconds`), so the case waits one
// out. Its own world, because every token signed after it uses the new key.
eachPlane('issuer key rotation', (world) => {
  const cooldownMs = spec().schemeLimit('bearerAuth', 'keyRefetchCooldownSeconds') * 1000;
  it('a key the issuer adds is accepted without restarting the gateway, once the key-fetch cooldown has passed', async () => {
    const before = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('before') });
    expect(before.status).toBe(200);
    await world().issuer.fixture.addKey('k-rotated');
    await new Promise((r) => setTimeout(r, cooldownMs + 1000));
    const after = await call(world().origin, 'GET', '/api/users/me', { token: await world().person('after') });
    expect(after.status, after.text).toBe(200);
  }, 60_000);
}, {}, ['in-process']);
