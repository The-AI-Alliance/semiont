/**
 * Weaver Axioms — fast-check property suite.
 *
 * Spec and ledger: `.plans/WEAVER-AXIOMS.md`. Every axiom carries its FOPL
 * statement as a comment directly above the property so spec and test cannot
 * drift. Axioms the current code falsifies are `it.fails(...)`: the property
 * runs, is expected to fail, and the suite stays green. When a refactor makes
 * the behavior correct, `it.fails` errors ("expected to fail but passed") and
 * MUST be promoted to `it(...)` in the same diff.
 *
 * Vocabulary and generators: WEAVER-AXIOMS.md "Vocabulary". σ ranges over
 * well-formed histories (created precedes other ops per resource,
 * per-resource ascending sequence numbers); `foldModel(σ)` is the
 * independent oracle (identity + facets — archived flag, tag set,
 * annotation-id set, entity-type registry; annotation BODIES are outside
 * the v1 model, see W9-deep).
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { EventBus } from '@semiont/core';
import type { StoredEvent } from '@semiont/core';
import { MemoryGraphDatabase } from '@semiont/graph';
import { createWeaveProgress } from '../weave-progress';
import {
  buildWeaverRig,
  dumpGraph,
  dumpModel,
  foldModel,
  maxSeqs,
  awaitMarks,
  serveHistory,
  storedEvent,
  makeAnnotationPayload,
  faultingGraph,
  failKeys,
  failKeysOnce,
} from './helpers/weaver-harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// System-lane (frame:*) applies produce no marks — give them a moment to
// settle after resource marks reach parity, before dumping.
const SETTLE_MS = 25;

// ── Generators (see WEAVER-AXIOMS.md "Vocabulary") ──────────────────────────

interface Catalog { rids: string[]; tags: string[] }

const catalogArb: fc.Arbitrary<Catalog> = fc.record({
  rids: fc.uniqueArray(fc.nat(20).map((n) => `res-${n}`), { minLength: 1, maxLength: 4 }),
  tags: fc.uniqueArray(fc.nat(8).map((n) => `Tag${n}`), { minLength: 1, maxLength: 3 }),
});

interface OpDescriptor {
  rid: string;
  kind: 'archive' | 'unarchive' | 'mark+' | 'mark-' | 'tag+' | 'tag-' | 'frame+';
  tag: string;
  annIdx: number;
}

const opArb = (cat: Catalog): fc.Arbitrary<OpDescriptor> =>
  fc.record({
    rid: fc.constantFrom(...cat.rids),
    kind: fc.constantFrom<OpDescriptor['kind']>(
      'archive', 'unarchive', 'mark+', 'mark-', 'tag+', 'tag-', 'frame+',
    ),
    tag: fc.constantFrom(...cat.tags),
    annIdx: fc.nat(4),
  });

/**
 * Well-formed histories: every catalog resource is created first (seq 1),
 * subsequent ops carry per-resource ascending sequence numbers in emission
 * order. Duplicate adds/removes/tags are deliberately reachable — the folds
 * must tolerate them (W3 relies on it).
 */
function toHistory(cat: Catalog, ops: OpDescriptor[]): StoredEvent[] {
  const seqs = new Map<string, number>(cat.rids.map((r) => [r, 1]));
  let systemSeq = 1000;
  const next = (rid: string): number => {
    const n = (seqs.get(rid) ?? 1) + 1;
    seqs.set(rid, n);
    return n;
  };

  const history: StoredEvent[] = cat.rids.map((rid) =>
    storedEvent('yield:created', rid, {
      name: `Resource ${rid}`,
      format: 'text/plain',
      contentChecksum: `cs-${rid}`,
    }, 1),
  );

  for (const op of ops) {
    const annId = `${op.rid}-ann-${op.annIdx}`;
    switch (op.kind) {
      case 'archive':
        history.push(storedEvent('mark:archived', op.rid, {}, next(op.rid)));
        break;
      case 'unarchive':
        history.push(storedEvent('mark:unarchived', op.rid, {}, next(op.rid)));
        break;
      case 'mark+':
        history.push(storedEvent('mark:added', op.rid, {
          annotation: makeAnnotationPayload(annId, op.rid),
        }, next(op.rid)));
        break;
      case 'mark-':
        history.push(storedEvent('mark:removed', op.rid, { annotationId: annId }, next(op.rid)));
        break;
      case 'tag+':
        history.push(storedEvent('mark:entity-tag-added', op.rid, { entityType: op.tag }, next(op.rid)));
        break;
      case 'tag-':
        history.push(storedEvent('mark:entity-tag-removed', op.rid, { entityType: op.tag }, next(op.rid)));
        break;
      case 'frame+':
        history.push(storedEvent('frame:entity-type-added', undefined, { entityType: op.tag }, ++systemSeq));
        break;
    }
  }
  return history;
}

const historyArb: fc.Arbitrary<StoredEvent[]> = catalogArb.chain((cat) =>
  fc.array(opArb(cat), { maxLength: 25 }).map((ops) => toHistory(cat, ops)),
);

/** σ with redelivery: fc picks indices to duplicate adjacently and to replay displaced at the end. */
const historyWithDupsArb: fc.Arbitrary<{ history: StoredEvent[]; delivered: StoredEvent[] }> =
  historyArb.chain((history) =>
    fc.record({
      adjacent: fc.array(fc.nat(Math.max(0, history.length - 1)), { maxLength: 5 }),
      displaced: fc.array(fc.nat(Math.max(0, history.length - 1)), { maxLength: 5 }),
    }).map(({ adjacent, displaced }) => {
      const delivered: StoredEvent[] = [];
      history.forEach((e, i) => {
        delivered.push(e);
        if (adjacent.includes(i)) delivered.push(e);
      });
      for (const i of displaced) {
        if (history[i]) delivered.push(history[i]);
      }
      return { history, delivered };
    }),
  );

async function runLive(events: StoredEvent[], targets: Map<string, number>, markBudgetMs = 3_000) {
  const rig = await buildWeaverRig();
  try {
    for (const e of events) rig.push(e);
    const reached = await awaitMarks(rig.weaver, targets, markBudgetMs);
    expect(reached).toBe(true);
    await sleep(SETTLE_MS);
    return await dumpGraph(rig.graph);
  } finally {
    await rig.dispose();
  }
}

// ── W4 — Graph ≡ model over arbitrary histories ─────────────────────────────

describe('W4 — graph ≡ model (live pipeline)', () => {
  // ∀ σ: G(σ) ≡ fold(σ)
  it('W4: the live pipeline projects exactly the reference fold', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (history) => {
        const dump = await runLive(history, maxSeqs(history));
        expect(dump).toEqual(dumpModel(foldModel(history)));
      }),
      { numRuns: 50 },
    );
  });
});

// ── W3 — Redelivery idempotence ─────────────────────────────────────────────

describe('W3 — redelivery idempotence', () => {
  // ∀ σ, ∀ σ′ ∈ duplication(σ): G(σ′) ≡ G(σ) (≡ fold(σ) by W4)
  it('W3: adjacent and displaced redelivery leave the projection unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(historyWithDupsArb, async ({ history, delivered }) => {
        // Tight mark budget: a genuine stall IS the falsification — fail
        // fast so fc can shrink instead of tripping the suite timeout.
        const dump = await runLive(delivered, maxSeqs(history), 700);
        expect(dump).toEqual(dumpModel(foldModel(history)));
      }),
      { numRuns: 25 },
    );
  }, 120_000);
});

// ── W5 — Rebuild ≡ replay ───────────────────────────────────────────────────

describe('W5 — rebuild ≡ replay', () => {
  // ∀ σ: RB(σ)|resources ≡ fold(σ)|resources — two roads, one graph.
  // Rebuild's only view of history is the browse responders, exactly as in
  // production. RESOURCE scope: the entity-type registry is excluded here
  // and pinned RED below (W5-frames).
  it('W5: rebuildAll over the served log projects exactly the reference fold (resource scope)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (history) => {
        const rig = await buildWeaverRig();
        const stopServing = serveHistory(rig.eventBus, history);
        try {
          const result = await rig.weaver.rebuildAll();
          expect(result.eventsFailed).toBe(0);
          await sleep(SETTLE_MS);
          expect((await dumpGraph(rig.graph)).resources)
            .toEqual(dumpModel(foldModel(history)).resources);
        } finally {
          stopServing();
          await rig.dispose();
        }
      }),
      { numRuns: 25 },
    );
  });

  // ∀ σ: RB(σ) ≡ fold(σ) INCLUDING the entity-type registry. Was RED
  // 2026-07-13 → 2026-07-18: `frame:entity-type-added` is a system event —
  // it lives in no resource stream, so the per-resource replay can never
  // restore it, while clearDatabase wiped the registry back to the ontology
  // baseline. GREEN via the preserve-and-re-register arm (the ledgered
  // alternative): rebuildAll captures the live-folded registry before the
  // wipe and re-registers it after — the live registry is itself log-derived,
  // and no weaver-readable stream exists to rebuild frames from.
  it('W5-frames: rebuild restores frame-added entity types', async () => {
    const rig = await buildWeaverRig();
    const history = [
      storedEvent('yield:created', 'res-f', {
        name: 'F', format: 'text/plain', contentChecksum: 'cs-f',
      }, 1),
      storedEvent('frame:entity-type-added', undefined, { entityType: 'CustomFrameType' }, 1001),
    ];
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      // Seed the registry the way live traffic would, then rebuild.
      rig.push(history[1]);
      await sleep(SETTLE_MS);
      await rig.weaver.rebuildAll();
      await sleep(SETTLE_MS);
      expect(await rig.graph.getEntityTypes()).toContain('CustomFrameType');
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});

// ── W6 / W10 — mark soundness + honest accounting under faults ──────────────

/** mark:added victims with first-occurrence-unique annotation ids. */
function uniqueMarkAdds(history: StoredEvent[]): StoredEvent[] {
  const seen = new Set<string>();
  const out: StoredEvent[] = [];
  for (const e of history) {
    if (e.type !== 'mark:added') continue;
    const aid = String((e.payload as { annotation: { id: string } }).annotation.id);
    if (seen.has(aid)) continue;
    seen.add(aid);
    out.push(e);
  }
  return out;
}

const annIdOf = (e: StoredEvent): string =>
  String((e.payload as { annotation: { id: string } }).annotation.id);

describe('W6/W10 — the mark never lies; accounting is honest', () => {
  // W6: ∀ φ, r, s: mark(r) = s ⇒ ∀ e (rid(e) = r ∧ seq(e) ≤ s ⇒ applied(e)).
  // W7 coupling: every emitted weave:applied carries a sequence the mark
  // honestly held at emission (signals collected here never exceed the
  // final mark, by monotonicity).
  // W10: applyFailures ≥ injected faults, and zero injected ⇒ zero counted
  // (batch collateral makes strict equality deliberately unattainable —
  // a thrown batch marks its whole live run failed).
  it('W6/W10: failed events pin the mark below them; failures are counted', async () => {
    await fc.assert(
      fc.asyncProperty(
        historyArb,
        fc.array(fc.nat(30), { maxLength: 3 }),
        async (history, picks) => {
          const candidates = uniqueMarkAdds(history);
          const victims = [...new Set(picks.map((p) => candidates[p % Math.max(1, candidates.length)]))]
            .filter((v): v is StoredEvent => !!v);
          const schedule = failKeys(victims.map(annIdOf));
          const { graph, injectedFailures } = faultingGraph(new MemoryGraphDatabase(), schedule);
          const rig = await buildWeaverRig({ graph });

          const signals: Array<{ resourceId: string; sequenceNumber: number }> = [];
          const signalSub = rig.eventBus.get('weave:applied').subscribe((s) => signals.push(s));
          try {
            for (const e of history) rig.push(e);
            await sleep(150);

            // W6 — the mark stays strictly below every failed sequence.
            for (const v of victims) {
              const rid = String(v.resourceId);
              expect(rig.weaver.appliedUpTo(rid) ?? -1).toBeLessThan(v.metadata.sequenceNumber);
            }
            // W10 — honest counting.
            const metrics = rig.weaver.getHealthMetrics();
            expect(injectedFailures()).toBeGreaterThanOrEqual(victims.length > 0 ? 1 : 0);
            expect(metrics.applyFailures).toBeGreaterThanOrEqual(injectedFailures());
            if (victims.length === 0) expect(metrics.applyFailures).toBe(0);
            // W7 coupling — no signal ever exceeded what the mark can claim.
            for (const s of signals) {
              expect(s.sequenceNumber).toBeLessThanOrEqual(rig.weaver.appliedUpTo(s.resourceId) ?? -1);
            }
          } finally {
            signalSub.unsubscribe();
            await rig.dispose();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  // The floor's payoff: a TRANSIENT fault heals — catch-up re-replays from
  // the pinned mark, the retry succeeds, the floor clears, and the
  // projection converges to the model (the W8 recovery shape, single-fault
  // strength here; the full divergence family is W8).
  it('W6-recovery: transient faults converge to the model via catch-up', async () => {
    await fc.assert(
      fc.asyncProperty(
        historyArb,
        fc.nat(30),
        async (history, pick) => {
          const candidates = uniqueMarkAdds(history);
          const victim = candidates[pick % Math.max(1, candidates.length)];
          const schedule = failKeysOnce(victim ? [annIdOf(victim)] : []);
          const { graph } = faultingGraph(new MemoryGraphDatabase(), schedule);
          const rig = await buildWeaverRig({ graph });
          const stopServing = serveHistory(rig.eventBus, history);
          try {
            for (const e of history) rig.push(e);
            await sleep(150);

            await rig.weaver.catchUp();
            await sleep(SETTLE_MS);

            expect(await dumpGraph(rig.graph)).toEqual(dumpModel(foldModel(history)));
            for (const [rid, seq] of maxSeqs(history)) {
              expect(rig.weaver.appliedUpTo(rid)).toBe(seq);
            }
          } finally {
            stopServing();
            await rig.dispose();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ── W2 — Cross-resource progress ────────────────────────────────────────────

describe('W2 — cross-resource progress', () => {
  // ∀ σ, r ≠ r′: faults confined to r never prevent mark(r′) reaching its max.
  it('W2: a failing resource never blocks another resource\'s parity', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (history) => {
        const targets = maxSeqs(history);
        const rids = [...targets.keys()];
        fc.pre(rids.length >= 2);
        const victimRid = rids[0];

        // Fail EVERY mutation that keys on the victim resource or its
        // annotations — its lane wedges completely.
        const victimKeys = new Set<string>([victimRid]);
        for (const e of history) {
          if (String(e.resourceId) === victimRid && e.type === 'mark:added') {
            victimKeys.add(annIdOf(e));
          }
        }
        const { graph } = faultingGraph(new MemoryGraphDatabase(), failKeys(victimKeys));
        const rig = await buildWeaverRig({ graph });
        try {
          for (const e of history) rig.push(e);
          const others = new Map([...targets].filter(([rid]) => rid !== victimRid));
          expect(await awaitMarks(rig.weaver, others)).toBe(true);
        } finally {
          await rig.dispose();
        }
      }),
      { numRuns: 15 },
    );
  });
});

// ── W8 — Recovery convergence over the divergence family ───────────────────

type Divergence = 'lost-checkpoint' | 'stale-checkpoint' | 'rewound-log';

describe('W8 — recovery convergence', () => {
  // ∀ σ, d ∈ {lost ckpt, stale ckpt, rewound log}: a restarted weaver's
  // catchUp() from d converges to fold(σ) with full parity. (A wiped GRAPH
  // under intact marks is deliberately NOT here — that is unwitnessable by
  // catch-up and belongs to reconcile, W9.)
  it('W8: catch-up converges from checkpoint divergence after a restart', async () => {
    await fc.assert(
      fc.asyncProperty(
        historyArb,
        fc.constantFrom<Divergence>('lost-checkpoint', 'stale-checkpoint', 'rewound-log'),
        async (history, divergence) => {
          const graph = new MemoryGraphDatabase();
          const eventBus = new EventBus();

          // First life: process σ live, then stop (the restart shape).
          const rig1 = await buildWeaverRig({ graph, eventBus });
          for (const e of history) rig1.push(e);
          expect(await awaitMarks(rig1.weaver, maxSeqs(history))).toBe(true);
          await rig1.dispose();

          // Second life: fresh weaver over the SAME graph, divergent checkpoint.
          const { MemoryWeaverCheckpoint } = await import('./helpers/weaver-harness');
          const checkpoint = new MemoryWeaverCheckpoint();
          const targets = maxSeqs(history);
          if (divergence === 'stale-checkpoint') {
            checkpoint.seed(Object.fromEntries([...targets].map(([r, s]) => [r, Math.floor(s / 2)])));
          } else if (divergence === 'rewound-log') {
            const [firstRid] = targets.keys();
            checkpoint.seed({ [firstRid]: (targets.get(firstRid) ?? 0) + 100 });
          } // lost-checkpoint: stays empty

          const rig2 = await buildWeaverRig({ graph, eventBus, checkpoint });
          const stopServing = serveHistory(rig2.eventBus, history);
          try {
            const summary = await rig2.weaver.catchUp();
            await sleep(SETTLE_MS);
            expect(summary.eventsFailed).toBe(0);
            expect(await dumpGraph(graph)).toEqual(dumpModel(foldModel(history)));
            for (const [rid, seq] of targets) {
              expect(rig2.weaver.appliedUpTo(rid)).toBe(seq);
            }
          } finally {
            stopServing();
            await rig2.dispose();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ── W9 — Reconcile fixed point + v1 detection completeness ─────────────────

type OobMutation = 'delete-node' | 'flip-archived' | 'mutate-tags' | 'drop-annotation';

describe('W9 — reconcile detects and heals out-of-band divergence', () => {
  // ∀ σ, ∀ single oob mutation δ in the v1 class: reconcile detects δ and
  // heals to fold(σ); an immediate second pass reports divergent = 0.
  it('W9: any single v1-class mutation is detected, healed, and the fixed point holds', async () => {
    await fc.assert(
      fc.asyncProperty(
        historyArb,
        fc.constantFrom<OobMutation>('delete-node', 'flip-archived', 'mutate-tags', 'drop-annotation'),
        fc.nat(10),
        async (history, mutation, pick) => {
          const rig = await buildWeaverRig();
          const stopServing = serveHistory(rig.eventBus, history);
          try {
            for (const e of history) rig.push(e);
            expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);
            await sleep(SETTLE_MS);

            const model = foldModel(history);
            const rids = [...model.resources.keys()];
            const rid = rids[pick % rids.length];
            const { resourceId: mkRid, annotationId: mkAid } = await import('@semiont/core');

            // One out-of-band mutation the Weaver never witnesses.
            let mutated = true;
            switch (mutation) {
              case 'delete-node':
                await rig.graph.deleteResource(mkRid(rid));
                break;
              case 'flip-archived': {
                const doc = await rig.graph.getResource(mkRid(rid));
                if (!doc) { mutated = false; break; }
                await rig.graph.updateResource(mkRid(rid), { archived: !(doc.archived ?? false) });
                break;
              }
              case 'mutate-tags':
                await rig.graph.updateResource(mkRid(rid), { entityTypes: ['OobPhantomTag'] });
                break;
              case 'drop-annotation': {
                const anns = model.resources.get(rid)?.annotations ?? new Set<string>();
                const [first] = anns;
                if (!first) { mutated = false; break; }
                await rig.graph.deleteAnnotation(mkAid(first));
                break;
              }
            }
            // A mutation that changes nothing observable (e.g. phantom tag
            // equal to current set) may legitimately not diverge.
            const before = dumpModel(model);
            const changed = mutated &&
              JSON.stringify((await dumpGraph(rig.graph)).resources) !== JSON.stringify(before.resources);

            const summary = await rig.weaver.reconcile();
            if (changed) expect(summary.divergent).toBeGreaterThanOrEqual(1);
            expect((await dumpGraph(rig.graph)).resources).toEqual(before.resources);

            const second = await rig.weaver.reconcile();
            expect(second.divergent).toBe(0);
          } finally {
            stopServing();
            await rig.dispose();
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  // Was RED (v1 boundary) → GREEN 2026-07-18: reconcile's divergenceOf now
  // compares annotation BODIES canonically (key-order-independent) against
  // the view's truth, so a corrupted-in-place body reads as
  // 'annotation-body-mismatch' and heals from the log — membership equality
  // alone was blind to it (#845 deep-equality checkbox).
  it('W9-deep: reconcile detects in-place annotation body corruption', async () => {
    const rig = await buildWeaverRig();
    const rid = 'res-deep';
    const history = [
      storedEvent('yield:created', rid, { name: 'Deep', format: 'text/plain', contentChecksum: 'cs-d' }, 1),
      storedEvent('mark:added', rid, { annotation: makeAnnotationPayload('ann-deep', rid) }, 2),
    ];
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      for (const e of history) rig.push(e);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      const { annotationId: mkAid } = await import('@semiont/core');
      await rig.graph.updateAnnotation(mkAid('ann-deep'), {
        body: [{ type: 'TextualBody', value: 'CORRUPTED', purpose: 'commenting' }],
      } as never);

      const summary = await rig.weaver.reconcile();
      expect(summary.divergent).toBeGreaterThanOrEqual(1);
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});

// ── W1 / W1-strict — mutual exclusion ───────────────────────────────────────

describe('W1 — per-resource mutual exclusion (pipeline path)', () => {
  // ∀ execution, r, m₁ ≠ m₂ ∈ mut_pipeline(r): the mutation intervals never
  // overlap — groupBy + concatMap serialize each lane even when the store
  // is slow. The wrapper stretches every mutation across real time so an
  // overlap, if possible, would be observed.
  it('W1: pipeline mutations for one resource never overlap in time', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (history) => {
        const inner = new MemoryGraphDatabase();
        const intervals = new Map<string, Array<{ start: number; end: number }>>();
        let clock = 0;
        const MUTS = new Set([
          'createResource', 'batchCreateResources', 'updateResource', 'deleteResource',
          'createAnnotation', 'createAnnotations', 'updateAnnotation', 'deleteAnnotation',
        ]);
        const slow = new Proxy(inner, {
          get(target, prop, receiver) {
            const name = String(prop);
            const original = Reflect.get(target, prop, receiver);
            if (!MUTS.has(name) || typeof original !== 'function') {
              return typeof original === 'function' ? original.bind(target) : original;
            }
            return async (...args: unknown[]) => {
              // Key intervals by the resource the weaver's lane owns: the
              // harness histories key annotations as `${rid}-ann-…`.
              const raw = name === 'createAnnotation' ? String((args[0] as { id: string }).id)
                : name === 'createAnnotations' ? String((args[0] as Array<{ id: string }>)[0]?.id ?? '')
                : name === 'batchCreateResources' ? String((args[0] as Array<{ '@id': string }>)[0]?.['@id'] ?? '')
                : String((args[0] as { '@id'?: string })?.['@id'] ?? args[0]);
              const rid = raw.includes('-ann-') ? raw.slice(0, raw.indexOf('-ann-')) : raw;
              const start = ++clock;
              await new Promise((r) => setTimeout(r, 3));
              const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(target, args);
              const end = ++clock;
              const list = intervals.get(rid) ?? [];
              list.push({ start, end });
              intervals.set(rid, list);
              return result;
            };
          },
        }) as MemoryGraphDatabase;

        const rig = await buildWeaverRig({ graph: slow });
        try {
          for (const e of history) rig.push(e);
          expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);
          for (const [, list] of intervals) {
            const sorted = [...list].sort((a, b) => a.start - b.start);
            for (let i = 1; i < sorted.length; i++) {
              expect(sorted[i].start).toBeGreaterThan(sorted[i - 1].end);
            }
          }
        } finally {
          await rig.dispose();
        }
      }),
      { numRuns: 10 },
    );
  });

  // KNOWN false: heals (weave:rebuild, reconcile's rebuildResource) bypass
  // the pipeline lanes — a heal racing a live write on the same resource
  // can stale-overwrite it (found deterministic shape: clear-then-replay
  // drops a live event applied mid-rebuild, and the monotone mark still
  // claims it). Flips when #845's "lane-clean heals" checkbox lands.
  it.fails('W1-strict: a rebuild racing live traffic never loses the live write', async () => {
    const rid = 'res-race';
    const history = [
      storedEvent('yield:created', rid, { name: 'Race', format: 'text/plain', contentChecksum: 'cs-r' }, 1),
    ];
    const inner = new MemoryGraphDatabase();
    let releaseClear: () => void = () => {};
    const gated = new Proxy(inner, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (String(prop) !== 'clearDatabase' || typeof original !== 'function') {
          return typeof original === 'function' ? original.bind(target) : original;
        }
        return async (...args: unknown[]) => {
          await new Promise<void>((resolve) => { releaseClear = resolve; });
          return (original as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as MemoryGraphDatabase;

    const rig = await buildWeaverRig({ graph: gated });
    const stopServing = serveHistory(rig.eventBus, history);
    try {
      rig.push(history[0]);
      expect(await awaitMarks(rig.weaver, maxSeqs(history))).toBe(true);

      // Rebuild starts and parks inside clearDatabase…
      const rebuild = rig.weaver.rebuildAll();
      await sleep(20);
      // …a live tag lands mid-rebuild…
      rig.push(storedEvent('mark:entity-tag-added', rid, { entityType: 'LiveTag' }, 2));
      expect(await awaitMarks(rig.weaver, new Map([[rid, 2]]))).toBe(true);
      // …then the rebuild clears and replays the SERVED history (no tag).
      releaseClear();
      await rebuild;
      await sleep(SETTLE_MS);

      const doc = await inner.getResource((await import('@semiont/core')).resourceId(rid));
      // The live write must survive a racing heal — today it does not.
      expect(doc?.entityTypes ?? []).toContain('LiveTag');
    } finally {
      stopServing();
      await rig.dispose();
    }
  });
});

// ── W7 — WeaveProgress fold monotonicity ────────────────────────────────────

describe('W7 — the barrier fold is monotone', () => {
  // ∀ signal sequences: appliedUpTo(r) never decreases.
  it('W7: appliedUpTo never regresses under arbitrary signal sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ rid: fc.nat(3).map((n) => `res-${n}`), seq: fc.nat(50) }),
          { maxLength: 60 },
        ),
        (signals) => {
          const bus = new EventBus();
          const progress = createWeaveProgress(bus);
          try {
            const high = new Map<string, number>();
            for (const { rid, seq } of signals) {
              bus.get('weave:applied').next({ resourceId: rid, sequenceNumber: seq });
              const now = progress.appliedUpTo(rid) ?? -1;
              expect(now).toBeGreaterThanOrEqual(high.get(rid) ?? -1);
              expect(now).toBeGreaterThanOrEqual(seq > (high.get(rid) ?? -1) ? seq : -1);
              high.set(rid, Math.max(high.get(rid) ?? -1, now));
            }
          } finally {
            progress.dispose();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
