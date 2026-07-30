/**
 * `@semiont/core/testing` — the test doubles, free of any `fast-check`
 * requirement. Not part of the runtime surface; consumers import it from
 * their test suites.
 *
 * Lives in core (not sdk) so every layer — including `http-transport`, which
 * is below sdk — can share one double without dependency cycles. The
 * consumer-facing client/session entry points that wrap this transport live
 * in `@semiont/sdk/testing` (`createTestClient`, `createTestSession`), which
 * composes this module across the existing dependency edge.
 *
 * The property-based AXIOM harnesses (`assertStateUnitAxioms`,
 * `assertLivenessAxioms`, `assertExactlyOnceDelivery`) moved to
 * **`@semiont/core/testing/axioms`** — they need `fast-check`, an optional
 * peerDependency, and keeping them here made that optionality a lie for every
 * consumer of the double (SDK-TESTING-DOUBLE gap 7). Import them from the
 * subpath, and add `fast-check` to your devDependencies when you do.
 */

export {
  FaultyTransport,
  retryKeyOf,
  type FaultAction,
  type FaultyTransportConfig,
  type RequestLogEntry,
} from './faulty-transport';
