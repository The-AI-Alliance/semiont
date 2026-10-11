/**
 * Running a projector's startup repair pass without letting it kill the
 * projector.
 *
 * The smelter's reconcile repairs a derived store it OWNS: it brings a vector
 * index back in line with the event log, which is the system of record. That is
 * write-side work, which is why the librarian has none: it is a reader, owns
 * nothing derived, and has nothing to bring back.
 *
 * A failed pass rethrown into the catch-all around `main()` exits the process.
 * Under no restart policy that means gone until a human notices, and one 429
 * from the gateway is enough. The underlying emit retries a retryable refusal,
 * which narrows the window; this decides what happens at the end of it.
 *
 * **A failed repair pass is a DATA condition, not a reason to die**, and not a
 * health verdict either — `/health` means "can I reach what I need, and are my
 * expected processes running?", under which "did reconcile succeed at boot?" is
 * neither. Two supports: it is a boot-time fact that would be reported forever
 * as a current state, and dying on it would guard only the ~30 s boot window
 * anyway — a subscription that drops silently an hour later leaves the same
 * stale index with `/health` saying `ok`.
 *
 * **The cost, accepted deliberately:** a dead container is a crude staleness
 * alarm and nothing stands in for it. The `logger.error` here is therefore the
 * only alarm that a pass failed. Do not quiet it.
 */

import { errField, type Logger } from '@semiont/core';

/**
 * Run one boot pass. **Never throws.**
 *
 * It records nothing of how the pass went: the smelter's `reconcile()` sets
 * `Smelter.reconcileState`, the failed phase included, before it throws, and
 * that is what its `/health` serves.
 */
export async function runBootPass<T>(pass: string, run: () => Promise<T>, logger: Logger): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.error(`Boot pass '${pass}' failed — continuing with a store that may be behind`, {
      pass,
      error: errField(error),
    });
  }
}
