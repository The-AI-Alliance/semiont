import { PERSISTED_EVENT_TYPES } from './persisted-events';
import { BRIDGED_CHANNELS } from './bridged-channels';
import { RESOURCE_BROADCAST_TYPES } from './bus-protocol';
import type { EventName } from './bus-protocol';

/**
 * The channels a client receives per RESOURCE SCOPE rather than globally —
 * what `subscribeToResource` joins, and what a scoped SSE connection carries.
 *
 * Derived, never listed: persisted events minus the globally bridged ones,
 * plus the genuine resource-bound broadcasts. A channel in BOTH sets is
 * forwarded twice on a scoped connection (global copy with an ephemeral id,
 * scoped copy with a persisted one) and escapes the client's id dedup —
 * .plans/bugs/BRIDGE-GAPS.md.
 *
 * It lives in core because every input is a core fact and because two
 * consumers now need it: the HTTP transport, which joins and leaves these
 * per scope, and the actor state unit, whose `stream` refusal must not
 * reject a scopable channel — a bridge legitimately subscribes one before
 * any scope exists. Deriving it twice would be two places deciding one
 * thing; importing it across those two modules would be a cycle.
 */
export const RESOURCE_SCOPED_CHANNELS = [
  ...PERSISTED_EVENT_TYPES.filter((t) => !(BRIDGED_CHANNELS as readonly string[]).includes(t)),
  ...RESOURCE_BROADCAST_TYPES,
] as const satisfies readonly EventName[];
