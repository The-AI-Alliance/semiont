/**
 * The Signal Plane conformance suite — THE SPEC (SIGNAL-PLANE D2, P0.3).
 *
 * Parameterized by driver; P1 adds the NATS entry against a real
 * `nats-server`. Suite discipline, because this is where portability to a
 * future broker is decided: assert D2's contract, not a broker's grain —
 *  - ordering per channel + scope at most, never across channels;
 *  - at-most-once with duplicates tolerated (never strict no-dup);
 *  - asynchronous settling with generous budgets, no sub-millisecond timing
 *    assumptions (the in-process driver is synchronous; the contract is not);
 *  - both subscription modes: every client subscriber sees a broadcast; a
 *    handler-mode frame reaches at most one member, never two;
 *  - the driver cannot refuse a delivery and never inspects a payload
 *    (P0.5): entitlement is the gateway's, above the seam.
 */
import { afterAll, describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@semiont/core';
import type { PlaneEnvelope } from '../interface';
import type { SignalPlane } from '../interface';
import { toReplyAddress } from '../interface';
import { resolveSignalPlaneOptions } from '../options';
import { createInProcessSignalPlane } from '../in-process';
import { createNatsSignalPlane } from '../nats';
import { natsFixture } from './nats-fixture';

/** Generous async settling: poll, never assume synchronous delivery. */
async function settle(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return; // let the assertion report the state
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Frame = { channel: string; payload: unknown; scope: string | undefined; meta?: Record<string, string> };
const collector = () => {
  const frames: Frame[] = [];
  return {
    frames,
    // The third argument is the ENVELOPE on every fabric now — the conformance
    // suite is where a driver's contract is decided, so it records the whole
    // envelope rather than pulling one field out of it.
    onFrame: (channel: string, payload: unknown, envelope: PlaneEnvelope) =>
      frames.push({ channel, payload, scope: envelope.scope, meta: envelope.meta }),
  };
};

/**
 * Duplicates-tolerated ordering assertion: `expected` must appear as an
 * in-order subsequence of `got`, and `got` may contain nothing outside
 * `expected` — repeats allowed (at-most-once is the DRIVER's obligation to
 * strive for; a rare duplicate must not fail the suite, a reorder must).
 */
function expectInOrder(got: readonly unknown[], expected: readonly unknown[]): void {
  let i = 0;
  for (const g of got) {
    if (i < expected.length && JSON.stringify(g) === JSON.stringify(expected[i])) i++;
    else {
      expect(expected.map((e) => JSON.stringify(e)), `unexpected frame ${JSON.stringify(g)}`)
        .toContain(JSON.stringify(g));
    }
  }
  expect(i, `delivered ${i}/${expected.length} in order`).toBe(expected.length);
}

const drivers: Array<[string, () => Promise<{ plane: SignalPlane; teardown(): void }>]> = [
  [
    'in-process',
    async () => {
      const bus = new EventBus();
      const plane = createInProcessSignalPlane(bus, resolveSignalPlaneOptions());
      return { plane, teardown: () => { plane.dispose(); bus.destroy(); } };
    },
  ],
  [
    'nats',
    async () => {
      const { servers } = await natsFixture();
      const plane = await createNatsSignalPlane({ servers, reconnect: false });
      return { plane, teardown: () => plane.dispose() };
    },
  ],
];

afterAll(async () => {
  const fixture = await natsFixture().catch(() => undefined);
  fixture?.stop();
});

describe.each(drivers)('SignalPlane conformance — %s', (_name, make) => {
  test('client mode: an ingested frame reaches a global subscriber, with the payload intact', async () => {
    const { plane, teardown } = await make();
    try {
      const c = collector();
      plane.subscribeClient({ address: toReplyAddress('c1'), global: ['beckon:focus'], scoped: [], onFrame: c.onFrame });
      const payload = { participant: 'did:web:x', connectionId: 'k' };
      plane.ingest('beckon:focus', payload);
      await settle(() => c.frames.length >= 1);
      expectInOrder(c.frames, [{ channel: 'beckon:focus', payload, scope: undefined }]);
    } finally {
      teardown();
    }
  });

  test('client mode: EVERY subscriber receives a broadcast', async () => {
    const { plane, teardown } = await make();
    try {
      const a = collector();
      const b = collector();
      plane.subscribeClient({ address: toReplyAddress('a'), global: ['beckon:focus'], scoped: [], onFrame: a.onFrame });
      plane.subscribeClient({ address: toReplyAddress('b'), global: ['beckon:focus'], scoped: [], onFrame: b.onFrame });
      plane.ingest('beckon:focus', { n: 1 });
      await settle(() => a.frames.length >= 1 && b.frames.length >= 1);
      expect(a.frames.length).toBeGreaterThanOrEqual(1);
      expect(b.frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      teardown();
    }
  });

  test('scoped delivery: a scoped frame reaches only the matching scope entry, tagged with its scope', async () => {
    const { plane, teardown } = await make();
    try {
      const c = collector();
      plane.subscribeClient({
        address: toReplyAddress('c1'),
        global: [],
        scoped: [{ scope: 'res-A', channels: ['mark:added'] }],
        onFrame: c.onFrame,
      });
      plane.ingest('mark:added', { id: 'in-scope' }, { scope: 'res-A' });
      plane.ingest('mark:added', { id: 'other-scope' }, { scope: 'res-B' });
      plane.ingest('mark:added', { id: 'unscoped' });
      await settle(() => c.frames.length >= 1);
      // Only the res-A frame; neither the other scope nor the unscoped one.
      expectInOrder(c.frames, [{ channel: 'mark:added', payload: { id: 'in-scope' }, scope: 'res-A' }]);
    } finally {
      teardown();
    }
  });

  test('ordering holds per channel + scope (and nothing more is promised)', async () => {
    const { plane, teardown } = await make();
    try {
      const c = collector();
      plane.subscribeClient({ address: toReplyAddress('c1'), global: ['beckon:focus'], scoped: [], onFrame: c.onFrame });
      const sent = [1, 2, 3, 4, 5].map((n) => ({ n }));
      for (const p of sent) plane.ingest('beckon:focus', p);
      await settle(() => c.frames.length >= sent.length);
      expectInOrder(c.frames, sent.map((payload) => ({ channel: 'beckon:focus', payload, scope: undefined })));
    } finally {
      teardown();
    }
  });

  test('close() ends delivery; other subscriptions are untouched', async () => {
    const { plane, teardown } = await make();
    try {
      const a = collector();
      const b = collector();
      const subA = plane.subscribeClient({ address: toReplyAddress('a'), global: ['beckon:focus'], scoped: [], onFrame: a.onFrame });
      plane.subscribeClient({ address: toReplyAddress('b'), global: ['beckon:focus'], scoped: [], onFrame: b.onFrame });
      subA.close();
      plane.ingest('beckon:focus', { n: 1 });
      await settle(() => b.frames.length >= 1);
      expect(a.frames.length).toBe(0);
      expect(b.frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      teardown();
    }
  });

  test('handler mode: a frame reaches AT MOST ONE member of a group, never two', async () => {
    const { plane, teardown } = await make();
    try {
      const m1 = collector();
      const m2 = collector();
      plane.subscribeHandlers('workers', ['job:create'], m1.onFrame);
      plane.subscribeHandlers('workers', ['job:create'], m2.onFrame);
      const sent = Array.from({ length: 8 }, (_, i) => ({ i }));
      for (const p of sent) plane.ingest('job:create', p);
      await settle(() => m1.frames.length + m2.frames.length >= sent.length);
      // Never two: no frame delivered to both members.
      const seen1 = new Set(m1.frames.map((f) => JSON.stringify(f.payload)));
      for (const f of m2.frames) {
        expect(seen1.has(JSON.stringify(f.payload)), `frame ${JSON.stringify(f.payload)} reached BOTH members`).toBe(false);
      }
      // At-most-once overall: no more total deliveries than frames sent.
      expect(m1.frames.length + m2.frames.length).toBeLessThanOrEqual(sent.length);
    } finally {
      teardown();
    }
  });

  test('handler mode and client mode are independent: a client subscriber still sees every frame', async () => {
    const { plane, teardown } = await make();
    try {
      const handler = collector();
      const client = collector();
      plane.subscribeHandlers('workers', ['job:create'], handler.onFrame);
      plane.subscribeClient({ address: toReplyAddress('c1'), global: ['job:create'], scoped: [], onFrame: client.onFrame });
      const sent = [{ i: 1 }, { i: 2 }, { i: 3 }];
      for (const p of sent) plane.ingest('job:create', p);
      await settle(() => client.frames.length >= sent.length);
      expectInOrder(client.frames, sent.map((payload) => ({ channel: 'job:create', payload, scope: undefined })));
    } finally {
      teardown();
    }
  });

  test('P0.5 — the driver cannot refuse: a correlated-channel frame with a foreign key is delivered anyway', async () => {
    const { plane, teardown } = await make();
    try {
      const c = collector();
      // `gather:summary-result` is a correlated reply channel; the payload
      // carries a key this subscriber has no claim on. Refusal is the
      // GATEWAY's entitlement gate, above the seam — the driver delivers.
      plane.subscribeClient({ address: toReplyAddress('c1'), global: ['gather:summary-result'], scoped: [], onFrame: c.onFrame });
      plane.ingest('gather:summary-result', { correlationId: 'someone-elses', summary: 'x' });
      await settle(() => c.frames.length >= 1);
      expect(c.frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      teardown();
    }
  });

  test('deliver: an addressed frame reaches EVERY subscriber of that address and nobody else', async () => {
    const { plane, teardown } = await make();
    try {
      // Two holders of one address (the N-replica shared-ledger-address
      // case P3 builds on) and a bystander. The envelope label is not
      // registry vocabulary — the driver moves it opaque.
      const h1 = collector();
      const h2 = collector();
      const other = collector();
      plane.subscribeClient({ address: toReplyAddress('shared'), global: [], scoped: [], onFrame: h1.onFrame });
      plane.subscribeClient({ address: toReplyAddress('shared'), global: [], scoped: [], onFrame: h2.onFrame });
      plane.subscribeClient({ address: toReplyAddress('elsewhere'), global: [], scoped: [], onFrame: other.onFrame });
      plane.deliver(toReplyAddress('shared'), 'x:label', { n: 7 });
      await settle(() => h1.frames.length >= 1 && h2.frames.length >= 1);
      for (const held of [h1, h2]) {
        expect(held.frames.length).toBeGreaterThanOrEqual(1);
        expect(held.frames[0]).toEqual({ channel: 'x:label', payload: { n: 7 }, scope: undefined });
      }
      await settle(() => other.frames.length > 0, 200);
      expect(other.frames).toEqual([]);
    } finally {
      teardown();
    }
  });

  test('deliver: closing the subscription ends addressed delivery too', async () => {
    const { plane, teardown } = await make();
    try {
      const c = collector();
      const sub = plane.subscribeClient({ address: toReplyAddress('closing'), global: [], scoped: [], onFrame: c.onFrame });
      plane.deliver(toReplyAddress('closing'), 'x:label', { n: 1 });
      await settle(() => c.frames.length >= 1);
      expect(c.frames.length).toBeGreaterThanOrEqual(1);
      sub.close();
      plane.deliver(toReplyAddress('closing'), 'x:label', { n: 2 });
      await settle(() => c.frames.length > 1, 200);
      expect(c.frames.length).toBe(1);
    } finally {
      teardown();
    }
  });
});

describe('in-process extras — capabilities the CONTRACT leaves optional', () => {
  test('observer receipt: exact counts, zero when nobody subscribes (only an in-process fabric can count)', async () => {
    const bus = new EventBus();
    const plane = createInProcessSignalPlane(bus, resolveSignalPlaneOptions());
    try {
      expect(plane.ingest('beckon:focus', { n: 0 }).observers).toBe(0);
      const c = collector();
      plane.subscribeClient({ address: toReplyAddress('c1'), global: ['beckon:focus'], scoped: [], onFrame: c.onFrame });
      expect(plane.ingest('beckon:focus', { n: 1 }).observers).toBeGreaterThanOrEqual(1);
      await settle(() => c.frames.length >= 1);
    } finally {
      plane.dispose();
      bus.destroy();
    }
  });
});

describe('P0.5 — the driver never learns the correlation vocabulary (census)', () => {
  test("no driver file mentions 'correlationId'; the ledger is gateway policy and exempt", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const driverFiles = readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && f !== 'ledger.ts',
    );
    expect(driverFiles.length).toBeGreaterThanOrEqual(4); // interface, in-process, options, channels, index
    // CODE, not prose: the interface's docstring legitimately states the ban
    // by name. Strip comments, then the word must not survive.
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const f of driverFiles) {
      const source = stripComments(readFileSync(join(dir, f), 'utf-8'));
      expect(source.includes('correlationId'), `${f} code must not know the correlation vocabulary`).toBe(false);
    }
  });
});
