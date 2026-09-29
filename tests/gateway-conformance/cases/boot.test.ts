/**
 * What a gateway needs before it serves, and its refusal to serve without
 * it: it exits non-zero and never answers on its port, and its output names
 * what is missing. Then the signing key ring, across restarts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startArchivist, type FakeArchivist } from '../harness/archivist';
import { defaultSettings, refusedBoot, startGateway, type GatewayEnvironment, type GatewaySettings } from '../harness/gateway';
import { call } from '../harness/http';
import { startIssuer, type IssuerServer } from '../harness/issuer';
import { startBroker } from '../harness/nats';
import { freePort } from '../harness/net';
import { startHoldingProxy } from '../harness/proxy';
import { SERVICE_ROLE } from '../harness/roles';
import { kbIdentity } from '../harness/spec';
import { subscribe } from '../harness/stream';
import { GATEWAY_CLIENT, PARTICIPANT_CLIENT } from '../harness/world';

describe('starting a gateway', () => {
  const kb = kbIdentity();
  const secret = randomBytes(24).toString('hex');
  let issuer: IssuerServer;
  let archivist: FakeArchivist;

  beforeAll(async () => {
    issuer = await startIssuer(kb.resource, { [GATEWAY_CLIENT]: { secret, roles: [SERVICE_ROLE] } });
    archivist = await startArchivist(issuer, kb.resource);
  });
  afterAll(async () => {
    await archivist.close();
    await issuer.close();
  });

  const env = (overrides: GatewayEnvironment = {}): GatewayEnvironment => ({
    JWT_SECRET: randomBytes(32).toString('hex'),
    SEMIONT_OIDC_CLIENT_ID: GATEWAY_CLIENT,
    SEMIONT_OIDC_CLIENT_SECRET: secret,
    ...overrides,
  });
  const settings = async (change: (s: GatewaySettings) => void = () => {}) => {
    const s = await defaultSettings({
      kb: { name: kb.name, domain: kb.domain },
      issuer: issuer.origin,
      archivist: { host: archivist.host, port: archivist.port },
      plane: 'in-process',
    });
    change(s);
    return s;
  };

  const refusals: Array<[string, () => Promise<{ settings: GatewaySettings; env: GatewayEnvironment }>, RegExp]> = [
    ['no JWT_SECRET', async () => ({ settings: await settings(), env: env({ JWT_SECRET: undefined }) }), /JWT_SECRET/],
    ['a JWT_SECRET key shorter than 32 characters', async () => ({ settings: await settings(), env: env({ JWT_SECRET: `${'a'.repeat(40)},short` }) }), /JWT_SECRET/],
    ['no service-account client id', async () => ({ settings: await settings(), env: env({ SEMIONT_OIDC_CLIENT_ID: undefined }) }), /SEMIONT_OIDC_CLIENT_ID/],
    ['no service-account secret', async () => ({ settings: await settings(), env: env({ SEMIONT_OIDC_CLIENT_SECRET: undefined }) }), /SEMIONT_OIDC_CLIENT_SECRET/],
    ['no knowledge-base domain', async () => ({ settings: await settings((s) => delete s.kb.domain), env: env() }), /\/kb\b.*\bdomain\b/],
    ['no Archivist address', async () => ({ settings: await settings((s) => delete s.archivist.host), env: env() }), /\/archivist\b.*\bhost\b/],
    ['no issuer', async () => ({ settings: await settings((s) => delete s.identity.issuer), env: env() }), /\/identity\b.*\bissuer\b/],
    ['no subject claim', async () => ({ settings: await settings((s) => delete s.identity.subjectClaim), env: env() }), /\/identity\b.*\bsubjectClaim\b/],
    ['a field the document does not declare', async () => ({ settings: await settings((s) => void (s.verbatim = { corsOrigin: '*' })), env: env() }), /corsOrigin/],
    ['a log format the document does not declare', async () => ({ settings: await settings((s) => void (s.verbatim = { logFormat: 'text' })), env: env() }), /\/logFormat\b/],
    ['no capacity', async () => ({ settings: await settings((s) => delete s.capacity), env: env() }), /capacity/],
    ['no SEMIONT_GATEWAY_CONFIG: there is no default path to fall back on', async () => ({ settings: await settings(), env: env({ SEMIONT_GATEWAY_CONFIG: undefined }) }), /SEMIONT_GATEWAY_CONFIG/],
    ['a SEMIONT_GATEWAY_CONFIG naming no file', async () => ({ settings: await settings(), env: env({ SEMIONT_GATEWAY_CONFIG: join(tmpdir(), `gateway-conformance-no-document-${randomUUID()}.json`) }) }), /gateway-conformance-no-document-/],
    ['a NATS plane with no servers', async () => ({ settings: await settings((s) => void (s.signal = { type: 'nats' })), env: env() }), /servers/],
    [
      'a broker nobody answers at',
      async () => {
        const nobody = `nats://127.0.0.1:${await freePort()}`;
        return { settings: await settings((s) => void (s.signal = { type: 'nats', servers: nobody })), env: env() };
      },
      /./,
    ],
  ];

  for (const [why, make, names] of refusals) {
    it(`refuses to serve with ${why}, and prints no secret it was given`, async () => {
      const { settings: s, env: e } = await make();
      const { code, output } = await refusedBoot({ settings: s, env: e });
      expect(code, output).not.toBe(0);
      expect(code, output).not.toBeNull();
      expect(output).toMatch(names);
      const secrets = [...(e.JWT_SECRET?.split(',') ?? []), e.SEMIONT_OIDC_CLIENT_SECRET].filter((v): v is string => (v?.trim().length ?? 0) >= 8);
      for (const value of secrets) expect(output, 'a secret in the output').not.toContain(value.trim());
    });
  }

  it('listens on every address the host has: the IPv4 and the IPv6 loopback both answer', async () => {
    const gateway = await startGateway({ settings: await settings(), env: env() });
    try {
      for (const host of ['127.0.0.1', '[::1]']) {
        expect((await call(`http://${host}:${gateway.port}`, 'GET', '/api/health')).status, host).toBe(200);
      }
    } finally {
      await gateway.stop();
    }
  });

  it('reads no variable the table does not list, even one its runtime would read for itself: TOKIO_WORKER_THREADS=0, which tokio refuses, changes nothing', async () => {
    const gateway = await startGateway({ settings: await settings(), env: env(), unlisted: { TOKIO_WORKER_THREADS: '0' } });
    try {
      expect((await call(gateway.origin, 'GET', '/api/health')).status).toBe(200);
    } finally {
      await gateway.stop();
    }
  });

  it('reaches a broker that requires credentials through the variables the document names — and refuses without them', async () => {
    const [USER, PASSWORD] = ['CONFORMANCE_BROKER_USER', 'CONFORMANCE_BROKER_PASSWORD'];
    const broker = await startBroker({ user: 'gateway', password: 'the-password' });
    try {
      const named = (x: GatewaySettings) => void (x.signal = { type: 'nats', servers: broker.url, userEnv: USER, passwordEnv: PASSWORD });
      const refused: Array<[string, GatewaySettings, GatewayEnvironment, RegExp]> = [
        ['no credentials', await settings((x) => void (x.signal = { type: 'nats', servers: broker.url })), env(), /./],
        ['the wrong password', await settings(named), env({ [USER]: 'gateway', [PASSWORD]: 'not-the-password' }), /./],
        ['a named variable that is unset', await settings(named), env({ [PASSWORD]: 'the-password' }), new RegExp(USER)],
      ];
      for (const [why, s, e, names] of refused) {
        const { code, output } = await refusedBoot({ settings: s, env: e });
        expect(code, `${why}: ${output}`).not.toBe(0);
        expect(code, why).not.toBeNull();
        expect(output, why).toMatch(names);
        expect(output, why).not.toContain('the-password');
      }

      const admitted = await startGateway({ settings: await settings(named), env: env({ [USER]: 'gateway', [PASSWORD]: 'the-password' }) });
      try {
        const token = await issuer.person('broker-user');
        const opened = await subscribe(admitted.origin, token, { clientId: randomUUID(), global: ['beckon:focus'] });
        const stream = opened.stream!;
        await stream.next('the first ping', (m) => m.event === 'ping');
        const mark = randomUUID();
        const reply = await call(admitted.origin, 'POST', '/bus/emit', { token, json: { channel: 'beckon:focus', payload: { annotationId: mark } } });
        expect(reply.status, reply.text).toBe(202);
        await stream.frame('beckon:focus', (f) => f.payload['annotationId'] === mark);
        stream.close();
        expect(stream.violations).toEqual([]);
      } finally {
        await admitted.stop();
      }
    } finally {
      await broker.stop();
    }
  }, 60_000);

  it('refuses to serve with a broker that has no JetStream: the claims table lives there', async () => {
    const broker = await startBroker({ jetstream: false });
    try {
      const s = await settings((x) => void (x.signal = { type: 'nats', servers: broker.url }));
      const { code, output } = await refusedBoot({ settings: s, env: env() });
      expect(code, output).not.toBe(0);
      expect(code, output).not.toBeNull();
    } finally {
      await broker.stop();
    }
  });

  it('serves nothing until the broker has confirmed what it registered: held after its handshake, it does not answer; released, it does', async () => {
    const broker = await startBroker();
    const proxy = await startHoldingProxy(broker.port);
    try {
      proxy.hold();
      const s = await settings((x) => void (x.signal = { type: 'nats', servers: proxy.url }));
      const starting = startGateway({ settings: s, env: env() });
      await new Promise((r) => setTimeout(r, 3_000));
      const early = await fetch(`http://127.0.0.1:${s.port}/api/health`).then((r) => r.status, () => undefined);
      expect(early, 'the gateway answered before the broker had seen its subscriptions').toBeUndefined();
      proxy.release();
      const gateway = await starting;
      try {
        const token = await issuer.person('ready');
        const opened = await subscribe(gateway.origin, token, { clientId: randomUUID(), global: ['beckon:focus'] });
        const stream = opened.stream!;
        await stream.next('the first ping', (m) => m.event === 'ping');
        const mark = randomUUID();
        expect((await call(gateway.origin, 'POST', '/bus/emit', { token, json: { channel: 'beckon:focus', payload: { annotationId: mark } } })).status).toBe(202);
        await stream.frame('beckon:focus', (f) => f.payload['annotationId'] === mark);
        stream.close();
        expect(stream.violations).toEqual([]);
      } finally {
        await gateway.stop();
      }
    } finally {
      await proxy.close();
      await broker.stop();
    }
  }, 60_000);

  it('signs with the first key of JWT_SECRET and accepts a token — agent or media — signed by any key of it, whitespace around the keys ignored', async () => {
    const [oldKey, newKey] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    const mint = async (origin: string) => {
      const service = await issuer.service(PARTICIPANT_CLIENT, [SERVICE_ROLE]);
      const reply = await call(origin, 'POST', '/api/tokens/agent', { token: service, json: { provider: 'p', model: 'm' } });
      expect(reply.status, reply.text).toBe(200);
      return (reply.json as { token: string }).token;
    };
    const accepted = async (origin: string, token: string) => (await call(origin, 'GET', '/api/users/me', { token })).status === 200;
    const resource = 'res-ring';
    archivist.resources.set(resource, { storageUri: `file://${resource}`, mediaType: 'text/plain' });
    archivist.content.set(`file://${resource}`, Buffer.from('ring bytes'));
    const opens = async (origin: string, media: string) => (await call(origin, 'GET', `/api/resources/${resource}?token=${media}`)).status === 200;

    const first = await startGateway({ settings: await settings(), env: env({ JWT_SECRET: oldKey }) });
    const underOld = await mint(first.origin);
    const person = await issuer.person('ring-viewer');
    const mediaUnderOld = ((await call(first.origin, 'POST', '/api/tokens/media', { token: person, json: { resourceId: resource } })).json as { token: string }).token;
    await first.stop();

    const ring = await startGateway({ settings: await settings(), env: env({ JWT_SECRET: ` ${newKey} , ${oldKey} ` }) });
    const underNew = await mint(ring.origin);
    expect(await accepted(ring.origin, underOld)).toBe(true);
    expect(await accepted(ring.origin, underNew)).toBe(true);
    expect(await opens(ring.origin, mediaUnderOld)).toBe(true);
    await ring.stop();

    const onlyNew = await startGateway({ settings: await settings(), env: env({ JWT_SECRET: newKey }) });
    expect(await accepted(onlyNew.origin, underNew)).toBe(true);
    expect(await accepted(onlyNew.origin, underOld)).toBe(false);
    expect(await opens(onlyNew.origin, mediaUnderOld)).toBe(false);
    await onlyNew.stop();
  });
});
