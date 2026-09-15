/**
 * The Signal Plane seam (SIGNAL-PLANE P0): the interface, its options, the
 * in-process driver, the channel predicates — and, beside them but above the
 * seam, the gateway's ledger. `routes/bus.ts` consumes this module; nothing
 * below it decides entitlement.
 */
export type {
  ClientSubscriptionSpec,
  IngestReceipt,
  OnFrame,
  PlaneSubscription,
  ReplyAddress,
  ScopedChannels,
  SignalPlane,
  SignalPlaneFactory,
} from './interface';
export { toReplyAddress } from './interface';
export {
  CLAIM_MAX_GLOBAL,
  CLAIM_TTL_MS,
  MAX_SCOPES,
  PENDING_REPLIES_MAX,
  REPLY_RETENTION_MAX,
  REPLY_RETENTION_TTL_MS,
  SCOPE_WARN_THRESHOLD,
  resolveSignalPlaneOptions,
  type ResolvedSignalPlaneOptions,
  type SignalPlaneOptions,
} from './options';
export { CORRELATED_CHANNELS, isCorrelatedChannel, isProgressChannel } from './channels';
export { createInProcessSignalPlane } from './in-process';
// The LEDGER is deliberately not re-exported here: it sits ABOVE the seam
// (gateway policy) and knows the correlation vocabulary, which this barrel —
// the driver's face — must not. Import it from './ledger' explicitly.
