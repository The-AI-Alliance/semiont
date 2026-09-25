/**
 * The shared table's contract (LEDGER-STATE-TO-THE-BROKER P3): one suite, both
 * drivers, so neither implementation's shape becomes the interface.
 *
 * "Two handles" means what a second replica is: under NATS, a second plane on
 * its own connection; in-process, a second handle on the one plane, because
 * that fabric is the process.
 *
 * The NATS half runs on the JetStream fixture. The signal plane's conformance
 * suite keeps its JetStream-off server; only the ledger's storage needs this.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { EventBus } from '@semiont/core';
import { createInProcessSignalPlane } from '../in-process';
import type { SharedTable, SignalPlane } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { jetStreamNatsFixture } from './nats-fixture';

interface Fabric {
  /** Two handles on one named table, as two replicas would hold it. */
  open(name: string, ttlMs: number): Promise<[SharedTable, SharedTable]>;
  close(): void;
}

let tableSeq = 0;
const uniqueName = () => `t${Date.now().toString(36)}_${tableSeq++}`;

const fabrics: Array<[string, () => Promise<Fabric>]> = [
  [
    'in-process',
    async () => {
      const bus = new EventBus();
      const plane = createInProcessSignalPlane(bus);
      return {
        open: async (name, ttlMs) => [await plane.table(name, ttlMs), await plane.table(name, ttlMs)],
        close: () => {
          plane.dispose();
          bus.destroy();
        },
      };
    },
  ],
  [
    'nats',
    async () => {
      const { servers } = await jetStreamNatsFixture();
      const planes: SignalPlane[] = [
        await createNatsSignalPlane({ servers, reconnect: false }),
        await createNatsSignalPlane({ servers, reconnect: false }),
      ];
      return {
        open: async (name, ttlMs) => [await planes[0]!.table(name, ttlMs), await planes[1]!.table(name, ttlMs)],
        close: () => {
          for (const p of planes) p.dispose();
        },
      };
    },
  ],
];

async function settle(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
}

afterAll(async () => {
  const fixture = await jetStreamNatsFixture().catch(() => undefined);
  fixture?.stop();
});

describe.each(fabrics)('shared table — %s', (_name, make) => {
  test('create is atomic across handles: the first wins, every later one is refused', async () => {
    const fabric = await make();
    try {
      const [a, b] = await fabric.open(uniqueName(), 60_000);
      expect(await a.create('k', 'first')).toBe(true);
      expect(await b.create('k', 'second')).toBe(false);
      expect(await a.create('k', 'third')).toBe(false);
      expect(await b.read('k')).toBe('first');
    } finally {
      fabric.close();
    }
  });

  test('read is authoritative: a value created through one handle is read through the other', async () => {
    const fabric = await make();
    try {
      const [a, b] = await fabric.open(uniqueName(), 60_000);
      expect(await b.read('absent')).toBeUndefined();
      await a.create('present', 'v');
      expect(await b.read('present')).toBe('v');
    } finally {
      fabric.close();
    }
  });

  test('watch delivers what is already there before it resolves, then what is created after', async () => {
    const fabric = await make();
    try {
      const [a, b] = await fabric.open(uniqueName(), 60_000);
      await a.create('before', '1');
      const seen = new Map<string, string>();
      const sub = await b.watch((key, value) => seen.set(key, value));
      expect(seen.get('before'), 'existing entries arrive before watch resolves').toBe('1');
      await a.create('after', '2');
      await settle(() => seen.has('after'));
      expect(seen.get('after')).toBe('2');
      sub.close();
    } finally {
      fabric.close();
    }
  });

  test('any string is a key: nothing about its characters reaches the fabric', async () => {
    const fabric = await make();
    try {
      const [a, b] = await fabric.open(uniqueName(), 60_000);
      const key = 'a:b.c *>/ é\u0000end';
      const seen = new Map<string, string>();
      const sub = await b.watch((k, v) => seen.set(k, v));
      expect(await a.create(key, 'odd')).toBe(true);
      expect(await b.read(key)).toBe('odd');
      await settle(() => seen.has(key));
      expect(seen.get(key)).toBe('odd');
      sub.close();
    } finally {
      fabric.close();
    }
  });

  test('tables are independent by name', async () => {
    const fabric = await make();
    try {
      const [one] = await fabric.open(uniqueName(), 60_000);
      const [two] = await fabric.open(uniqueName(), 60_000);
      expect(await one.create('k', 'one')).toBe(true);
      expect(await two.create('k', 'two')).toBe(true);
      expect(await one.read('k')).toBe('one');
      expect(await two.read('k')).toBe('two');
    } finally {
      fabric.close();
    }
  });

  test('an entry older than the table TTL is gone, and its key can be created again', async () => {
    const fabric = await make();
    try {
      const [a, b] = await fabric.open(uniqueName(), 1_000);
      expect(await a.create('short', 'lived')).toBe(true);
      // Past the TTL, with room for the broker's expiry timer.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(await b.read('short'), 'expired').toBeUndefined();
      expect(await a.create('short', 'again'), 'the key is free again').toBe(true);
    } finally {
      fabric.close();
    }
  }, 15_000);
});
