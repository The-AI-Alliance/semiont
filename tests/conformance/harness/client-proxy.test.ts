/**
 * The client proxy does what the SDK suites lean on it for, against a real
 * gateway: it carries a stream and an emit through unchanged, records what
 * the client sent, and ends or refuses the client's connections from outside.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { call } from './http';
import { startClientProxy, type ClientProxy } from './client-proxy';
import { eachPlane } from './world';

const BROADCAST = 'beckon:focus';

eachPlane('the client proxy', (world) => {
  let proxy: ClientProxy;

  beforeEach(async () => {
    proxy = await startClientProxy(world().origin);
  });

  afterEach(async () => {
    await proxy.close();
  });

  it('carries a stream and an emit through to the gateway, and records each request with its body', async () => {
    const clientId = randomUUID();
    const watcher = await world().subscribe(await world().person('watcher'), { clientId, global: [BROADCAST] }, proxy.origin);
    const emitted = await world().emit(await world().person('emitter'), { channel: BROADCAST, payload: { annotationId: 'a-1' } }, proxy.origin);

    expect(emitted.status).toBe(202);
    expect((await watcher.frame(BROADCAST)).payload).toMatchObject({ annotationId: 'a-1' });

    const subscribe = await proxy.next('the subscribe', (r) => r.path === '/bus/subscribe');
    expect(subscribe).toMatchObject({ method: 'POST', status: 200, json: { clientId, global: [BROADCAST] } });
    const emit = await proxy.next('the emit', (r) => r.path === '/bus/emit' && r.status !== undefined);
    expect(emit).toMatchObject({ method: 'POST', status: 202, json: { channel: BROADCAST, payload: { annotationId: 'a-1' } } });
    expect(proxy.requests.indexOf(subscribe)).toBeLessThan(proxy.requests.indexOf(emit));
  });

  it('cut ends an open stream from outside the client, and the next connection is accepted', async () => {
    const token = await world().person('watcher');
    const first = await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] }, proxy.origin);

    proxy.cut();
    await first.ends();

    const second = await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] }, proxy.origin);
    expect(second.closed).toBe(false);
  });

  it('down refuses every new connection until up', async () => {
    const token = await world().person('watcher');
    const open = await world().subscribe(token, { clientId: randomUUID(), global: [BROADCAST] }, proxy.origin);

    proxy.down();
    await open.ends();
    await expect(call(proxy.origin, 'GET', '/api/health')).rejects.toThrow();

    proxy.up();
    expect((await call(proxy.origin, 'GET', '/api/health')).status).toBe(200);
  });

  it('answers a refusal with the status the gateway gave, and records it', async () => {
    const refused = await call(proxy.origin, 'POST', '/bus/emit', { json: { channel: BROADCAST, payload: {} } });

    expect(refused.status).toBe(401);
    expect(await proxy.next('the refused emit', (r) => r.path === '/bus/emit' && r.status !== undefined)).toMatchObject({ status: 401 });
  });
}, {}, ['in-process']);
