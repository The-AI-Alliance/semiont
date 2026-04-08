/**
 * EventMap — unified event type map
 *
 * Merges the three protocol layers into a single type used by EventBus.get().
 * This file exists to break the circular dependency between event-bus.ts and index.ts.
 */

import type { WireProtocol } from './wire-protocol';
import type { ActorProtocol } from './actor-protocol';
import type { UIEvents } from './ui-events';

/** Unified event map — all wire, actor, and UI events */
export type EventMap = WireProtocol & ActorProtocol & UIEvents;

/** Union type of all valid event names */
export type EventName = keyof EventMap;
