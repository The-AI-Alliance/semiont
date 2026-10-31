/**
 * The harness's issuer admits a key account as an issuer does: an assertion
 * signed with the registered key, for this token endpoint and not expired, is
 * answered once; one signed by another key, expired, addressed elsewhere or
 * sent a second time is refused (specs/src/session/client-assertion-cases.json).
 * A grant a case tells it to fail is answered 503, or not answered at all.
 */
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_BEARER, startIssuer, type IssuerServer } from './issuer';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';

const CLIENT = 'semiont-worker-alice-laptop';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function assertion(key: KeyObject, claims: Record<string, unknown>): string {
  const input = `${encoded({ alg: 'RS256' })}.${encoded(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

describe('the issuer admits a key account by its assertion', () => {
  let issuer: IssuerServer;
  let endpoint: string;
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: CLIENT,
    sub: CLIENT,
    aud: endpoint,
    jti: randomUUID(),
    iat: now(),
    exp: now() + 60,
    ...overrides,
  });
  const grant = (signed: string, type = JWT_BEARER) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: type, client_assertion: signed }),
    });

  beforeAll(async () => {
    issuer = await startIssuer('https://kb.example', { [CLIENT]: { publicKey, roles: [SERVICE_ROLE, WORKER_ROLE] } });
    endpoint = `${issuer.fixture.issuer}/token`;
  });
  afterAll(async () => issuer.close());

  it('answers an assertion signed with the registered key with a token carrying the account and its roles', async () => {
    const answer = await grant(assertion(privateKey, claims()));
    expect(answer.status).toBe(200);
    const { access_token } = (await answer.json()) as { access_token: string };
    const [, body] = access_token.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toMatchObject({ azp: CLIENT, roles: [SERVICE_ROLE, WORKER_ROLE] });
    expect(issuer.grants.get(CLIENT)).toBe(1);
  });

  it.each([
    ['signed by another key', () => assertion(other, claims())],
    ['expired', () => assertion(privateKey, claims({ exp: now() - 1 }))],
    ['addressed to another token endpoint', () => assertion(privateKey, claims({ aud: 'https://elsewhere.example/token' }))],
    ['naming another subject than its issuer', () => assertion(privateKey, claims({ sub: 'semiont-gateway' }))],
  ])('refuses one %s', async (_, made) => {
    expect((await grant(made())).status).toBe(401);
  });

  it('refuses an assertion sent a second time', async () => {
    const once = assertion(privateKey, claims());
    expect((await grant(once)).status).toBe(200);
    expect((await grant(once)).status).toBe(401);
  });

  it('refuses an assertion of another type, and a secret for a key account', async () => {
    expect((await grant(assertion(privateKey, claims()), 'urn:ietf:params:oauth:client-assertion-type:saml2-bearer')).status).toBe(401);
    const bySecret = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT, client_secret: 'anything' }),
    });
    expect(bySecret.status).toBe(401);
  });

  it('fails the grants it is told to fail, in order, and grants again after them', async () => {
    const before = issuer.grants.get(CLIENT) ?? 0;
    issuer.failing.next.push('unavailable', 'unanswered');
    expect((await grant(assertion(privateKey, claims()))).status).toBe(503);
    await expect(grant(assertion(privateKey, claims()))).rejects.toThrow();
    expect((await grant(assertion(privateKey, claims()))).status).toBe(200);
    expect(issuer.failing.met.map(({ failure }) => failure)).toEqual(['unavailable', 'unanswered']);
    expect(issuer.failing.next).toEqual([]);
    expect(issuer.grants.get(CLIENT)).toBe(before + 1);
  });
});
