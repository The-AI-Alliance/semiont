/**
 * SIGNAL-PLANE-FLUSH P3 — the boot gate, asserted as ORDER rather than grepped.
 *
 * The defect this guards is not a missing call, it is a missing *wait*: the
 * gateway composes its handler subscriptions and then serves HTTP, and under a
 * broker the registration of that interest is asynchronous. A request landing
 * in the window reaches a queue group with no member, `ingest` reports zero
 * observers, and the gateway's unanswerable-request synthesis fires
 * `peer-unavailable` — attributing a boot race to an absent service.
 *
 * A grep for `await plane.flush()` would pass on a call whose promise nobody
 * waits for, which is the exact bug in a different costume. So this drives the
 * real ordering through a plane whose flush is DEFERRED, and asserts that
 * serving has not begun while it is outstanding.
 *
 * It does not import the gateway's entry module — that boots Postgres, JWT and
 * a listener. It asserts the contract that entry module must honour, over the
 * same seam, which is the part a regression would break.
 *
 * THE MODEL IS NOT THE GATE. `boot()` below is a hand-written stand-in for
 * `index.ts`, so the two order assertions prove the pattern is sound and
 * nothing about the shipped sequence — `index.ts` could drop its `await`
 * outright and they would both stay green (measured). The third test reads
 * `index.ts` itself and is the only one a real regression trips.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { SignalPlane } from '../interface';

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '../../index.ts');

/** A plane whose `flush()` resolves only when the test says so. */
function deferredFlushPlane(): { plane: SignalPlane; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const plane = {
    ingest: vi.fn(() => ({})),
    subscribeClient: vi.fn(() => ({ close: vi.fn() })),
    subscribeHandlers: vi.fn(() => ({ close: vi.fn() })),
    deliver: vi.fn(),
    flush: vi.fn(() => gate),
    dispose: vi.fn(),
  } as unknown as SignalPlane;
  return { plane, release };
}

/**
 * The boot sequence's shape, as `index.ts` performs it: compose the handler
 * subscriptions, await the plane's readiness, then serve.
 */
async function boot(plane: SignalPlane, serve: () => void): Promise<void> {
  plane.subscribeHandlers('gateway', ['job:create'], () => {});
  await plane.flush();
  serve();
}

describe('the readiness gate (SIGNAL-PLANE-FLUSH D4)', () => {
  it('does not serve while the plane has not confirmed its subscriptions', async () => {
    const { plane, release } = deferredFlushPlane();
    const serve = vi.fn();

    const booting = boot(plane, serve);
    // Let every already-queued microtask run. If `flush()` were called without
    // being awaited, `serve` would have run by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(serve, 'served before the plane confirmed registration').not.toHaveBeenCalled();
    expect(plane.subscribeHandlers, 'subscribed before flushing').toHaveBeenCalled();

    release();
    await booting;
    expect(serve, 'served once the plane confirmed').toHaveBeenCalledTimes(1);
  });

  it('subscribes BEFORE it flushes — the order that makes the flush mean anything', async () => {
    const order: string[] = [];
    const plane = {
      ingest: vi.fn(() => ({})),
      subscribeClient: vi.fn(() => ({ close: vi.fn() })),
      subscribeHandlers: vi.fn(() => { order.push('subscribe'); return { close: vi.fn() }; }),
      deliver: vi.fn(),
      flush: vi.fn(async () => { order.push('flush'); }),
      dispose: vi.fn(),
    } as unknown as SignalPlane;

    await boot(plane, () => order.push('serve'));

    // A flush before the subscription proves nothing about that subscription.
    expect(order).toEqual(['subscribe', 'flush', 'serve']);
  });

  it('index.ts AWAITS its readiness flush, and does it before serve()', () => {
    // The two tests above drive a model. This one reads the shipped sequence,
    // because that is where the regression would live: a reworded call, a lost
    // `await`, or a flush that drifted below `serve()`.
    const source = readFileSync(INDEX, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const flush = source.search(/await\s+[^;]*?\bflush\b/);
    expect(flush, 'no awaited flush in index.ts — the readiness gate is gone').toBeGreaterThan(-1);

    const serveAt = source.search(/\bserve\s*\(\s*\{/);
    expect(serveAt, 'no serve({...}) call found in index.ts').toBeGreaterThan(-1);
    expect(flush, 'the readiness flush must be awaited BEFORE serve()').toBeLessThan(serveAt);
  });
});
