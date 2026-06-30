/**
 * `@semiont/sdk/testing` — test-only utilities for verifying the StateUnit
 * pattern across packages. Not part of the runtime surface; consumers import it
 * from their test suites and must have `fast-check` in their own devDependencies.
 *
 * See `.plans/STATE-UNIT-AXIOMS.md` for the axiom ledger.
 */
export {
  assertStateUnitAxioms,
  disposeProbe,
  type StateUnitAxiomSpec,
  type DisposeProbe,
} from './state/lib/state-unit-axioms';
