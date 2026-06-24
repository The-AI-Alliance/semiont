/**
 * Smelter Axioms — fast-check property suite.
 *
 * Spec and ledger: `.plans/SMELTER-AXIOMS.md`. Every axiom carries its FOPL
 * statement as a comment directly above the property so spec and test cannot
 * drift. Axioms the current code falsifies are `it.fails(...)`: the property
 * runs, is expected to fail, and the suite stays green. When a refactor makes
 * the behavior correct, `it.fails` errors ("expected to fail but passed") and
 * MUST be promoted to `it(...)` in the same diff.
 *
 * Current ledger: all GREEN. (S9b flipped by R2; S1 and S2 flipped by R3 —
 * reconcile became a planner whose work items flow through the mailbox;
 * S12 flipped by R5 — checksum-stamped vectors + staleness diff.)
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Subject } from 'rxjs';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import { calculateChecksum } from '@semiont/content';
import { MemoryVectorStore, chunkText } from '@semiont/vectors';
import type { ChunkingConfig, EmbeddingChunk, AnnotationPayload } from '@semiont/vectors';
import { textExtractionOf } from '@semiont/core';
import { Smelter, type SmelterTiming } from '../smelter';
import type { SmelterEvent } from '../smelter-actor-state-unit';
import { partitionByType } from '../batch-utils';
import {
  mockLogger,
  deterministicEmbed,
  createMockEmbeddingProvider,
  makeAnnotation,
  annotationEvent,
  resourceDescriptor,
  createContentTransport,
  createFakeKsBus,
  type ContentEntry,
} from './helpers/smelter-harness';

const CHUNKING: ChunkingConfig = { chunkSize: 512, overlap: 64 };
const TIMING: SmelterTiming = { burstWindowMs: 1, maxBatchSize: 100, idleTimeoutMs: 2 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, maxMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (cond()) return true;
    await sleep(2);
  }
  return cond();
}

/**
 * Drive a fast-check scheduler beside the pipeline's real (1ms) timers:
 * resolve scheduled tasks one at a time in fc-chosen order, yielding to the
 * event loop when none are pending, until `done` reports settled.
 */
async function pump(s: fc.Scheduler, done: () => boolean, maxMs = 4000): Promise<void> {
  const t0 = Date.now();
  let confirmed = 0;
  while (Date.now() - t0 < maxMs) {
    if (s.count() > 0) {
      confirmed = 0;
      await s.waitOne();
      continue;
    }
    // Require a few consecutive empty-and-done checks: a lane continuation
    // may schedule its next content read a tick after `done` flips true.
    if (done() && ++confirmed >= 3) return;
    await sleep(3);
  }
  throw new Error('pump: did not settle');
}

// ── Generators (see SMELTER-AXIOMS.md "Vocabulary") ─────────────────────────

const ridArb = fc.nat(9999).map((n) => `res-${n}`);
const textArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);
// The smelter's media gate, as inlined at both smelter.ts call sites:
// "embed anything that decodes as text" (MEDIA-TYPES.md decision 7).
const embeds = (mediaType: string) => textExtractionOf(mediaType) === 'decode';

// Pools by gate outcome: decodable types embed; the rest (binary, and
// pdf-text-layer until SMELTER-MEDIA-TYPES.md lands its dispatch) are skipped.
const textMediaArb = fc.constantFrom('text/plain', 'text/markdown', 'text/html; charset=utf-8', 'application/json');
const binaryMediaArb = fc.constantFrom('application/pdf', 'image/png', 'application/octet-stream', 'application/zip');
const mediaTypeArb = fc.oneof(textMediaArb, binaryMediaArb);

interface CatalogEntry {
  rid: string;
  mediaType: string;
  text: string;
  annotations: { aid: string; exact: string }[];
}

function toCatalog(raw: { rid: string; mediaType: string; text: string; exacts: string[] }[]): CatalogEntry[] {
  return raw.map((e) => ({
    rid: e.rid,
    mediaType: e.mediaType,
    text: e.text,
    annotations: e.exacts.map((exact, i) => ({ aid: `${e.rid}-ann-${i}`, exact })),
  }));
}

const catalogArb: fc.Arbitrary<CatalogEntry[]> = fc
  .uniqueArray(
    fc.record({ rid: ridArb, mediaType: mediaTypeArb, text: textArb, exacts: fc.array(textArb, { maxLength: 3 }) }),
    { selector: (e) => e.rid, maxLength: 6 },
  )
  .map(toCatalog);

const nonEmptyTextCatalogArb: fc.Arbitrary<CatalogEntry[]> = fc
  .uniqueArray(
    fc.record({ rid: ridArb, mediaType: textMediaArb, text: textArb, exacts: fc.array(textArb, { maxLength: 2 }) }),
    { selector: (e) => e.rid, minLength: 1, maxLength: 4 },
  )
  .map(toCatalog);

function eventArbFor(catalog: CatalogEntry[]): fc.Arbitrary<SmelterEvent> {
  return fc
    .record({
      entry: fc.constantFrom(...catalog),
      kind: fc.constantFrom(
        'yield:created', 'yield:updated', 'yield:representation-added',
        'mark:archived', 'mark:added', 'mark:removed',
      ),
      annIdx: fc.nat(2),
    })
    .map(({ entry, kind, annIdx }): SmelterEvent => {
      if (kind === 'mark:added' || kind === 'mark:removed') {
        const ann = entry.annotations[annIdx % Math.max(1, entry.annotations.length)];
        if (!ann) return { type: 'yield:created', resourceId: entry.rid, payload: {} };
        if (kind === 'mark:added') return annotationEvent(entry.rid, ann.aid, ann.exact);
        return { type: 'mark:removed', resourceId: entry.rid, payload: { annotationId: ann.aid } };
      }
      return { type: kind, resourceId: entry.rid, payload: {} };
    });
}

const catalogWithSeqArb: fc.Arbitrary<[CatalogEntry[], SmelterEvent[]]> = catalogArb
  .filter((c) => c.length > 0)
  .chain((catalog) => fc.tuple(fc.constant(catalog), fc.array(eventArbFor(catalog), { maxLength: 12 })));

// ── Reference model (see SMELTER-AXIOMS.md: model(σ)) ───────────────────────

interface ModelIds {
  resources: string[];
  annotations: string[];
}

function modelFold(catalog: CatalogEntry[], seq: SmelterEvent[]): ModelIds {
  const byRid = new Map(catalog.map((e) => [e.rid, e]));
  const anchorOf = new Map<string, string>();
  for (const e of catalog) for (const a of e.annotations) anchorOf.set(a.aid, e.rid);

  const resources = new Set<string>();
  const annotations = new Set<string>();
  for (const ev of seq) {
    const rid = ev.resourceId;
    if (!rid) continue;
    switch (ev.type) {
      case 'yield:created':
      case 'yield:updated':
      case 'yield:representation-added': {
        const entry = byRid.get(rid);
        if (entry && embeds(entry.mediaType)) resources.add(rid);
        break;
      }
      case 'mark:archived': {
        resources.delete(rid);
        for (const [aid, anchor] of anchorOf) if (anchor === rid) annotations.delete(aid);
        break;
      }
      case 'mark:added': {
        const annotation = ev.payload.annotation as { id?: string } | undefined;
        if (annotation?.id) annotations.add(annotation.id);
        break;
      }
      case 'mark:removed': {
        const aid = ev.payload.annotationId as string | undefined;
        if (aid) annotations.delete(aid);
        break;
      }
    }
  }
  return { resources: [...resources].sort(), annotations: [...annotations].sort() };
}

// ── Instrumented store + harness ────────────────────────────────────────────

interface InstrumentState {
  holdMs: number;
  violations: string[];
  lastUpsertTexts: Map<string, string[]>;
  upsertCounts: Map<string, number>;
  inFlight: Map<string, number>;
  aidAnchor: Map<string, string>;
  activity: { at: number };
}

/**
 * Wrap the store so every mutation is keyed by resourceId, records overlap
 * violations (the S1 detector), captures the texts of the last resource
 * upsert (the S2/S5 oracle), and optionally holds each mutation open for
 * `holdMs` so logically-concurrent mutations are observably concurrent.
 */
function instrument(inner: MemoryVectorStore, state: InstrumentState): MemoryVectorStore {
  const keyOf = new Map<PropertyKey, (args: unknown[]) => string>([
    ['upsertResourceVectors', (a) => String(a[0])],
    ['deleteResourceVectors', (a) => String(a[0])],
    ['upsertAnnotationVector', (a) => String((a[2] as AnnotationPayload).resourceId)],
    ['deleteAnnotationVector', (a) => state.aidAnchor.get(String(a[0])) ?? String(a[0])],
    ['deleteAnnotationVectorsForResource', (a) => String(a[0])],
  ]);
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      const extract = keyOf.get(prop);
      if (!extract) return method.bind(target);
      return async (...args: unknown[]): Promise<unknown> => {
        state.activity.at = Date.now();
        if (prop === 'upsertResourceVectors') {
          state.lastUpsertTexts.set(String(args[0]), (args[1] as EmbeddingChunk[]).map((c) => c.text));
          state.upsertCounts.set(String(args[0]), (state.upsertCounts.get(String(args[0])) ?? 0) + 1);
        }
        if (prop === 'upsertAnnotationVector') {
          state.aidAnchor.set(String(args[0]), String((args[2] as AnnotationPayload).resourceId));
        }
        const key = extract(args);
        const inFlight = (state.inFlight.get(key) ?? 0) + 1;
        state.inFlight.set(key, inFlight);
        if (inFlight > 1) state.violations.push(`${String(prop)}@${key}`);
        try {
          if (state.holdMs > 0) await sleep(state.holdMs);
          return await method.apply(target, args);
        } finally {
          state.inFlight.set(key, (state.inFlight.get(key) ?? 1) - 1);
          state.activity.at = Date.now();
        }
      };
    },
  });
}

interface Harness {
  events$: Subject<SmelterEvent>;
  smelter: Smelter;
  store: MemoryVectorStore;
  violations: string[];
  lastUpsertTexts: Map<string, string[]>;
  upsertCounts: Map<string, number>;
  setText: (rid: string, text: string) => void;
  ids: () => Promise<ModelIds>;
  settle: () => Promise<void>;
  stop: () => void;
}

async function makeHarness(opts: {
  catalog: CatalogEntry[];
  /** Reuse a connected store across harnesses — the S12 "worker restart". */
  store?: MemoryVectorStore;
  schedule?: fc.Scheduler;
  holdMs?: number;
  failRids?: ReadonlySet<string>;
}): Promise<Harness> {
  const entries = new Map<string, ContentEntry>(
    opts.catalog.map((e) => [e.rid, { text: e.text, mediaType: e.mediaType }]),
  );
  const inner = opts.store ?? new MemoryVectorStore();
  if (!opts.store) await inner.connect();
  const state: InstrumentState = {
    holdMs: opts.holdMs ?? 0,
    violations: [],
    lastUpsertTexts: new Map(),
    upsertCounts: new Map(),
    inFlight: new Map(),
    aidAnchor: new Map(),
    activity: { at: Date.now() },
  };
  const store = instrument(inner, state);

  const transport = createContentTransport({
    read: (rid) => (opts.failRids?.has(rid) ? 'fail' : entries.get(rid)),
    wrap: opts.schedule ? (p, label) => opts.schedule!.schedule(p, label) : undefined,
  });
  const bus = createFakeKsBus(
    opts.catalog.map((e) => resourceDescriptor(e.rid, e.mediaType, calculateChecksum(e.text))),
    new Map(opts.catalog.map((e) => [e.rid, e.annotations.map((a) => makeAnnotation(e.rid, a.aid, a.exact))])),
  );

  const events$ = new Subject<SmelterEvent>();
  const smelter = new Smelter(events$, store, createMockEmbeddingProvider(), transport, bus, CHUNKING, TIMING, mockLogger);
  smelter.initialize();

  return {
    events$,
    smelter,
    store,
    violations: state.violations,
    lastUpsertTexts: state.lastUpsertTexts,
    upsertCounts: state.upsertCounts,
    setText: (rid, text) => {
      const entry = entries.get(rid);
      entries.set(rid, { text, mediaType: entry?.mediaType ?? 'text/plain' });
    },
    ids: async () => ({
      resources: [...(await inner.listResourceChecksums()).keys()].sort(),
      annotations: [...(await inner.listAnnotationIds())].sort(),
    }),
    settle: async (quietMs = 30, maxMs = 5000) => {
      const t0 = Date.now();
      for (;;) {
        const pending = [...state.inFlight.values()].reduce((a, b) => a + b, 0);
        if (pending === 0 && Date.now() - state.activity.at >= quietMs) return;
        if (Date.now() - t0 > maxMs) throw new Error('settle timeout');
        await sleep(5);
      }
    },
    stop: () => smelter.stop(),
  };
}

async function replayIds(catalog: CatalogEntry[], seq: SmelterEvent[]): Promise<ModelIds> {
  const h = await makeHarness({ catalog });
  try {
    for (const e of seq) h.events$.next(e);
    await h.settle();
    return await h.ids();
  } finally {
    h.stop();
  }
}

// ── P0: pure-function laws ──────────────────────────────────────────────────

describe('P0 — pure laws', () => {
  // P0a (FOPL): ∀ σ, ρ = partitionByType(σ):
  //   concat(ρ) = σ ∧ (∀ run ∈ ρ. ∀ e,e′ ∈ run. type(e) = type(e′))
  //   ∧ (∀ i ∈ [1,|ρ|). type(ρᵢ[0]) ≠ type(ρᵢ₋₁[0]))
  it('P0a: partitionByType is a lossless, order-preserving, maximal uniform partition', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ type: fc.constantFrom('a', 'b', 'c', 'd') })), (evs) => {
        const runs = partitionByType(evs);
        expect(runs.flat()).toEqual(evs);
        for (const run of runs) expect(new Set(run.map((e) => e.type)).size).toBe(1);
        for (let i = 1; i < runs.length; i++) expect(runs[i][0].type).not.toBe(runs[i - 1][0].type);
      }),
      { numRuns: 500 },
    );
  });

  // P0b (FOPL): ∀ m ∈ M: m = "text/" ⧺ s → extraction(m) = decode
  // — the registry gate never narrows the old text/* prefix gate
  // (MEDIA-TYPES.md decision 7: "embed anything that decodes as text").
  // Widened admissions and the deferred pdf tier are pinned as examples;
  // the gate expression itself is `textExtractionOf(m) === 'decode'`.
  it('P0b: the media gate embeds exactly what decodes as text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }).map((s) => `text/${s}`), (mt) => {
        expect(textExtractionOf(mt)).toBe('decode');
      }),
      { numRuns: 500 },
    );
    expect(embeds('application/json')).toBe(true);          // structured text joins the old gate
    expect(embeds('text/x-foo')).toBe(true);                // registry-miss text/* (RFC 2046 fallback)
    expect(embeds('application/zip')).toBe(false);          // binary stays out
    expect(embeds('application/octet-stream')).toBe(false);
    expect(embeds('application/pdf')).toBe(false);          // pdf-text-layer ≠ decode: deferred to
    expect(textExtractionOf('application/pdf')).toBe('pdf-text-layer'); // SMELTER-MEDIA-TYPES.md — never mojibake
  });
});

// ── Pipeline axioms ─────────────────────────────────────────────────────────

describe('Smelter axioms', () => {
  // S1 (FOPL): ∀ executions, ∀ r ∈ R, ∀ m₁,m₂ ∈ mut(r):
  //   m₁ ≠ m₂ → end(m₁) < start(m₂) ∨ end(m₂) < start(m₁)
  it('S1: per-resource store mutations never overlap', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), nonEmptyTextCatalogArb, async (s, catalog) => {
        const h = await makeHarness({ catalog, schedule: s, holdMs: 8 });
        try {
          let recSettled = false;
          const rec = h.smelter.reconcile().then(
            () => { recSettled = true; },
            () => { recSettled = true; },
          );
          for (const e of catalog) h.events$.next({ type: 'yield:updated', resourceId: e.rid, payload: {} });
          await pump(s, () => recSettled);
          await h.settle();
          await rec;
          expect(h.violations).toEqual([]);
        } finally {
          h.stop();
        }
      }),
      { numRuns: 15 },
    );
  }, 30_000);

  // S2 (FOPL): ∀ executions, ∀ r, e* = ≺-max{e : rid(e) = r, e embed-inducing}:
  //   vec(final, r) = index(text(r, τ(e*)))
  it('S2: a stale reconcile read never overwrites a later event', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), ridArb, textArb, textArb, async (s, rid, v1, v2) => {
        fc.pre(chunkText(v1, CHUNKING).join('\u0000') !== chunkText(v2, CHUNKING).join('\u0000'));
        const h = await makeHarness({
          catalog: [{ rid, mediaType: 'text/plain', text: v1, annotations: [] }],
          schedule: s,
        });
        try {
          let recSettled = false;
          const rec = h.smelter.reconcile().then(
            () => { recSettled = true; },
            () => { recSettled = true; },
          );
          // Reconcile's content read is pending (it captured v1 at call time).
          await waitUntil(() => s.count() >= 1, 1000);
          // The content moves on and a live update arrives.
          h.setText(rid, v2);
          h.events$.next({ type: 'yield:updated', resourceId: rid, payload: {} });
          // Soft wait: pre-R3 both reads are pending simultaneously; post-R3
          // the lane serializes them and the count never reaches 2.
          await waitUntil(() => s.count() >= 2, 200);
          if (s.count() > 0) await s.waitAll(); // fc resolves pending reads in generated order
          await pump(s, () => recSettled);
          await h.settle();
          await rec;
          expect(h.lastUpsertTexts.get(rid)).toEqual(chunkText(v2, CHUNKING));
        } finally {
          h.stop();
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  // S5 (FOPL): ∀ resource events e, ∀ payloads p,p′: mutation(e[p]) = mutation(e[p′])
  // — the mutation is a function of (type(e), rid(e)) and the transport at τ(e).
  it('S5: payload contents do not influence resource embedding', async () => {
    await fc.assert(
      fc.asyncProperty(
        ridArb,
        textArb,
        fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }),
        async (rid, text, junk) => {
          const h = await makeHarness({ catalog: [{ rid, mediaType: 'text/plain', text, annotations: [] }] });
          try {
            h.events$.next({ type: 'yield:created', resourceId: rid, payload: junk });
            await h.settle();
            expect(h.lastUpsertTexts.get(rid)).toEqual(chunkText(text, CHUNKING));
          } finally {
            h.stop();
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 30_000);

  // S6 (FOPL): ∀ executions (live or reconcile), ∀ r: vec(final, r) ≠ ∅ → gate(media(r))
  it('S6: only resources that decode as text ever have vectors, on every path', async () => {
    await fc.assert(
      fc.asyncProperty(catalogArb.filter((c) => c.length > 0), async (catalog) => {
        const expected = catalog.filter((e) => embeds(e.mediaType)).map((e) => e.rid).sort();

        const live = await makeHarness({ catalog });
        try {
          for (const e of catalog) live.events$.next({ type: 'yield:created', resourceId: e.rid, payload: {} });
          await live.settle();
          expect((await live.ids()).resources).toEqual(expected);
        } finally {
          live.stop();
        }

        const rec = await makeHarness({ catalog });
        try {
          await rec.smelter.reconcile();
          expect((await rec.ids()).resources).toEqual(expected);
        } finally {
          rec.stop();
        }
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  // Phase 3b acceptance (MEDIA-TYPES.md): the widened gate, end to end —
  // structured text embeds, binary does not, registry-miss text/* embeds.
  it('gate: application/json embeds, application/zip does not, registry-miss text/x-foo embeds', async () => {
    const catalog: CatalogEntry[] = [
      { rid: 'r-json', mediaType: 'application/json', text: '{"makes":"meaning"}', annotations: [] },
      { rid: 'r-zip', mediaType: 'application/zip', text: 'PK not really an archive', annotations: [] },
      { rid: 'r-foo', mediaType: 'text/x-foo', text: 'unregistered text dialect', annotations: [] },
    ];
    const h = await makeHarness({ catalog });
    try {
      for (const e of catalog) h.events$.next({ type: 'yield:created', resourceId: e.rid, payload: {} });
      await h.settle();
      expect((await h.ids()).resources).toEqual(['r-foo', 'r-json']);
    } finally {
      h.stop();
    }
  });

  // S7 (FOPL): ∀ σ: ids(final(σ)) = ids(model(σ))
  // (state compared via id sets; chunk content is deterministic given ids)
  it('S7: store ≡ model over arbitrary event sequences', async () => {
    await fc.assert(
      fc.asyncProperty(catalogWithSeqArb, async ([catalog, seq]) => {
        expect(await replayIds(catalog, seq)).toEqual(modelFold(catalog, seq));
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  // S8 (FOPL): ∀ σ, ∀ i < |σ|: final(σ[0..i] ⧺ ⟨σᵢ⟩ ⧺ σ[i..]) = final(σ)
  it('S8: adjacent duplicated delivery is harmless', async () => {
    await fc.assert(
      fc.asyncProperty(catalogWithSeqArb, fc.nat(11), async ([catalog, seq], i) => {
        fc.pre(seq.length > 0);
        const idx = i % seq.length;
        const dup = [...seq.slice(0, idx + 1), seq[idx], ...seq.slice(idx + 1)];
        expect(await replayIds(catalog, dup)).toEqual(await replayIds(catalog, seq));
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  // S9a (FOPL): ∀ σ, ∀ failure masks F ⊆ content-reads: the pipeline processes
  // all of σ, and ∀ r ∉ affected(F): vec(final, r) = vec(model(σ), r)
  it('S9a: failed content reads are isolated; unaffected resources converge', async () => {
    await fc.assert(
      fc.asyncProperty(
        catalogWithSeqArb.chain(([catalog, seq]) =>
          fc.tuple(fc.constant(catalog), fc.constant(seq), fc.subarray(catalog.map((e) => e.rid))),
        ),
        async ([catalog, seq, failed]) => {
          const failRids = new Set(failed);
          const h = await makeHarness({ catalog, failRids });
          try {
            for (const e of seq) h.events$.next(e);
            await h.settle();
            const ids = await h.ids();
            const model = modelFold(catalog, seq);
            expect(ids.resources).toEqual(model.resources.filter((r) => !failRids.has(r)));
            // mark:* paths never read content — annotations are unaffected
            expect(ids.annotations).toEqual(model.annotations);
          } finally {
            h.stop();
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 30_000);

  // S9b (FOPL): ∀ σ: eventsProcessed = |{e ∈ σ : e processed without error}|.
  // Instance σ = ⟨⟩ with a non-empty catalog: reconcile must contribute 0.
  it('S9b: reconcile work never inflates eventsProcessed', async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyTextCatalogArb, async (catalog) => {
        const h = await makeHarness({ catalog });
        try {
          await h.smelter.reconcile();
          expect(h.smelter.eventsProcessed).toBe(0);
        } finally {
          h.stop();
        }
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  // S11 (FOPL): ∀ K, ∀ S₀: ids(reconcile(S₀, K)) =
  //   ({r ∈ K : gate(media(r))}, {a anchored to live r ∈ K : exact(a) ≠ ε})
  it('S11: reconcile converges from any divergence', async () => {
    const divergenceArb = fc.record({
      preIndexed: fc.array(fc.boolean(), { maxLength: 6 }),
      orphanRids: fc.uniqueArray(fc.nat(999).map((n) => `orphan-${n}`), { maxLength: 3 }),
      orphanAids: fc.uniqueArray(fc.nat(999).map((n) => `orphan-ann-${n}`), { maxLength: 3 }),
    });
    await fc.assert(
      fc.asyncProperty(catalogArb, divergenceArb, async (catalog, div) => {
        const h = await makeHarness({ catalog });
        try {
          // Seed an arbitrary divergence directly into the store (test setup):
          // a subset of catalog entries already indexed (regardless of media
          // type — a pre-indexed binary is itself an orphan reconcile must
          // delete), plus vectors for ids the catalog has never heard of.
          for (let i = 0; i < catalog.length; i++) {
            if (div.preIndexed[i]) {
              await h.store.upsertResourceVectors(makeResourceId(catalog[i].rid), [
                { chunkIndex: 0, text: catalog[i].text, embedding: deterministicEmbed(catalog[i].text) },
              ], calculateChecksum(catalog[i].text), []);
            }
          }
          for (const rid of div.orphanRids) {
            await h.store.upsertResourceVectors(makeResourceId(rid), [
              { chunkIndex: 0, text: 'orphan', embedding: deterministicEmbed('orphan') },
            ], calculateChecksum('orphan'), []);
          }
          for (const aid of div.orphanAids) {
            await h.store.upsertAnnotationVector(makeAnnotationId(aid), deterministicEmbed(aid), {
              annotationId: makeAnnotationId(aid),
              resourceId: makeResourceId('orphan-anchor'),
              motivation: 'highlighting',
              entityTypes: [],
              exactText: 'orphan',
            });
          }

          await h.smelter.reconcile();

          expect(await h.ids()).toEqual({
            resources: catalog.filter((e) => embeds(e.mediaType)).map((e) => e.rid).sort(),
            annotations: catalog.flatMap((e) => e.annotations.map((a) => a.aid)).sort(),
          });
        } finally {
          h.stop();
        }
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  // S12 (FOPL): ∀ K, ∀ S₀ indexed from earlier content, after reconcile with
  // no concurrent traffic, ∀ r ∈ K with gate(media(r)):
  //   vec(S*, r) = index(text(r, now)) ∧ stamp(S*, r) = checksum(r, K)
  // — and resources whose stamped checksum already matches are not re-embedded.
  it('S12: reconcile re-embeds resources whose content changed while the worker was down', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyTextCatalogArb,
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        textArb,
        async (catalog, changeMask, freshText) => {
          const changes = catalog.map((_, i) =>
            changeMask[i] === true ? `${freshText} (rev ${i})` : null);
          fc.pre(changes.some((c) => c !== null));
          for (let i = 0; i < catalog.length; i++) {
            const next = changes[i];
            if (next !== null) {
              fc.pre(chunkText(next, CHUNKING).join(' ') !== chunkText(catalog[i].text, CHUNKING).join(' '));
            }
          }

          // Phase 1 — the worker indexes v1 via live events, then "goes down".
          const store = new MemoryVectorStore();
          await store.connect();
          const h1 = await makeHarness({ catalog, store });
          try {
            for (const e of catalog) h1.events$.next({ type: 'yield:created', resourceId: e.rid, payload: {} });
            await h1.settle();
          } finally {
            h1.stop();
          }

          // Downtime — content and catalog checksums move on for the masked subset.
          const catalog2 = catalog.map((e, i) => (changes[i] !== null ? { ...e, text: changes[i]! } : e));

          // Phase 2 — restart: reconcile against the updated catalog.
          const h2 = await makeHarness({ catalog: catalog2, store });
          try {
            await h2.smelter.reconcile();
            for (let i = 0; i < catalog2.length; i++) {
              const { rid, text } = catalog2[i];
              if (changes[i] !== null) {
                expect(h2.lastUpsertTexts.get(rid)).toEqual(chunkText(text, CHUNKING));
              } else {
                expect(h2.upsertCounts.get(rid) ?? 0).toBe(0);
              }
            }
          } finally {
            h2.stop();
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);
});
