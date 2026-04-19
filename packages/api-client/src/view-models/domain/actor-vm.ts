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
  token: string | (() => string);
  channels: string[];
  scope?: string;
  reconnectMs?: number;
}

export interface ActorVM extends ViewModel {
  on$<T = Record<string, unknown>>(channel: string): Observable<T>;
  emit(channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<void>;
  connected$: Observable<boolean>;
  addChannels(channels: string[], scope?: string): void;
  removeChannels(channels: string[]): void;
  start(): void;
  stop(): void;
}

export function createActorVM(options: ActorVMOptions): ActorVM {
  const { baseUrl, token: tokenOrGetter, channels: initialChannels, scope: initialScope, reconnectMs = 5_000 } = options;
  const getToken = typeof tokenOrGetter === 'function' ? tokenOrGetter : () => tokenOrGetter;

  const globalChannels = new Set(initialChannels);
  const scopedChannels = new Set<string>();
  let activeScope = initialScope;

  const events$ = new Subject<BusEvent>();
  const connected$ = new Subject<boolean>();
  let running = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const shared$ = events$.pipe(share());

  const disconnect = () => {
    if (abortController) { abortController.abort(); abortController = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const connect = async () => {
    const params = new URLSearchParams();
    for (const ch of globalChannels) {
      params.append('channel', ch);
    }
    if (activeScope && scopedChannels.size > 0) {
      params.append('scope', activeScope);
      for (const ch of scopedChannels) {
        params.append('scoped', ch);
      }
    }
    const url = `${baseUrl}/bus/subscribe?${params.toString()}`;

    abortController = new AbortController();

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
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

  const reconnect = () => {
    if (!running) return;
    // Emit false before abort so BrowseNamespace's gap-detection treats
    // this as a disconnect cycle and invalidates caches. Without this,
    // abort-driven reconnects (from addChannels/removeChannels) cause
    // in-flight request responses to be delivered to the torn-down
    // connection and silently lost, with no retry signal.
    connected$.next(false);
    disconnect();
    connect();
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
      if (emitScope) body.scope = emitScope;
      await fetch(`${baseUrl}/bus/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(body),
      });
    },

    connected$: connected$.asObservable(),

    addChannels: (channels: string[], scope?: string) => {
      let changed = false;
      if (scope !== undefined) {
        for (const ch of channels) {
          if (!scopedChannels.has(ch)) { scopedChannels.add(ch); changed = true; }
        }
        if (scope !== activeScope) { activeScope = scope; changed = true; }
      } else {
        for (const ch of channels) {
          if (!globalChannels.has(ch)) { globalChannels.add(ch); changed = true; }
        }
      }
      if (changed) reconnect();
    },

    removeChannels: (channels: string[]) => {
      let changed = false;
      for (const ch of channels) {
        if (scopedChannels.delete(ch)) changed = true;
        if (globalChannels.delete(ch)) changed = true;
      }
      if (scopedChannels.size === 0) activeScope = undefined;
      if (changed) reconnect();
    },

    start: () => {
      if (running) return;
      running = true;
      connect();
    },

    stop: () => {
      running = false;
      connected$.next(false);
      disconnect();
    },

    dispose: () => {
      running = false;
      disconnect();
      events$.complete();
      connected$.complete();
    },
  };
}
