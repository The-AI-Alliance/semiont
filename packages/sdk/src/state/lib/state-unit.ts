import { Subscription } from 'rxjs';

/**
 * Marker for the state-unit pattern: a stateful, lifecycled object with an
 * RxJS-shaped public surface, constructed by a factory function
 * (`createFooStateUnit`), with internal state held in a closure.
 *
 * The structural contract is `dispose()` — the rest of the pattern
 * (closure-based identity, Observable public surface, internal Subjects
 * exposed as `.asObservable()` views, no leaked subscriptions, composition
 * by parameter rather than ownership) is convention enforced by review,
 * not the type system.
 *
 * See `packages/sdk/docs/STATE-UNITS.md` for the full axioms and rationale.
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

/**
 * Compose multiple disposers into a single `dispose()` call. Accepts either
 * a `StateUnit` (whose `dispose()` will be invoked) or a plain teardown
 * function. The returned object is itself disposable; call its `dispose()`
 * once to tear down everything that was added.
 */
export function createDisposer(): {
  add(item: StateUnit | (() => void)): void;
  dispose(): void;
} {
  const sub = new Subscription();
  return {
    add: (item) =>
      sub.add(typeof item === 'function' ? item : () => item.dispose()),
    dispose: () => sub.unsubscribe(),
  };
}
