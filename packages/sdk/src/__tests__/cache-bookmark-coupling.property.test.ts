/**
 * C1 — the persisted bookmark never leads the persisted content.
 *
 * For any interleaving of event delivery, refetch completion, debounce
 * advance, bystander-document writes, and reload: if the persisted bookmark
 * is B, every event with id ≤ B has its effect present in the persisted
 * cache documents — and after reload + replay from B+1, rendered state
 * equals server truth.
 *
 * This is the invariant `cache-persister.ts`'s header states in prose
 * ("may therefore LAG the caches … but can never lead them"). Without the
 * quiescence gate it is false: doc B's write flushes the stashed bookmark
 * while doc A's content is mid-refetch or mid-debounce. The V1/V2 append
 * axioms (event-sourcing) hold server-side; this invariant is client-side.
 *
 * Everything here is the REAL machinery — InMemorySessionStorage,
 * coupledLastEventId, sessionStoragePersister, createCache — driven by a
 * command interpreter: `deliver` (event arrives: bookmark stashed + cache A
 * invalidated), `complete` (A's oldest in-flight fetch answers with CURRENT
 * server truth — the V1/V2 read-your-writes guarantee), `writeB` (bystander
 * cache B mutates and its save flushes — the write that triggers a bookmark
 * flush), `settleA` (A's debounce fires), `reload` (crash semantics: nothing
 * flushes, fresh rig over the same storage, replay from bookmark+1).
 *
 * The quiescence gate (B17-Q) — the bookmark may flush only when every
 * persisted cache is quiet — is justified here by counterexample rather
 * than by argument: the ungated rig violates C1 on `[deliver, writeB]`, and
 * with the gate no generated interleaving does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { InMemorySessionStorage } from '../session/session-storage';
import { resourceId } from '@semiont/core';
import { BOOKMARK_KEY, DEBOUNCE_MS, KEY, bookmarkSeq, buildRig, persistedAUpTo } from './helpers/persisted-cache-rig';

type Command = 'deliver' | 'complete' | 'writeB' | 'settleA';

describe('C1 — the persisted bookmark never leads the persisted content', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * Interpret one command sequence, then reload and check both halves of C1.
   * `gated` toggles the quiescence gate so the property doubles as its own
   * teeth: the ungated rig must violate C1 for the counterexample sequences.
   */
  async function runScenario(commands: Command[], gated: boolean): Promise<{
    c1Held: boolean; renderedEqualsServer: boolean;
  }> {
    const storage = new InMemorySessionStorage();
    let serverSeq = 0;

    let rig = buildRig(storage, gated);
    // Warm A so the persisted doc exists (mirrors "resource was open before").
    rig.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    for (const cmd of commands) {
      switch (cmd) {
        case 'deliver':
          serverSeq += 1;
          rig.saveLastEventId(resourceId('r1'), `p-r1-${serverSeq}`);
          rig.cacheA.invalidate(KEY);
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

    // ── C1, first half: at reload time (crash semantics — nothing else
    // flushes), the persisted bookmark must not lead persisted content.
    const c1Held = persistedAUpTo(storage) >= bookmarkSeq(storage);

    // ── Reload: abandon the rig un-disposed (dispose would flush the
    // pending save — a crash does not), kill its timers, rebuild, resume.
    vi.clearAllTimers();
    rig = buildRig(storage, gated);
    rig.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    // Replay exists ONLY when a bookmark was persisted — a connect with no
    // `Last-Event-ID` is live-only and the server replays nothing. (Modelling
    // an absent bookmark as "replay from 1" is backwards: it heals scenarios
    // the real client cannot. See cache-reload-fidelity.property.test.ts
    // for the full note.)
    const resumeFrom = storage.get(BOOKMARK_KEY) !== null ? bookmarkSeq(storage) + 1 : null;
    if (resumeFrom !== null) {
      for (let seq = resumeFrom; seq <= serverSeq; seq++) {
        rig.cacheA.invalidate(KEY);   // replay re-invalidates idempotently
      }
    }
    while (rig.resolvers.length > 0) rig.resolvers.shift()!({ upTo: serverSeq });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // ── C1, corollary: rendered state == server truth.
    const renderedEqualsServer = (rig.cacheA.get(KEY)?.upTo ?? 0) === serverSeq;
    rig.dispose();
    return { c1Held, renderedEqualsServer };
  }

  it('K1 (quiescence-gate keystone): a bystander write while A is mid-refetch does NOT flush the bookmark; the next quiet write does', async () => {
    const storage = new InMemorySessionStorage();
    const rig = buildRig(storage, true);
    rig.cacheA.observe(KEY).subscribe({ next: () => {}, error: () => {} });
    rig.resolvers.shift()!({ upTo: 0 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Event 1 arrives: bookmark stashed, A's refetch in flight.
    rig.saveLastEventId(resourceId('r1'), 'p-r1-1');
    rig.cacheA.invalidate(KEY);

    // Bystander B writes its document. Ungated, this flushes p-r1-1 while
    // A's content is at 0; the gate must hold it back.
    rig.cacheB.set('et', { upTo: 1 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(storage.get(BOOKMARK_KEY)).toBeNull();

    // A completes and its own save fires — everyone quiet — THAT write
    // carries the bookmark through.
    rig.resolvers.shift()!({ upTo: 1 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(JSON.parse(storage.get(BOOKMARK_KEY)!)).toEqual({ r1: 'p-r1-1' });
    expect(persistedAUpTo(storage)).toBe(1);
    rig.dispose();
  });

  it('K2 (gated): deliver → complete → bystander write → crash-reload renders server truth', async () => {
    const { c1Held, renderedEqualsServer } = await runScenario(
      ['deliver', 'complete', 'writeB'],   // reload lands inside A's debounce window
      true,
    );
    expect(c1Held).toBe(true);
    expect(renderedEqualsServer).toBe(true);
  });

  it('teeth: the UNGATED rig violates C1 on deliver → bystander write', async () => {
    // The mid-REFETCH window (A's reply not yet in when B's document write
    // flushes the bookmark). Note `[deliver, complete, writeB]` does NOT
    // violate even ungated: A's own debounced save shares B's deadline and
    // fires first, landing content before the flush — the write-ordering
    // coupling covers that narrower path, and only that one.
    const { c1Held } = await runScenario(
      ['deliver', 'writeB'],
      false,
    );
    // Ungated: B's write flushes bookmark 1 while A's refetch is in
    // flight — the persisted doc says 0, the bookmark says 1, and replay
    // from 2 redelivers nothing. That storage violation is what this pins.
    expect(c1Held).toBe(false);
    // The stale render is not asserted: B18 (refetch-on-rehydrate)
    // revalidates on reload and paints server truth even when the bookmark
    // leads the content. Defense in depth — see the matching note in
    // cache-reload-fidelity.property.test.ts.
  });

  it('C1 property: no interleaving of deliver/complete/writeB/settleA + crash-reload breaks the invariant (gated)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Command>('deliver', 'complete', 'writeB', 'settleA'), { maxLength: 12 }),
        async (commands) => {
          const { c1Held, renderedEqualsServer } = await runScenario(commands, true);
          if (!c1Held) throw new Error(`C1 violated: bookmark leads persisted content after [${commands.join(', ')}]`);
          if (!renderedEqualsServer) throw new Error(`stale render after reload: [${commands.join(', ')}]`);
        },
      ),
      { numRuns: 60 },
    );
  });
});
