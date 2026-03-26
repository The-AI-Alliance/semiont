/**
 * Participant attention streams
 *
 * Module-level subject map for delivering ephemeral beckon signals directly
 * to a named participant's open SSE connection. No persistence — signals are
 * delivered if the participant is connected, dropped if not.
 */

import { Subject } from 'rxjs';

export interface BeckonSignal {
  resourceId: string;
  annotationId?: string;
  message?: string;
}

const streams = new Map<string, Subject<BeckonSignal>>();

export function getOrCreateStream(participantId: string): Subject<BeckonSignal> {
  if (!streams.has(participantId)) {
    streams.set(participantId, new Subject<BeckonSignal>());
  }
  return streams.get(participantId)!;
}

export function removeStream(participantId: string): void {
  streams.get(participantId)?.complete();
  streams.delete(participantId);
}
