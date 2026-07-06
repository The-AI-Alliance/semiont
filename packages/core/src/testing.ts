/**
 * `@semiont/core/testing` — test-only utilities for verifying cross-package
 * invariants. Not part of the runtime surface; consumers import it from their
 * test suites and must have `fast-check` in their own devDependencies.
 *
 * Lives in core (not sdk) so every layer — including `http-transport`, which is
 * below sdk — can share one harness without dependency cycles. Two axiom
 * families: the StateUnit axioms (`.plans/STATE-UNIT-AXIOMS.md`, per-unit
 * safety) and the liveness axioms (`.plans/LIVENESS-AXIOMS.md`,
 * composition-level liveness over `FaultyTransport`).
 */
export {
  assertStateUnitAxioms,
  disposeProbe,
  type StateUnitAxiomSpec,
  type DisposeProbe,
} from './state-unit-axioms';

export {
  FaultyTransport,
  retryKeyOf,
  type FaultAction,
  type ScopeModel,
  type FaultyTransportConfig,
  type RequestLogEntry,
} from './faulty-transport';

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
} from './liveness-axioms';
