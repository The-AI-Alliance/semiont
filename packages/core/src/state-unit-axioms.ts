/**
 * Executable enforcement of the StateUnit pattern — the runtime twin of
 * `packages/sdk/docs/STATE-UNITS.md` and the ledger in
 * `.plans/STATE-UNIT-AXIOMS.md`. The `StateUnit` interface's own comment notes
 * the pattern is convention; this file makes it executable.
 *
 * `assertStateUnitAxioms(spec)` runs every applicable axiom against a factory in
 * one shot, throwing a labeled Error on the first violation (the axiom id is in
 * the message). It is framework-agnostic on purpose — only `rxjs` + `fast-check`,
 * no `vitest` — so it ships through `@semiont/core/testing` and any package's test
 * runner can invoke it from a single `it(...)` per state unit. It lives in core
 * (not sdk) so even packages below sdk (e.g. `http-transport`) can use it without
 * a dependency cycle.
 *
 * Axioms (random-input dimension; fast-check):
 *   A5        dispose() is idempotent and total (n ∈ [1,20] calls never throw)
 *   A5b       post-dispose inertness — every public method is a no-op after dispose
 *   A6        every pre-dispose subscriber (k ∈ [1,10]) sees `complete` on dispose
 *   X3-runtime instance isolation — driving one instance never moves another's surfaces
 * Structural assertions (single-shot):
 *   A1        plain-object identity (no class instance)
 *   X1        no raw Subject on the public surface
 *   A7-passed disposing the unit must NOT dispose an injected dependency
 *   A7-owned  disposing the unit MUST dispose its internally-constructed children
 */

import * as fc from 'fast-check';
import { Subject, type Observable } from 'rxjs';
import type { StateUnit } from './state-unit';

/**
 * A disposable stand-in for an injected dependency. Pass one as a unit's
 * constructor arg, then list it in `setup().passedIn` so A7-passed can assert
 * the unit never disposed it. Counts calls so A7-passed also holds under the
 * repeated-dispose stress of A5.
 */
export interface DisposeProbe extends StateUnit {
  readonly disposeCount: number;
}

export function disposeProbe(): DisposeProbe {
  let n = 0;
  return {
    dispose() { n += 1; },
    get disposeCount() { return n; },
  };
}

type SetupResult<T extends StateUnit> =
  | T
  | { unit: T; passedIn?: readonly DisposeProbe[]; teardown?: () => void };

export interface StateUnitAxiomSpec<T extends StateUnit> {
  /**
   * Build a FRESH unit. Called many times (fast-check re-runs), so it must
   * return an independent instance each call. Return the bare unit, or an object
   * carrying the injected `passedIn` probes (A7-passed) and a `teardown` to
   * release per-instance resources (e.g. a mock bus).
   */
  setup: () => SetupResult<T>;
  /** Owned public Observables — Subjects the unit completes on dispose (A6, X3, post-dispose inertness). */
  surfaces?: (unit: T) => readonly Observable<unknown>[];
  /** Public input methods as zero-arg callers (A5b post-dispose, X3 drive). */
  invocations?: (unit: T) => readonly (() => unknown)[];
  /** Surfaces of internally-constructed children — must complete when the outer disposes (A7-owned). */
  ownedChildSurfaces?: (unit: T) => readonly Observable<unknown>[];
  /** fast-check run budget per property (default 30). */
  numRuns?: number;
}

interface Normalized<T extends StateUnit> {
  unit: T;
  passedIn: readonly DisposeProbe[];
  teardown: () => void;
}

function normalize<T extends StateUnit>(r: SetupResult<T>): Normalized<T> {
  if (r && typeof r === 'object' && 'unit' in r) {
    return { unit: r.unit, passedIn: r.passedIn ?? [], teardown: r.teardown ?? (() => {}) };
  }
  return { unit: r as T, passedIn: [], teardown: () => {} };
}

function swallowAsync(value: unknown): void {
  if (value && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
    (value as Promise<unknown>).then(undefined, () => {});
  }
}

/**
 * Run every applicable axiom against `spec`. Throws a labeled Error on the first
 * violation. Axioms whose accessors are omitted are skipped (e.g. A7-passed
 * runs only when `setup` returns `passedIn`; A6 only when `surfaces` is given).
 */
export function assertStateUnitAxioms<T extends StateUnit>(spec: StateUnitAxiomSpec<T>): void {
  const numRuns = spec.numRuns ?? 30;
  const fresh = (): Normalized<T> => normalize(spec.setup());

  // fast-check's default falsification message is just "Property failed after N
  // tests {seed}" — it drops the thrown axiom id. Prepend the axiom so a real
  // failure names itself; the seed/shrink detail is preserved.
  const run = (axiom: string, prop: Parameters<typeof fc.assert>[0]): void => {
    try {
      fc.assert(prop, { numRuns });
    } catch (e) {
      throw new Error(`${axiom}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // A1 — plain-object identity (no class instance).
  {
    const { unit, teardown } = fresh();
    const proto = Object.getPrototypeOf(unit);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('A1: state unit is not a plain object (has a class prototype)');
    }
    unit.dispose();
    teardown();
  }

  // X1 — no raw *origin* Subject on the public surface (expose `.asObservable()`).
  // Flag only origin Subjects — `new Subject` / `new BehaviorSubject`, the unit's own
  // state, where `.source` is undefined. Derived `AnonymousSubject`s from `Subject.lift`
  // (`shareReplay().pipe(...)`) carry a `.source` and are inert sinks (`.next()` does
  // nothing useful) — idiomatic, not the forgotten-internal-Subject smell — so exclude them.
  {
    const { unit, teardown } = fresh();
    for (const [key, value] of Object.entries(unit)) {
      if (value instanceof Subject && (value as { source?: unknown }).source === undefined) {
        throw new Error(`X1: public field "${key}" is a raw Subject — expose it via .asObservable()`);
      }
    }
    unit.dispose();
    teardown();
  }

  // A7-passed — disposing the unit must NOT dispose an injected dependency.
  {
    const { unit, passedIn, teardown } = fresh();
    unit.dispose();
    passedIn.forEach((probe, i) => {
      if (probe.disposeCount > 0) {
        throw new Error(`A7-passed: the unit disposed injected dependency #${i} (it doesn't own it)`);
      }
    });
    teardown();
  }

  // A5 — dispose() idempotent & total: n calls never throw; injected deps stay untouched.
  run('A5', fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
    const { unit, passedIn, teardown } = fresh();
    for (let i = 0; i < n; i++) unit.dispose();
    passedIn.forEach((probe, i) => {
      if (probe.disposeCount > 0) {
        throw new Error(`injected dependency #${i} disposed under ${n} dispose() calls`);
      }
    });
    teardown();
  }));

  // A6 — k pre-dispose subscribers on each owned surface all see `complete` on dispose.
  if (spec.surfaces) {
    const surfaces = spec.surfaces;
    run('A6', fc.property(fc.integer({ min: 1, max: 10 }), (k) => {
      const { unit, teardown } = fresh();
      const completed: boolean[] = [];
      const subs = surfaces(unit).flatMap((o) =>
        Array.from({ length: k }, () => {
          const idx = completed.push(false) - 1;
          return o.subscribe({ complete: () => { completed[idx] = true; } });
        }),
      );
      unit.dispose();
      completed.forEach((seen, idx) => {
        if (!seen) throw new Error(`a subscriber did not see complete on dispose (k=${k}, sub #${idx})`);
      });
      subs.forEach((s) => s.unsubscribe());
      teardown();
    }));
  }

  // A5b — post-dispose inertness: every public method is a no-op (no throw) after dispose.
  if (spec.invocations) {
    const invocations = spec.invocations;
    run('A5b', fc.property(fc.array(fc.nat(), { maxLength: 12 }), (seq) => {
      const { unit, teardown } = fresh();
      const callers = invocations(unit);
      unit.dispose();
      for (const raw of seq) {
        if (callers.length === 0) break;
        swallowAsync(callers[raw % callers.length]());
      }
      teardown();
    }));
  }

  // X3-runtime — instance isolation: driving instance A never moves instance B's surfaces.
  if (spec.surfaces && spec.invocations) {
    const surfaces = spec.surfaces;
    const invocations = spec.invocations;
    run('X3-runtime', fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), (seq) => {
      const a = fresh();
      const b = fresh();
      const bSurfaces = surfaces(b.unit);
      const bCounts = bSurfaces.map(() => 0);
      const bSubs = bSurfaces.map((o, i) => o.subscribe(() => { bCounts[i] += 1; }));
      const baseline = bCounts.slice(); // initial replay captured synchronously above
      const aCallers = invocations(a.unit);
      for (const raw of seq) {
        if (aCallers.length === 0) break;
        swallowAsync(aCallers[raw % aCallers.length]());
      }
      bCounts.forEach((count, i) => {
        if (count !== baseline[i]) {
          throw new Error(`driving instance A perturbed instance B's surface #${i}`);
        }
      });
      bSubs.forEach((s) => s.unsubscribe());
      a.unit.dispose();
      b.unit.dispose();
      a.teardown();
      b.teardown();
    }));
  }

  // A7-owned — internally-constructed children are disposed (their surfaces complete) on outer dispose.
  if (spec.ownedChildSurfaces) {
    const { unit, teardown } = fresh();
    const childSurfaces = spec.ownedChildSurfaces(unit);
    const completed = childSurfaces.map(() => false);
    const subs = childSurfaces.map((o, i) => o.subscribe({ complete: () => { completed[i] = true; } }));
    unit.dispose();
    completed.forEach((seen, i) => {
      if (!seen) throw new Error(`A7-owned: owned child surface #${i} did not complete on outer dispose`);
    });
    subs.forEach((s) => s.unsubscribe());
    teardown();
  }

  // Post-dispose surface inertness: a NEW subscription after dispose completes with no `next`.
  if (spec.surfaces) {
    const { unit, teardown } = fresh();
    unit.dispose();
    spec.surfaces(unit).forEach((o, i) => {
      let nexts = 0;
      let done = false;
      o.subscribe({ next: () => { nexts += 1; }, complete: () => { done = true; } }).unsubscribe();
      if (nexts > 0) throw new Error(`A5b/inert: owned surface #${i} emitted a value after dispose`);
      if (!done) throw new Error(`A5b/inert: owned surface #${i} did not complete after dispose`);
    });
    teardown();
  }
}
