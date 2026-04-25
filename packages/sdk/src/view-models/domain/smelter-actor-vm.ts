import { Observable, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ViewModel } from '../lib/view-model';
import type { ConnectionState } from '@semiont/core';
import { createActorVM, type ActorVM } from '@semiont/api-client';

export interface SmelterEvent {
  type: string;
  resourceId?: string;
  payload: Record<string, unknown>;
}

export interface SmelterActorVMOptions {
  baseUrl: string;
  token: string;
  reconnectMs?: number;
}

const SMELTER_CHANNELS = [
  'yield:created',
  'yield:updated',
  'yield:representation-added',
  'mark:archived',
  'mark:added',
  'mark:removed',
] as const;

export interface SmelterActorVM extends ViewModel {
  events$: Observable<SmelterEvent>;
  state$: Observable<ConnectionState>;
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
  start(): void;
  stop(): void;
}

export function createSmelterActorVM(options: SmelterActorVMOptions): SmelterActorVM {
  const actor: ActorVM = createActorVM({
    baseUrl: options.baseUrl,
    token: options.token,
    channels: [...SMELTER_CHANNELS],
    reconnectMs: options.reconnectMs,
  });

  const events$ = merge(
    ...SMELTER_CHANNELS.map((channel) =>
      actor.on$<Record<string, unknown>>(channel).pipe(
        map((payload) => ({
          type: channel,
          resourceId: payload.resourceId as string | undefined,
          payload,
        })),
      ),
    ),
  );

  return {
    events$,
    state$: actor.state$,
    emit: (channel, payload) => actor.emit(channel, payload),
    start: () => actor.start(),
    stop: () => actor.stop(),
    dispose: () => actor.dispose(),
  };
}
