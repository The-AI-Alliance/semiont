/**
 * `runBootPass` — a projector's startup repair must not kill the projector.
 *
 * The smelter runs a repair pass at boot (reconcile). A failure rethrown into
 * the catch-all around `main()` is `process.exit(1)`, and — with containers
 * running under no restart policy — gone until a human notices. A single 429
 * from the gateway is enough.
 *
 * The underlying emit retries a retryable refusal, which narrows the window but
 * does not change what happens at the end of it. This is that end.
 *
 * Tested here rather than through `smelter-main.ts` because that module calls
 * `main()` at load, so importing it runs it.
 */

import { describe, it, expect, vi } from 'vitest';
import { runBootPass } from '../boot-pass';

const fakeLogger = () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this as never; }),
});

describe('runBootPass', () => {
  it('does NOT rethrow when the pass fails — the process survives', async () => {
    // The whole point. A rejection that reached `main().catch()` would exit. A
    // failed repair pass is a DATA condition, not a reason to die.
    const logger = fakeLogger();
    await expect(
      runBootPass('reconcile', async () => { throw new Error('/bus/emit 429'); }, logger),
    ).resolves.toBeUndefined();
  });

  it('logs the failure at error level — the ONLY operator signal left', async () => {
    // Staying up gives away the crude staleness alarm that a dead container
    // is, and nothing replaces it: `/health` reports `status: 'ok'` whatever
    // a pass did. If this log goes quiet, a projector can fall behind with nothing
    // saying so.
    const logger = fakeLogger();
    await runBootPass('reconcile', async () => { throw new Error('boom'); }, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/reconcile/i);
  });

  it('does not log an error on the success path', async () => {
    const logger = fakeLogger();
    await runBootPass('reconcile', async () => 'ok', logger);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
