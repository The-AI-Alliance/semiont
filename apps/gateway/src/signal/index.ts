/**
 * The Signal Plane seam (SIGNAL-PLANE P0), as the routes use it: the
 * composition of plane and ledger, the plane's refusal, the channel
 * predicate and the reply address. Nothing below it decides entitlement.
 */
export { SignalPlaneUnavailable, toReplyAddress, type PlaneSubscription } from './interface';
export { SCOPE_WARN_THRESHOLD } from './options';
export { isCorrelatedChannel } from './channels';
export { compositionFor } from './composition';
// The LEDGER is deliberately not re-exported here: it sits ABOVE the seam
// (gateway policy) and knows the correlation vocabulary, which this barrel —
// the driver's face — must not. Import it from './ledger' explicitly.
