/**
 * `@semiont/core/testing/axioms` — the property-based axiom harnesses.
 *
 * A separate entry from `@semiont/core/testing` so that `fast-check` —
 * declared an OPTIONAL peerDependency — is only loaded by consumers who
 * actually run the axioms. The axiom modules do a top-level `import * as fc`;
 * bundled with the doubles, importing ANYTHING from `/testing` (including
 * transitively, via `@semiont/sdk/testing` → `createTestSession`) would pull
 * fast-check at import time, and npm does not install optional peers, so an
 * out-of-monorepo consumer's test run would die with
 * `Cannot find package 'fast-check'`. The double's entry never touches fc.
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
