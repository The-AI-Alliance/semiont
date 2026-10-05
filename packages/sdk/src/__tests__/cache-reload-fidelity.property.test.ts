/**
 * A1/A4 — reload fidelity across event arrival.
 *
 * The transport's read loop stashes `Last-Event-ID` AFTER the awaited apply
 * fan-out (`actor-state-unit.ts`): an id is stashable only once its event's
 * effects are pending or done — pinned at the transport by the "stashes an
 * id only AFTER the event has been applied" test in
 * `actor-state-unit.test.ts`. Between the apply and the stash only
 * microtasks can interleave; the flush only ever runs inside a macrotask (a
 * debounced save's document write), so the apply→stash pair is atomic with
 * respect to the flush path.
 *
 * The opposite order loses an event across a reload. In a receive→apply gap
 * nothing is in flight and no save is pending, so `persistencePending()`
 * reports quiet and a bystander document write flushes a bookmark whose
 * event no cache has absorbed. Reload replays from bookmark+1; the event is
 * never re-delivered; the stale document renders forever. fast-check
 * shrinks that loss to `[receive, writeB]`.
 *
 * THE MODEL HERE therefore has `arrive` = invalidate-then-stash (the
 * guaranteed seam order), and keeps the stash-before-apply ordering
 * expressible as the teeth (`receiveLegacy`/`applyLegacy`) — the suite must
 * be able to demonstrate the loss, so a change in the transport ordering is
 * caught twice: at the transport pin, and here.
 *
 * Axioms:
 *   A1  reload fidelity — after reload+replay, rendered state == server truth
 *   A4  rehydrate is never worse than cold
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { InMemorySessionStorage } from '../session/session-storage';
import { resourceId } from '@semiont/core';
import { BOOKMARK_KEY, DEBOUNCE_MS, KEY, bookmarkSeq, buildRig, persistedAUpTo } from './helpers/persisted-cache-rig';

/**
 * `arrive`        — the seam as it is: the bus handler invalidates, THEN the
 *                   id is stashed (the order actor-state-unit guarantees).
 * `receiveLegacy` — TEETH ONLY: the stash-before-apply half…
 * `applyLegacy`   — …and its detached apply. Together they reproduce the
 *                   ordering the transport pin outlaws.
 * The remaining commands match the C1 model exactly.
 */
type Command = 'arrive' | 'receiveLegacy' | 'applyLegacy' | 'complete' | 'writeB' | 'settleA';

describe('A1/A4 — reload fidelity across event arrival', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function runScenario(commands: Command[]): Promise<{
    c1Held: boolean;
    renderedEqualsServer: boolean;
    rendered: number;
    serverSeq: number;
  }> {
    const storage = new InMemorySessionStorage();
    let serverSeq = 0;
    let unapplied = 0; // `receiveLegacy` events not yet applied

    let rig = buildRig(storage, true);
    // Warm A so a persisted document exists ("the resource was already open").
    rig.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const cmd of commands) {
      switch (cmd) {
        case 'arrive':
          serverSeq += 1;
          rig.cacheA.invalidate(KEY);              // apply first…
          rig.saveLastEventId(resourceId('r1'), `p-r1-${serverSeq}`); // …stash second (the seam's order)
          break;
        case 'receiveLegacy':
          serverSeq += 1;
          unapplied += 1;
          rig.saveLastEventId(resourceId('r1'), `p-r1-${serverSeq}`);
          break;
        case 'applyLegacy':
          if (unapplied > 0) { unapplied -= 1; rig.cacheA.invalidate(KEY); }
          break;
        case 'complete':
          rig.resolvers.shift()?.({ upTo: serverSeq });
          await vi.advanceTimersByTimeAsync(0);
          break;
        case 'writeB':
          rig.cacheB.set('et', { upTo: serverSeq });
          await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
          break;
        case 'settleA':
          await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
          break;
      }
    }

    const c1Held = persistedAUpTo(storage) >= bookmarkSeq(storage);

    // Reload with crash semantics: the rig is abandoned un-disposed
    // (a crash flushes nothing), timers die, a fresh rig loads the same
    // storage and resumes.
    vi.clearAllTimers();
    rig = buildRig(storage, true);
    rig.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    // Replay exists ONLY when a bookmark was persisted. The transport sends
    // `Last-Event-ID` only if it loaded one (`actor-state-unit.ts`: "fresh
    // connections send no header"), and a connect without it gets a
    // live-only stream — the server replays NOTHING. Modelling an ABSENT
    // bookmark as "replay from 1" is backwards: it heals every scenario
    // with invalidations the real client never gets. Absent is a real
    // state: while the B17-Q gate holds the bookmark pending, storage has
    // no lastEventId key at all.
    const resumeFrom = storage.get(BOOKMARK_KEY) !== null ? bookmarkSeq(storage) + 1 : null;
    if (resumeFrom !== null) {
      for (let seq = resumeFrom; seq <= serverSeq; seq++) rig.cacheA.invalidate(KEY);
    }
    while (rig.resolvers.length > 0) rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const rendered = rig.cacheA.get(KEY)?.upTo ?? 0;
    rig.dispose();
    return { c1Held, renderedEqualsServer: rendered === serverSeq, rendered, serverSeq };
  }

  /**
   * K5 — an arrival, then a bystander write: the sequence stash-before-apply
   * loses. With apply-before-stash, A is already in flight when the id is
   * stashed, so the bystander's flush attempt finds the gate SHUT; the
   * bookmark lags; replay re-delivers.
   */
  it('K5: arrive → bystander write → crash-reload renders server truth', async () => {
    const r = await runScenario(['arrive', 'writeB']);
    expect(r.c1Held, 'C1: persisted content must not trail the bookmark').toBe(true);
    expect(
      r.renderedEqualsServer,
      `A1: after reload the client rendered upTo=${r.rendered} but server truth is ${r.serverSeq}`,
    ).toBe(true);
  });

  /**
   * TEETH — the stash-before-apply ordering, driven manually. The transport
   * pin in actor-state-unit.test.ts outlaws this order at the seam; this
   * test keeps the loss demonstrable so the suite cannot be defanged by a
   * quiet flip of that ordering. If the transport's order flips, TWO tests
   * fail: the ordering pin there, and (should anyone then "fix" the pin
   * by deleting it) this one names the user-visible consequence.
   */
  it('teeth: the stash-before-apply ordering violates C1 (bookmark leads content)', async () => {
    const r = await runScenario(['receiveLegacy', 'writeB', 'applyLegacy']);
    // That ordering breaks the storage invariant: the bookmark reaches 1
    // while the persisted document is at 0.
    expect(r.c1Held).toBe(false);
    // DELIBERATELY NOT asserting a stale render. B18
    // (refetch-on-rehydrate) heals the user-visible symptom even when C1 is
    // violated — the reload revalidates and paints server truth regardless
    // of what replay would have delivered. That is the two layers working
    // as intended, not one defect guarded twice: C1 is the invariant
    // apply-before-stash exists to keep true (it governs keys nothing
    // observes after reload, and cross-resource resumes), and C1 is what
    // this test pins. Without B18, the render assertion belongs here.
  });

  /**
   * K6 — BOUNDARY: holds under either ordering. A bare debounce advance
   * does not flush the stashed bookmark; only an actual cache-document write
   * does. If this fails, the flush path itself changed.
   */
  it('K6 (boundary): arrive → settle → crash-reload renders server truth', async () => {
    const r = await runScenario(['arrive', 'settleA']);
    expect(r.renderedEqualsServer,
      `A1: rendered upTo=${r.rendered}, server truth ${r.serverSeq}`).toBe(true);
  });

  /**
   * A1 as a property over the apply-before-stash seam: no interleaving of
   * arrivals, completions, bystander writes, and settles breaks reload
   * fidelity. With the teeth above able to fail, this is the model-level
   * verdict that apply-before-stash closes the fast path.
   */
  it('A1 property: no interleaving of arrive/complete/writeB/settleA breaks reload fidelity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom<Command>('arrive', 'complete', 'writeB', 'settleA'),
          { maxLength: 12 },
        ),
        async (commands) => {
          const r = await runScenario(commands);
          return r.c1Held && r.renderedEqualsServer;
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * A4 — rehydrate is never worse than cold, on the sequence
   * stash-before-apply loses. Mechanism-independent: it holds whatever
   * keeps A1 to account.
   */
  it('A4: a rehydrating client renders no worse than a cold one', async () => {
    const commands: Command[] = ['arrive', 'writeB'];
    const warm = await runScenario(commands);

    // Cold baseline: same server truth, empty storage, must fetch.
    const coldStorage = new InMemorySessionStorage();
    const cold = buildRig(coldStorage, true);
    cold.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    while (cold.resolvers.length > 0) cold.resolvers.shift()!({ upTo: warm.serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const coldRendered = cold.cacheA.get(KEY)?.upTo ?? 0;
    cold.dispose();

    expect(coldRendered, 'cold client is the baseline and must see server truth').toBe(warm.serverSeq);
    expect(
      warm.rendered,
      `A4: rehydrated client rendered ${warm.rendered}, cold client rendered ${coldRendered}`,
    ).toBe(coldRendered);
  });
});
