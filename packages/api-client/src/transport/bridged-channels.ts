/**
 * BRIDGED_CHANNELS
 *
 * The set of bus channels that any concrete transport bridges into the
 * caller-supplied bus via `bridgeInto`. Transport-neutral: shared by
 * `HttpTransport` (delivers via SSE) and `LocalTransport` (forwards
 * directly from the in-process make-meaning bus).
 *
 * Note: this is the *fan-in* set — channels for events the transport
 * receives and pushes onto the client's bus. It is not the same as the
 * channels the client emits (which is open-ended).
 *
 * Resource-scoped channels (joined/left via `subscribeToResource`) are
 * tracked separately by transports that care about scope (HTTP).
 */
export const BRIDGED_CHANNELS = [
  'browse:resources-result', 'browse:resources-failed',
  'browse:resource-result', 'browse:resource-failed',
  'browse:annotations-result', 'browse:annotations-failed',
  'browse:annotation-result', 'browse:annotation-failed',
  'browse:annotation-history-result', 'browse:annotation-history-failed',
  'browse:events-result', 'browse:events-failed',
  'browse:referenced-by-result', 'browse:referenced-by-failed',
  'browse:entity-types-result', 'browse:entity-types-failed',
  'browse:directory-result', 'browse:directory-failed',
  'browse:annotation-context-result', 'browse:annotation-context-failed',
  'mark:delete-ok', 'mark:delete-failed',
  'mark:create-ok', 'mark:create-failed',
  'match:search-results', 'match:search-failed',
  'gather:complete', 'gather:failed',
  'gather:annotation-progress', 'gather:annotation-finished',
  'gather:summary-result', 'gather:summary-failed',
  'bind:body-updated', 'bind:body-update-failed',
  'job:report-progress', 'job:complete', 'job:fail',
  'job:status-result', 'job:status-failed',
  'job:created', 'job:create-failed',
  'job:claimed', 'job:claim-failed',
  'yield:clone-token-generated', 'yield:clone-token-failed',
  'yield:clone-resource-result', 'yield:clone-resource-failed',
  'yield:clone-created', 'yield:clone-create-failed',
  'mark:entity-type-added',
  'beckon:focus', 'beckon:sparkle',
  'bus:resume-gap',
] as const;

export type BridgedChannel = typeof BRIDGED_CHANNELS[number];
