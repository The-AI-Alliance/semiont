/**
 * The client proxy does what the SDK suite leans on it for, against a real
 * gateway: it carries a stream and an emit through unchanged, records what
 * the client sent and what each stream carried, ends or refuses the client's
 * connections from outside, keeps a request waiting, answers one itself, and
 * passes a stream on a byte at a time.
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

  it('records the events a stream carried as the gateway wrote them, and a stream passed on a byte at a time reaches its client whole', async () => {
    proxy.rechunk(1);
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] }, proxy.origin);
    const annotationId = 'naïve — 日本語 😀';
    await world().emit(await world().person('emitter'), { channel: BROADCAST, payload: { annotationId } });

    const received = await watcher.frame(BROADCAST);
    expect(received.payload).toMatchObject({ annotationId });

    const stream = proxy.requests.find((r) => r.path === '/bus/subscribe')!;
    const carried = await proxy.until('the frame to be recorded', () => stream.events.find((e) => e.event === 'bus-event'));
    expect(JSON.parse(carried.data)).toEqual({ channel: BROADCAST, payload: received.payload });
    expect(stream.events[0]?.event).toBe('ping');
    expect(carried.at).toBeGreaterThan(stream.answered!);
  });

  it('hold keeps a request waiting, recorded and unanswered, until release', async () => {
    proxy.hold((r) => r.path === '/api/health');
    const pending = call(proxy.origin, 'GET', '/api/health');

    const held = await proxy.next('the held request', (r) => r.path === '/api/health');
    expect((await call(proxy.origin, 'GET', '/api/status', { token: await world().person('reader') })).status).toBe(200);
    expect(held.status).toBeUndefined();

    proxy.release();
    expect((await pending).status).toBe(200);
    expect(held.answered).toBeGreaterThan(proxy.requests.find((r) => r.path === '/api/status')!.answered!);
  });

  it('answer answers as many requests as it is told to, itself, and passes the next one on', async () => {
    const refusal = { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' }, body: JSON.stringify({ error: 'refused', code: 'emit-rate' }) };
    proxy.answer((r) => r.path === '/bus/emit', refusal, 1);
    const token = await world().person('emitter');
    const emit = { channel: BROADCAST, payload: {} };

    const refused = await world().emit(token, emit, proxy.origin);
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({ error: 'refused', code: 'emit-rate' });
    expect(proxy.requests.at(-1)).toMatchObject({ status: 429, retryAfter: 2, answer: { error: 'refused', code: 'emit-rate' } });

    expect((await world().emit(token, emit, proxy.origin)).status).toBe(202);
  });
}, {}, ['in-process']);
