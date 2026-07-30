/**
 * `@semiont/core/testing/axioms` — the property-based axiom harnesses.
 *
 * Split from `@semiont/core/testing` (SDK-TESTING-DOUBLE gap 7, 2026-07-29) so
 * that `fast-check` — declared an OPTIONAL peerDependency — is only loaded by
 * consumers who actually run the axioms. Before the split, `dist/testing.js`
 * was one bundle whose axiom modules did a top-level `import * as fc`, so
 * importing ANYTHING from `/testing` (including transitively, via
 * `@semiont/sdk/testing` → `createTestSession`) pulled fast-check at import
 * time. npm does not install optional peers, so the first out-of-monorepo
 * consumer's test run died with `Cannot find package 'fast-check'`. The
 * optionality is real now: the double's entry never touches fc.
 *
 * Importing this module REQUIRES `fast-check` in your devDependencies.
 * Test doubles with no fast-check requirement — `FaultyTransport` and its
 * scripting surface — stay at `@semiont/core/testing`.
 *
 * Two axiom families: the StateUnit axioms (per-unit safety: dispose is
 * idempotent and total, subscribers complete, instances are isolated) and the
 * liveness axioms (composition-level: subscriptions never silently pend
 * forever, requests settle within their budget, delivery is exactly-once
 * across handovers).
 */

export {
  assertStateUnitAxioms,
  disposeProbe,
  type StateUnitAxiomSpec,
  type DisposeProbe,
} from '../state-unit-axioms';

export {
  assertLivenessAxioms,
  assertExactlyOnceDelivery,
  arbFaultAction,
  arbFaultSchedule,
  arbDeliveryOps,
  type LivenessScenario,
  type LivenessAxiomSpec,
  type DeliverySubject,
  type DeliveryOp,
  type DeliveryAxiomSpec,
} from '../liveness-axioms';
