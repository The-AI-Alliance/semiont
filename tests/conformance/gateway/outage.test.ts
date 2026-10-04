/**
 * The broker going away under a running gateway: a stream open across the
 * outage carries on without reconnecting — the gateway reconnects on its own
 * — and an emit made while it is down is refused, never accepted and lost (docs/protocol/
 * TRANSPORT-HTTP.md § POST /bus/emit; docs/operator/administration/
 * TROUBLESHOOTING.md § Commands hang, or real-time updates stop, on a NATS
 * stack). A broker that comes back refusing the gateway's credentials is not
 * recovered from, and every emit after it is refused. NATS only.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { nonConformance } from '../harness/http';
import { eventually } from '../harness/net';
import type { GatewaySettings } from '../harness/gateway';
import { eachPlane, type WorldOptions } from '../harness/world';

const BROADCAST = 'beckon:focus';
/** Where the configuration document tells the gateway to find its broker credential. */
const USER = 'CONFORMANCE_BROKER_USER';
const PASSWORD = 'CONFORMANCE_BROKER_PASSWORD';

/** A broker that admits only a user and password, and a gateway given them. */
const withCredentials: WorldOptions = {
  broker: { user: 'gateway', password: 'the-password' },
  settings: (s: GatewaySettings): GatewaySettings => {
    if (s.signal.type !== 'nats') throw new Error('broker credentials need the NATS plane');
    return { ...s, signal: { ...s.signal, userEnv: USER, passwordEnv: PASSWORD } };
  },
  env: { [USER]: 'gateway', [PASSWORD]: 'the-password' },
};

eachPlane('a broker outage', (world) => {
  it('while the broker is down an emit is refused with 503, never accepted and lost; a stream open across the outage carries frames again once it is back, without reconnecting', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: [BROADCAST] });
    const emitter = await world().person('emitter');

    await world().broker!.down();
    const refused = await eventually('an emit to be refused while the broker is down', 10_000, async () => {
      const reply = await world().emit(emitter, { channel: BROADCAST, payload: {} });
      return reply.status === 503 ? reply : undefined;
    });
    expect(nonConformance('post', '/bus/emit', refused)).toEqual([]);
    await world().broker!.start();

    const after = randomUUID();
    await eventually('an emit after the broker is back to reach the stream', 20_000, async () => {
      if ((await world().emit(emitter, { channel: BROADCAST, payload: { annotationId: after } })).status !== 202) return undefined;
      await new Promise((r) => setTimeout(r, 250));
      return watcher.frames(BROADCAST).some((f) => f.payload['annotationId'] === after) ? true : undefined;
    });
    expect(watcher.closed).toBe(false);
  }, 40_000);
}, withCredentials, ['nats']);

eachPlane('a broker that comes back with other credentials', (world) => {
  it('is not recovered from: every emit after it is refused with 503, and stays refused', async () => {
    const emitter = await world().person('emitter');
    expect((await world().emit(emitter, { channel: BROADCAST, payload: {} })).status).toBe(202);
    await world().broker!.restart({ user: 'gateway', password: 'another-password' });

    const refused = await eventually('an emit to be refused', 30_000, async () => {
      const reply = await world().emit(emitter, { channel: BROADCAST, payload: {} });
      return reply.status === 503 ? reply : undefined;
    });
    expect(nonConformance('post', '/bus/emit', refused)).toEqual([]);
    await new Promise((r) => setTimeout(r, 3_000));
    const still = await world().emit(emitter, { channel: BROADCAST, payload: {} });
    expect(still.status).toBe(503);
    expect(nonConformance('post', '/bus/emit', still)).toEqual([]);
  }, 60_000);
}, withCredentials, ['nats']);
