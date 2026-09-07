/**
 * `runBootPass` — a projector's startup repair must not kill the projector
 * (SIDECAR-BOOT-RESILIENCE P3).
 *
 * The weaver and smelter each run repair passes at boot (catch-up, reconcile) and
 * each treated any failure as fatal: rethrow into the catch-all around `main()`,
 * `process.exit(1)`, and — with containers running under no restart policy — gone
 * until a human notices. A single 429 from the gateway was enough (2026-09-07).
 *
 * P1/P2 made the underlying emit retry, which narrows the window but does not
 * change what happens at the end of it. This is that end.
 *
 * Tested here rather than through `weaver-main.ts` because that module calls
 * `main()` at load, so importing it runs it. Extracting the contract is also what
 * makes both mains answer the same way structurally, rather than by two sessions
 * separately remembering to.
 */

import { describe, it, expect, vi } from 'vitest';
import { runBootPass, type BootPassState } from '../boot-pass';

const fakeLogger = () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this as never; }),
});

describe('runBootPass (SIDECAR-BOOT-RESILIENCE P3)', () => {
  it('does NOT rethrow when the pass fails — the process survives', async () => {
    // The whole phase. A rejected boot pass used to reach `main().catch()`, which
    // exits. D4: a failed repair pass is a DATA condition, not a reason to die.
    const logger = fakeLogger();
    await expect(
      runBootPass('catch-up', async () => { throw new Error('/bus/emit 429'); }, logger),
    ).resolves.toBeUndefined();
  });

  it('records the failure, so the phase outlives the pass', async () => {
    // Before P3 this state was written and then made unreachable one line later:
    // the process exited before anything could read what it had just recorded.
    const states: BootPassState[] = [];
    await runBootPass('catch-up', async () => { throw new Error('/bus/emit 429'); },
      fakeLogger(), (s) => states.push(s));

    expect(states.map((s) => s.phase)).toEqual(['running', 'failed']);
    expect(states[1]).toMatchObject({ phase: 'failed', error: expect.stringContaining('429') });
  });

  it('logs the failure at error level — the ONLY operator signal left', async () => {
    // D4 accepts losing the crude staleness alarm that a dead container provided,
    // and does not replace it: `/health` still reports `status: 'ok'` until D5.
    // If this log goes quiet, a projector can fall behind with nothing saying so.
    const logger = fakeLogger();
    await runBootPass('reconcile', async () => { throw new Error('boom'); }, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/reconcile/i);
  });

  it('records running then done with the summary on success', async () => {
    const states: BootPassState[] = [];
    await runBootPass('reconcile', async () => ({ healed: 3 }), fakeLogger(), (s) => states.push(s));

    expect(states.map((s) => s.phase)).toEqual(['running', 'done']);
    expect(states[1]).toMatchObject({ phase: 'done', summary: { healed: 3 } });
  });

  it('does not log an error on the success path', async () => {
    const logger = fakeLogger();
    await runBootPass('catch-up', async () => 'ok', logger);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('works without a state sink — the smelter records its own', async () => {
    // `Smelter.reconcileState` is set inside `reconcile()` before it throws, so
    // that main passes no sink and must not need one.
    const logger = fakeLogger();
    await expect(
      runBootPass('reconcile', async () => { throw new Error('boom'); }, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
