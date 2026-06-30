/**
 * Marker for the state-unit pattern: a stateful, lifecycled object with an
 * RxJS-shaped public surface, constructed by a factory function
 * (`createFooStateUnit`), with internal state held in a closure.
 *
 * The structural contract is `dispose()` — the rest of the pattern
 * (closure-based identity, Observable public surface, internal Subjects
 * exposed as `.asObservable()` views, no leaked subscriptions, composition
 * by parameter rather than ownership) is convention, made executable by the
 * axiom harness in `@semiont/core/testing` (`assertStateUnitAxioms`).
 *
 * Lives in `@semiont/core` (not sdk) so every layer can share one definition
 * without dependency cycles — `http-transport`'s `ActorStateUnit` sits below
 * sdk and would otherwise have to re-declare it. See
 * `packages/sdk/docs/STATE-UNITS.md` for the full pattern and rationale, and
 * `.plans/STATE-UNIT-AXIOMS.md` for the axiom ledger.
 */
export interface StateUnit {
  /**
   * Idempotent, total teardown. Completes every Subject the unit owns,
   * unsubscribes every internal subscription, releases timers / abort
   * controllers / network handles. Safe to call multiple times — the
   * second call is a no-op.
   */
  dispose(): void;
}
