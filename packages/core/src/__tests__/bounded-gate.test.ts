/**
 * boundedGate — cap concurrent async work across every caller of one gate.
 *
 * The two failure modes worth naming are silent: work that starts at enqueue
 * time caps nothing, and a rejection that reaches the gate's own subscription
 * kills it, so every later job hangs forever.
 */

import { describe, it, expect, vi } from 'vitest';
import { boundedGate } from '../bounded-gate';

/** A job whose completion this test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('boundedGate', () => {
  it('caps in-flight work across callers, not per call', async () => {
    // The arithmetic that motivated this: a limiter inside one call bounds that
    // call, so N concurrent callers get N × the "cap". The gate is one object
    // shared by every caller, which is the only shape that actually caps.
    const gate = boundedGate(2);
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: 8 }, () => deferred());

    const runs = gates.map((d) =>
      gate(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await d.promise;
        inFlight--;
      }),
    );

    await tick();
    expect(peak).toBe(2);

    for (const d of gates) { d.resolve(); await tick(); }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('does not invoke work until a slot frees', async () => {
    // The `defer` trap: build the promise when the job is enqueued and the work
    // is already running, whatever the gate does afterwards.
    const gate = boundedGate(1);
    const first = deferred();
    const second = vi.fn(async () => {});

    const a = gate(() => first.promise);
    const b = gate(second);

    await tick();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    await a;
    await tick();
    expect(second).toHaveBeenCalledTimes(1);
    await b;
  });

  it('a rejecting job leaves the gate alive', async () => {
    // A rejection that reaches the outer subscription errors it, and the gate is
    // dead — permanently, silently, and only for callers that arrive later.
    const gate = boundedGate(1);

    await expect(gate(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate(async () => 'still here')).resolves.toBe('still here');
  });

  it('acquires in submission order, so queued work cannot be starved', async () => {
    // Not about ordering — results are used by index, not arrival. The property
    // is that a queued job cannot be indefinitely overtaken: at concurrency 1
    // against a reconcile wave, an unfair gate leaves one resource waiting for
    // as long as work keeps arriving.
    const gate = boundedGate(1);
    const started: number[] = [];
    const blocker = deferred();

    const jobs = [
      gate(async () => { started.push(0); await blocker.promise; }),
      ...Array.from({ length: 4 }, (_, i) =>
        gate(async () => { started.push(i + 1); }),
      ),
    ];

    await tick();
    expect(started).toEqual([0]);

    blocker.resolve();
    await Promise.all(jobs);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('propagates the resolved value to its own caller', async () => {
    const gate = boundedGate(2);
    await expect(gate(async () => 42)).resolves.toBe(42);
  });
});
