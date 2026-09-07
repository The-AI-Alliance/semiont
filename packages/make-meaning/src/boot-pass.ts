/**
 * Running a projector's startup repair pass without letting it kill the
 * projector (SIDECAR-BOOT-RESILIENCE P3).
 *
 * The weaver (catch-up, reconcile) and the smelter (reconcile) each repair a
 * derived store they OWN — bringing a graph projection or a vector index back in
 * line with the event log, which is the system of record. That is write-side work,
 * which is why the librarian has none: it is a reader, owns nothing derived, and
 * has nothing to bring back.
 *
 * Both mains used to rethrow a failed pass into the catch-all around `main()`,
 * which exits. Under no restart policy that means gone until a human notices, and
 * one 429 from the gateway was enough (2026-09-07). P1/P2 made the underlying emit
 * retry, which narrows the window; this decides what happens at the end of it.
 *
 * **D4: a failed repair pass is a DATA condition, not a reason to die**, and not a
 * health verdict either — `/health` means "can I reach what I need, and are my
 * expected processes running?", under which "did catch-up succeed at boot?" is
 * neither. Two supports worth keeping: it is a boot-time fact that would be
 * reported forever as a current state, and the old fatality guarded only the ~30 s
 * boot window anyway — a subscription that drops silently an hour later leaves the
 * same stale graph with `/health` still saying `ok`.
 *
 * **The cost, accepted deliberately:** a dead container was a crude staleness
 * alarm and nothing replaces it yet. The `logger.error` here is therefore the only
 * operator-visible signal that a pass failed, until D5 makes `/health` compute
 * what it claims. Do not quiet it.
 *
 * Shared rather than inlined twice so the two mains cannot drift into two
 * different answers about what surviving a failed pass means.
 */

import { errField, type Logger } from '@semiont/core';

export type BootPassState =
  | { phase: 'pending' }
  | { phase: 'running' }
  | { phase: 'done'; summary: unknown }
  | { phase: 'failed'; error: string };

/**
 * Run one boot pass. **Never throws.**
 *
 * `onState` is optional because the two callers record differently: the weaver
 * keeps its phases in `main()` locals that `/health` closes over, while the
 * smelter's `reconcile()` already sets `Smelter.reconcileState` — including the
 * failed phase — before it throws.
 */
export async function runBootPass<T>(
  pass: string,
  run: () => Promise<T>,
  logger: Logger,
  onState?: (state: BootPassState) => void,
): Promise<void> {
  onState?.({ phase: 'running' });
  try {
    const summary = await run();
    onState?.({ phase: 'done', summary });
  } catch (error) {
    onState?.({ phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    logger.error(`Boot pass '${pass}' failed — continuing with a store that may be behind`, {
      pass,
      error: errField(error),
    });
  }
}
