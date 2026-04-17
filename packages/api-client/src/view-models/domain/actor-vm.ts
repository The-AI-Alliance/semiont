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
  emit(channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<void>;
  connected$: Observable<boolean>;
  start(): void;
  stop(): void;
}

export function createActorVM(options: ActorVMOptions): ActorVM {
  const { baseUrl, token, channels, scope, reconnectMs = 5_000 } = options;

  const events$ = new Subject<BusEvent>();
  const connected$ = new Subject<boolean>();
  let running = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const shared$ = events$.pipe(share());

  const connect = async () => {
    const params = new URLSearchParams();
    for (const ch of channels) {
      params.append('channel', ch);
    }
    if (scope) {
      params.append('scope', scope);
    }
    const url = `${baseUrl}/bus/subscribe?${params.toString()}`;

    abortController = new AbortController();

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }

      connected$.next(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '') {
            if (currentEvent === 'bus-event' && currentData) {
              const parsed = JSON.parse(currentData) as BusEvent;
              events$.next(parsed);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }

    if (running) {
      connected$.next(false);
      abortController = null;
      reconnectTimer = setTimeout(() => {
        if (running) connect();
      }, reconnectMs);
    }
  };

  return {
    on$<T = Record<string, unknown>>(channel: string): Observable<T> {
      return shared$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },

    emit: async (channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<void> => {
      const body: Record<string, unknown> = { channel, payload };
      const effectiveScope = emitScope ?? scope;
      if (effectiveScope) body.scope = effectiveScope;
      await fetch(`${baseUrl}/bus/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
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
      if (abortController) { abortController.abort(); abortController = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    },

    dispose: () => {
      running = false;
      if (abortController) { abortController.abort(); abortController = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      events$.complete();
      connected$.complete();
    },
  };
}
