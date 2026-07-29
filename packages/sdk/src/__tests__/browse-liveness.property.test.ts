/**
 * Liveness axioms P2 — L1/L2 over the REAL sdk composition
 * (`.plans/LIVENESS-AXIOMS.md`, sdk lane).
 *
 * `BrowseNamespace` + `createCache` + `busRequest` run unmodified on
 * `FaultyTransport` while fast-check draws fault schedules (drop / delay /
 * duplicate / reject-emit). Scopes COMPOSE (MULTI-RESOURCE-SCOPE landed —
 * the old single-slot model and its `scopeModel` knob are gone). This
 * generalizes `browse-concurrent-loaders.test.ts` — one hand-picked
 * interleaving — to the interleavings nobody names.
 *
 * L1's "notification" here is a MEANINGFUL one: live queries emit
 * `{ status: 'pending' }` immediately (D1), which would satisfy a naive
 * next-counter and defang the axiom — so outputs filter pending out and
 * re-throw `failed` as a stream error for the harness. What must arrive is
 * ready or failed; `pending` forever is exactly the starvation L1 forbids.
 *
 * Budget accounting (L2, via the transport's requestLog): a mounted loader's
 * key may legitimately issue 1 + B14's one retry; the await-path settlements
 * use DISJOINT rids because `fetch()` joins an in-flight chain (B3) but forces
 * a fresh issue otherwise — sharing rids with mounts would make the per-key
 * issue count ambiguous. The invalidate property widens the budget to 3: an
 * observe chain (≤2) plus a sanctioned invalidate chain (≤2) on one key.
 *
 * L4 (P4): the console-warn spy is the assertion surface, not just a
 * silencer. Property 1 carries the per-run implication — a consumed fault on
 * a MOUNTED rid's observe path ⇒ ≥1 breadcrumb before that run's outputs all
 * settled ([cache RETRY] fires before the retry that gates notification).
 * Scoped deliberately: fetch()/await-path faults have NO breadcrumb by design
 * (the caller owns retry policy), and the invalidate property is excluded —
 * an invalidate chain's warn can land after the bound when outputs were
 * already notified via the stale value, so asserting there would be flaky.
 * The two cache breadcrumbs ([cache RETRY]/[cache IDLE]) are also pinned
 * individually in the deterministic test at the bottom. The third breadcrumb
 * this suite once pinned — `[browse SCOPE-CONTENTION]` — is GONE with the
 * degradation path it observed: scopes compose (MULTI-RESOURCE-SCOPE Step 6),
 * the contention state is unreachable, and its assertion was removed in the
 * same change (the deliberate axiom-visible L4 edit the plan requires).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { filter, map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport } from '@semiont/core';
import { assertLivenessAxioms, FaultyTransport } from '@semiont/core/testing';
import { BrowseNamespace } from '../namespaces/browse';

/** Small explicit busRequest timeout — deterministic virtual time (no 30 s). */
const TIMEOUT_MS = 50;

/** Registry-shaped replies for the ops this composition issues. */
function makeResponse(operation: string, payload: Record<string, unknown>): unknown {
  switch (operation) {
    case 'browse:resource-requested':
      return { resource: { '@id': payload.resourceId, name: `Resource ${String(payload.resourceId)}` } };
    case 'browse:annotations-requested':
      return { annotations: [], total: 0 };
    default:
      return {};
  }
}

const noopContent = {
  getBinary: async () => ({ data: new ArrayBuffer(0), contentType: 'text/plain' }),
  getBinaryStream: async () => ({ stream: new ReadableStream(), contentType: 'text/plain' }),
  dispose: () => {},
} as unknown as IContentTransport;

/**
 * One `useResourceLoader`-shaped mount: resource + annotations live queries.
 * D1 note: `failed` is an EMISSION now, not a stream error — for the harness
 * (whose L1 counts value-or-error notifications) a failed state is re-thrown,
 * preserving the axiom's meaning: `pending` forever is the forbidden state.
 */
function loaderOutputs(browse: BrowseNamespace, rid: string): Observable<unknown>[] {
  const id = makeResourceId(rid);
  const settle = <T,>(obs: Observable<import('../cache').CacheState<T>>): Observable<T> =>
    obs.pipe(
      filter((s) => s.status !== 'pending'),
      map((s) => {
        if (s.status === 'failed') throw s.error;
        return s.value;
      }),
    );
  return [settle(browse.resource(id)), settle(browse.annotations(id))];
}

describe('liveness axioms over the real BrowseNamespace composition (P2)', () => {
  // The breadcrumbs ([cache RETRY]/[cache IDLE]) are always-on by design
  // (L4). The spy keeps property runs quiet AND is the L4 assertion
  // surface: property 1 checks degradation ⇒ ≥1 breadcrumb per run; the
  // deterministic test at the bottom pins each breadcrumb individually.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it(
    'L1/L2: concurrent distinct-rid loaders on a faulty wire — every subscription sees a value or an error, requests stay within the B14 budget',
    async () => {
      // Rotate mount shapes across property runs (fresh composition per run):
      // the flagship 4-distinct repro, a duplicate-rid variant (exercises B3
      // in-flight joining), a pair, and a single.
      const RID_CONFIGS: string[][] = [
        ['res-a', 'res-b', 'res-c', 'res-d'],
        ['res-a', 'res-a', 'res-b'],
        ['res-a', 'res-b'],
        ['res-a'],
      ];
      let run = 0;
      // L4 accumulator: violating runs are collected (not thrown) so a
      // breadcrumb failure can't shadow a sharper L1/L2 diagnosis from the
      // harness's finally block; asserted empty after the property.
      const l4Silent: string[] = [];

      await assertLivenessAxioms({
        timeoutMs: TIMEOUT_MS,
        retryBudget: 1,
        makeResponse,
        setup: (transport: FaultyTransport) => {
          const rids = RID_CONFIGS[run++ % RID_CONFIGS.length]!;
          warnSpy.mockClear(); // per-run L4 window
          const bus = new EventBus();
          const browse = new BrowseNamespace(
            transport,
            bus,
            noopContent,
            { busTimeoutMs: TIMEOUT_MS },
          );

          const outputs = rids.flatMap((rid) => loaderOutputs(browse, rid));

          // Await-path settlements on rids DISJOINT from the mounts (see the
          // module note on budget accounting). Both must settle — resolve or
          // reject — within the bound; rejection is a permitted outcome.
          const awaitRid = makeResourceId('res-await');
          const settlements = [
            browse.resource(awaitRid).fresh().then(
              (v) => v,
              (e) => {
                expect(e).toBeInstanceOf(Error);
                return undefined;
              },
            ),
            browse.annotations(awaitRid).fresh().then(
              (v) => v,
              (e) => {
                expect(e).toBeInstanceOf(Error);
                return undefined;
              },
            ),
          ];

          return {
            outputs,
            settlements,
            teardown: () => {
              // L4 — degradation ⇒ ≥1 breadcrumb. Runs after the harness's
              // L1/L2 checks (its finally), so every mounted-rid chain that
              // consumed a fault has already warned: [cache RETRY] precedes
              // the retry whose outcome gates the output's notification.
              // Quote-bounded rid match — '"res-a"' must not match the
              // await path's '"res-await"'.
              const observePathFaults = transport.requestLog.filter(
                (e) =>
                  (e.action.kind === 'drop-reply' || e.action.kind === 'reject-emit') &&
                  rids.some((r) => e.retryKey.includes(`"${r}"`)),
              );
              if (observePathFaults.length > 0 && warnSpy.mock.calls.length === 0) {
                l4Silent.push(
                  `L4: run with mounts [${rids.join(',')}] consumed ` +
                  `${observePathFaults.length} observe-path fault(s) ` +
                  `(${observePathFaults.map((e) => e.action.kind).join(',')}) ` +
                  `but emitted zero breadcrumbs — silence under degradation`,
                );
              }
              bus.destroy();
            },
          };
        },
      });

      expect(l4Silent).toEqual([]);
    },
    60_000,
  );

  it(
    'L1/L2 hold across the invalidate path (budget widened for the sanctioned refetch chain)',
    async () => {
      await assertLivenessAxioms({
        timeoutMs: TIMEOUT_MS,
        // One key may legitimately see the observe chain (1 + retry) PLUS the
        // invalidate chain (1 + retry) = 4 issues = 1 + 3.
        retryBudget: 3,
        makeResponse,
        setup: async (transport: FaultyTransport) => {
          const bus = new EventBus();
          const browse = new BrowseNamespace(
            transport,
            bus,
            noopContent,
            { busTimeoutMs: TIMEOUT_MS },
          );

          const outputs = [
            ...loaderOutputs(browse, 'res-x'),
            ...loaderOutputs(browse, 'res-y'),
          ];

          // Let the initial chains make some progress, then invalidate one
          // resource mid-flight — the interleaving the incident's evidence
          // chain never covered (a refetch racing the original chain, B9).
          await new Promise<void>((r) => setTimeout(r, 0));
          browse.invalidateResourceDetail(makeResourceId('res-x'));

          return { outputs, teardown: () => bus.destroy() };
        },
      });
    },
    60_000,
  );

  // ── L4 pair: each cache breadcrumb pinned individually (deterministic) ───
  //
  // (The suite once pinned a third breadcrumb here — [browse SCOPE-CONTENTION]
  // firing on scope contention. That state is unreachable since scopes
  // compose (MULTI-RESOURCE-SCOPE Step 6); the breadcrumb, the degradation
  // path, and the assertion were removed together — the deliberate
  // axiom-visible L4 edit logged in the plan. Multi-scope composition itself
  // is pinned in browse-scope-by-observation + browse-concurrent-loaders.)

  it('L4: [cache RETRY] then [cache IDLE] fire when an SWR chain fails and exhausts', async () => {
    // Every request drops its reply → attempt times out (RETRY warn) → the
    // B14 re-issue also drops → exhaustion (IDLE warn) + B15 error to the
    // value-less key's observers.
    const transport = new FaultyTransport({ schedule: [{ kind: 'drop-reply' }], makeResponse });
    const bus = new EventBus();
    const browse = new BrowseNamespace(
      transport, bus, noopContent, { busTimeoutMs: TIMEOUT_MS },
    );

    try {
      const outputs = loaderOutputs(browse, 'res-trio');
      await Promise.all(outputs.map(
        (o) => new Promise<void>((resolve) => {
          o.subscribe({ next: () => resolve(), error: () => resolve() });
        }),
      ));

      const warns: string[] = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(warns.some((w) => w.includes('[cache RETRY]'))).toBe(true);
      expect(warns.some((w) => w.includes('[cache IDLE]'))).toBe(true);
    } finally {
      bus.destroy();
      transport.dispose();
    }
  });
});
