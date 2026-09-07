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
import { type Observable } from 'rxjs';
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
export declare function disposeProbe(): DisposeProbe;
type SetupResult<T extends StateUnit> = T | {
    unit: T;
    passedIn?: readonly DisposeProbe[];
    teardown?: () => void;
};
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
/**
 * Run every applicable axiom against `spec`. Throws a labeled Error on the first
 * violation. Axioms whose accessors are omitted are skipped (e.g. A7-passed
 * runs only when `setup` returns `passedIn`; A6 only when `surfaces` is given).
 */
export declare function assertStateUnitAxioms<T extends StateUnit>(spec: StateUnitAxiomSpec<T>): void;
export {};
