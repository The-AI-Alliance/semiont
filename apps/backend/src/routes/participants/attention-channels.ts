/**
 * Participant attention channels
 *
 * Module-level map of per-participant RxJS Subjects. Each connected participant
 * has one channel; beckon signals published here are pushed to the participant's
 * open SSE connection. Signals are ephemeral — delivered if connected, dropped
 * if not. No queue, no replay.
 */

import { Subject } from 'rxjs';
import type { EventMap } from '@semiont/core';

const channels = new Map<string, Subject<EventMap['beckon:focus']>>();

export function getOrCreateChannel(participantId: string): Subject<EventMap['beckon:focus']> {
  if (!channels.has(participantId)) {
    channels.set(participantId, new Subject<EventMap['beckon:focus']>());
  }
  return channels.get(participantId)!;
}

export function removeChannel(participantId: string): void {
  channels.get(participantId)?.complete();
  channels.delete(participantId);
}
