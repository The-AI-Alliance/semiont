/**
 * The broker authentication gate (INTER-COMPONENT-ACCESS P3).
 *
 * Until this existed, `createNatsSignalPlane` connected with a server list and
 * a reconnect policy and nothing else: anyone who could reach NATS could
 * subscribe to every channel and emit on any of them — which means forging
 * events into the distribution path of the system of record.
 *
 * Needs `nats-server` on PATH, like the conformance suite.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createNatsSignalPlane } from '../nats';
import { toReplyAddress } from '../interface';
import { authenticatedNatsFixture, type NatsFixture } from './nats-fixture';

const USER = 'semiont';
const PASS = 'correct-horse-battery-staple';

let fixture: NatsFixture | undefined;
afterAll(() => fixture?.stop());

describe('a broker that requires credentials', () => {
  it('refuses a plane that presents none', async () => {
    fixture ??= await authenticatedNatsFixture(USER, PASS);
    await expect(createNatsSignalPlane({ servers: fixture.servers, reconnect: false }))
      .rejects.toThrow();
  });

  it('refuses a plane presenting the wrong password', async () => {
    fixture ??= await authenticatedNatsFixture(USER, PASS);
    await expect(createNatsSignalPlane({
      servers: fixture.servers, user: USER, pass: 'hunter2', reconnect: false,
    })).rejects.toThrow();
  });

  it('admits a plane presenting the right ones, and it carries frames', async () => {
    fixture ??= await authenticatedNatsFixture(USER, PASS);
    const plane = await createNatsSignalPlane({
      servers: fixture.servers, user: USER, pass: PASS, reconnect: false,
    });
    const seen: unknown[] = [];
    const sub = plane.subscribeClient({
      address: toReplyAddress('auth-1'),
      global: ['beckon:focus'],
      scoped: [],
      onFrame: (_channel, payload) => { seen.push(payload); },
    });
    await plane.flush();
    plane.ingest('beckon:focus', { participant: 'did:web:x', connectionId: 'k' });
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toHaveLength(1);
    sub.close();
    await plane.dispose();
  });
});
