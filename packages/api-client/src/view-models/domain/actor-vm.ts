import { Observable, Subject } from 'rxjs';
import { filter, map, share } from 'rxjs/operators';
import type { ViewModel } from '../lib/view-model';

export interface BusEvent {
  channel: string;
  payload: Record<string, unknown>;
  scope?: string;
}

export interface ActorVMOptions {
  baseUrl: string;
  token: string;
  channels: string[];
  scope?: string;
  reconnectMs?: number;
}

export interface ActorVM extends ViewModel {
  on$<T = Record<string, unknown>>(channel: string): Observable<T>;
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
  connected$: Observable<boolean>;
  start(): void;
  stop(): void;
}

export function createActorVM(options: ActorVMOptions): ActorVM {
  const { baseUrl, token, channels, scope, reconnectMs = 5_000 } = options;

  const events$ = new Subject<BusEvent>();
  const connected$ = new Subject<boolean>();
  let running = false;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  const shared$ = events$.pipe(share());

  const connect = () => {
    const params = new URLSearchParams();
    for (const ch of channels) {
      params.append('channel', ch);
    }
    if (scope) {
      params.append('scope', scope);
    }
    const url = `${baseUrl}/bus/subscribe?${params.toString()}`;

    const es = new EventSource(url);
    eventSource = es;

    es.addEventListener('bus-event', ((event: MessageEvent) => {
      if (!running) return;
      const parsed = JSON.parse(event.data) as BusEvent;
      events$.next(parsed);
    }) as EventListener);

    es.addEventListener('open', (() => {
      connected$.next(true);
    }) as EventListener);

    es.addEventListener('error', () => {
      if (!running) return;
      connected$.next(false);
      es.close();
      eventSource = null;
      reconnectTimer = setTimeout(() => {
        if (running) connect();
      }, reconnectMs);
    });
  };

  return {
    on$<T = Record<string, unknown>>(channel: string): Observable<T> {
      return shared$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },

    emit: async (channel: string, payload: Record<string, unknown>): Promise<void> => {
      const body: Record<string, unknown> = { channel, payload };
      if (scope) body.scope = scope;
      await fetch(`${baseUrl}/bus/emit`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
    },

    connected$: connected$.asObservable(),

    start: () => {
      if (running) return;
      running = true;
      connect();
    },

    stop: () => {
      running = false;
      connected$.next(false);
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    },

    dispose: () => {
      running = false;
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      events$.complete();
      connected$.complete();
    },
  };
}
