/**
 * Participant attention streams
 *
 * Module-level subject map for delivering ephemeral beckon signals directly
 * to a named participant's open SSE connection. No persistence — signals are
 * delivered if the participant is connected, dropped if not.
 */

import { Subject } from 'rxjs';
import type { EventMap } from '@semiont/core';

const streams = new Map<string, Subject<EventMap['beckon:focus']>>();

export function getOrCreateStream(participantId: string): Subject<EventMap['beckon:focus']> {
  if (!streams.has(participantId)) {
    streams.set(participantId, new Subject<EventMap['beckon:focus']>());
  }
  return streams.get(participantId)!;
}

export function removeStream(participantId: string): void {
  streams.get(participantId)?.complete();
  streams.delete(participantId);
}
