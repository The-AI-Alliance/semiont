import { Observable, Subject } from 'rxjs';
import { filter, map, share } from 'rxjs/operators';
import type { ViewModel } from '../lib/view-model';

/**
 * Runtime-toggleable cross-wire bus logging. Off by default — zero
 * cost on the hot path when `window.__SEMIONT_BUS_LOG__` is falsy.
 *
 * Turn on from DevTools:
 *   window.__SEMIONT_BUS_LOG__ = true
 * Or from a Playwright test:
 *   page.addInitScript(() => { window.__SEMIONT_BUS_LOG__ = true; });
 *
 * Output format (grep-friendly):
 *   [bus EMIT] <channel> [scope=X] [cid=<first 8>] <payload>
 *   [bus RECV] <channel> [scope=X] [cid=<first 8>] <payload>
 *
 * This covers only events that cross the browser↔backend boundary —
 * local-only eventBus emissions stay invisible here (by design:
 * they don't go through ActorVM). For full local-bus observation,
 * hook `@semiont/core`'s EventBus separately.
 */
function busLog(
  direction: 'EMIT' | 'RECV',
  channel: string,
  payload: Record<string, unknown>,
  scope?: string,
): void {
  if (typeof globalThis === 'undefined') return;
  const g = globalThis as { __SEMIONT_BUS_LOG__?: boolean };
  if (!g.__SEMIONT_BUS_LOG__) return;
  const cid = (payload as { correlationId?: string } | undefined)?.correlationId;
  const tag = `[bus ${direction}] ${channel}` +
    (scope ? ` scope=${scope}` : '') +
    (cid ? ` cid=${String(cid).slice(0, 8)}` : '');
  // eslint-disable-next-line no-console
  console.debug(tag, payload);
}

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
              busLog('RECV', parsed.channel, parsed.payload, parsed.scope);
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

  // Debounce channel-set-change reconnects. React StrictMode in dev
  // produces mount → cleanup → mount synchronously, which previously
  // translated into three back-to-back reconnects — enough to tear down
  // in-flight responses, fire gap detection, refetch, tear that down
  // again, and leave the page stuck in "Loading..." while caches
  // thrashed. With a short debounce the whole sequence collapses into
  // one reconnect after the final channel-set is stable.
  let reconnectTimer2: ReturnType<typeof setTimeout> | null = null;
  const RECONNECT_DEBOUNCE_MS = 100;
  const scheduleReconnect = () => {
    if (reconnectTimer2) clearTimeout(reconnectTimer2);
    reconnectTimer2 = setTimeout(() => {
      reconnectTimer2 = null;
      reconnect();
    }, RECONNECT_DEBOUNCE_MS);
  };

  return {
    on$<T = Record<string, unknown>>(channel: string): Observable<T> {
      return shared$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },

    emit: async (channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<void> => {
      busLog('EMIT', channel, payload, emitScope);
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
      if (changed) scheduleReconnect();
    },

    removeChannels: (channels: string[]) => {
      let changed = false;
      for (const ch of channels) {
        if (scopedChannels.delete(ch)) changed = true;
        if (globalChannels.delete(ch)) changed = true;
      }
      if (scopedChannels.size === 0) activeScope = undefined;
      if (changed) scheduleReconnect();
    },

    start: () => {
      if (running) return;
      running = true;
      connect();
    },

    stop: () => {
      running = false;
      connected$.next(false);
      if (reconnectTimer2) { clearTimeout(reconnectTimer2); reconnectTimer2 = null; }
      disconnect();
    },

    dispose: () => {
      running = false;
      if (reconnectTimer2) { clearTimeout(reconnectTimer2); reconnectTimer2 = null; }
      disconnect();
      events$.complete();
      connected$.complete();
    },
  };
}
