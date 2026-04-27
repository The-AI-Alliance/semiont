import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { filter, map, share } from 'rxjs/operators';
import { busLog, type ConnectionState } from '@semiont/core';
import {
  SpanKind,
  extractTraceparent,
  getActiveTraceparent,
  withSpan,
  withTraceparent,
} from '@semiont/observability';

/** Minimal ViewModel surface — anything with a `dispose()` method. */
interface ViewModel {
  dispose(): void;
}

export type { ConnectionState };

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

/** Time in the `reconnecting` state before transitioning to `degraded`. */
export const DEGRADED_THRESHOLD_MS = 3_000;

export interface ActorVM extends ViewModel {
  on$<T = Record<string, unknown>>(channel: string): Observable<T>;
  emit(channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<void>;
  state$: Observable<ConnectionState>;
  addChannels(channels: string[], scope?: string): void;
  removeChannels(channels: string[]): void;
  start(): void;
  stop(): void;
}

/** Allowed transitions in the connection state machine. */
const ALLOWED_TRANSITIONS: Record<ConnectionState, ReadonlyArray<ConnectionState>> = {
  initial:      ['connecting', 'closed'],
  connecting:   ['open', 'reconnecting', 'closed'],
  open:         ['reconnecting', 'closed'],
  reconnecting: ['connecting', 'degraded', 'closed'],
  degraded:     ['connecting', 'closed'],
  closed:       [],
};

export function createActorVM(options: ActorVMOptions): ActorVM {
  const { baseUrl, token: tokenOrGetter, channels: initialChannels, scope: initialScope, reconnectMs = 5_000 } = options;
  const getToken = typeof tokenOrGetter === 'function' ? tokenOrGetter : () => tokenOrGetter;

  const globalChannels = new Set(initialChannels);
  const scopedChannels = new Set<string>();
  let activeScope = initialScope;

  const events$ = new Subject<BusEvent>();
  const state$ = new BehaviorSubject<ConnectionState>('initial');
  let currentState: ConnectionState = 'initial';
  let degradedTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Move the state machine to `next`. Throws on invalid transitions.
   * The throw is deliberate — a bad transition means a bug in the
   * reconnect loop; silent correction would hide it. The reconnect
   * timer logic is responsible for ensuring we only transition
   * between valid states.
   *
   * Side effect: manages the `degraded` timer. Enters on
   * `reconnecting`, cleared on exit.
   */
  const transition = (next: ConnectionState): void => {
    if (currentState === next) return;
    const allowed = ALLOWED_TRANSITIONS[currentState];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid connection state transition: ${currentState} → ${next}`);
    }
    const prev = currentState;
    currentState = next;

    if (next === 'reconnecting' && prev !== 'reconnecting') {
      // Starting a reconnect cycle — arm the degraded-threshold timer.
      if (degradedTimer) clearTimeout(degradedTimer);
      degradedTimer = setTimeout(() => {
        if (currentState === 'reconnecting') transition('degraded');
      }, DEGRADED_THRESHOLD_MS);
    }
    if (prev === 'reconnecting' && next !== 'reconnecting') {
      // Leaving reconnecting (to connecting, degraded, or closed) —
      // the timer is either no longer relevant or has just fired.
      if (degradedTimer) { clearTimeout(degradedTimer); degradedTimer = null; }
    }

    state$.next(next);
  };

  let running = false;
  /**
   * All in-flight SSE fetch controllers. Tracked as a Set because
   * connect() may race with itself under mount-churn or rapid channel-
   * set changes — whenever a new connect() starts we abort ALL previous
   * in-flight fetches rather than only the last-tracked one. A previous
   * single-slot implementation leaked orphaned streams (diagnosed by
   * observing 3 concurrent SSE subscribes in the /bus/subscribe network
   * log, each delivering duplicate RECV frames). Using a Set guarantees
   * at most one live stream post-reconnect regardless of race order.
   */
  const inflightControllers = new Set<AbortController>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `Last-Event-ID` of the most recently delivered SSE event from the
   * server. Sent as a request header on each connect so the server can
   * replay persisted events missed during the disconnect (see
   * `apps/backend/src/routes/bus.ts` subscribe handler). Initialised
   * `null` — fresh connections send no header.
   *
   * We track both persisted (`p-*`) and ephemeral (`e-*`) ids. The server
   * treats ephemeral ids as "no resumption context" and responds live-
   * only; persisted ids drive replay.
   */
  let lastEventId: string | null = null;

  const shared$ = events$.pipe(share());

  const disconnect = () => {
    for (const c of inflightControllers) {
      try { c.abort(); } catch { /* noop */ }
    }
    inflightControllers.clear();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const connect = async () => {
    // Transition to `connecting` from whichever reconnect-ish state
    // we're currently in (`initial`, `reconnecting`, `degraded`).
    transition('connecting');

    // Abort every previous in-flight fetch before starting a new one.
    // This closes the orphan-stream leak described above.
    for (const c of inflightControllers) {
      try { c.abort(); } catch { /* noop */ }
    }
    inflightControllers.clear();

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

    const controller = new AbortController();
    inflightControllers.add(controller);

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const response = await fetch(url, { headers, signal: controller.signal });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }

      transition('open');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE parse state is declared OUTSIDE the read loop: a single
      // event can span many `reader.read()` chunks when the payload is
      // large (a full resource-result with annotations can easily exceed
      // one TCP segment). Resetting these on every read would silently
      // drop any event whose `event:`/`id:` headers land in one chunk
      // and whose terminating blank line lands in the next.
      let currentEvent = '';
      let currentData = '';
      let currentId: string | undefined;

      while (running && inflightControllers.has(controller)) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line.startsWith('id: ')) {
            currentId = line.slice(4);
          } else if (line === '') {
            if (currentEvent === 'bus-event' && currentData) {
              if (currentId !== undefined) lastEventId = currentId;
              const parsed = JSON.parse(currentData) as BusEvent;
              busLog('RECV', parsed.channel, parsed.payload, parsed.scope);
              // Tier 2: lift trace context off the SSE payload (the
              // backend's writeBusEvent puts it there). The synchronous
              // fan-out to subscribers happens inside the bus.recv span,
              // so handlers see the parent trace.
              const carrier = extractTraceparent(
                parsed.payload as Record<string, unknown>,
              );
              await withTraceparent(carrier, () =>
                withSpan(
                  `bus.recv:${parsed.channel}`,
                  () => { events$.next(parsed); },
                  {
                    kind: SpanKind.CONSUMER,
                    attrs: {
                      'bus.channel': parsed.channel,
                      ...(parsed.scope ? { 'bus.scope': parsed.scope } : {}),
                    },
                  },
                ),
              );
            }
            currentEvent = '';
            currentData = '';
            currentId = undefined;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // Any non-abort error falls through to the reconnect-retry block.
    } finally {
      inflightControllers.delete(controller);
    }

    // If we reached here without an AbortError, the connection dropped
    // or the fetch failed. Transition to reconnecting and schedule a
    // retry after `reconnectMs`.
    if (running) {
      transition('reconnecting');
      reconnectTimer = setTimeout(() => {
        if (running) connect();
      }, reconnectMs);
    }
  };

  const reconnect = () => {
    if (!running) return;
    // Transition to `reconnecting` BEFORE aborting the current
    // connection. This matches the pre-state-machine contract where
    // gap-detection relied on seeing a "dropped" signal before a
    // subsequent "connected" signal; with the state machine, the
    // transition sequence `open → reconnecting → connecting → open`
    // is what BrowseNamespace's gap-detection (pre-BUS-RESUMPTION
    // code path) watches for.
    if (currentState === 'open' || currentState === 'connecting' || currentState === 'degraded') {
      transition('reconnecting');
    }
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
      // EMIT logging + bus.emit span live at the transport contract layer
      // (`HttpTransport.emit`). ActorVM is plumbing. We do propagate the
      // active span's W3C traceparent on the outbound POST so the backend
      // can stitch the bus.dispatch server span as a child.
      const body: Record<string, unknown> = { channel, payload };
      if (emitScope) body.scope = emitScope;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      };
      const trace = getActiveTraceparent();
      if (trace) {
        headers['traceparent'] = trace.traceparent;
        if (trace.tracestate) headers['tracestate'] = trace.tracestate;
      }
      await fetch(`${baseUrl}/bus/emit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    },

    state$: state$.asObservable(),

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
      if (currentState !== 'closed') transition('closed');
      if (reconnectTimer2) { clearTimeout(reconnectTimer2); reconnectTimer2 = null; }
      if (degradedTimer) { clearTimeout(degradedTimer); degradedTimer = null; }
      disconnect();
    },

    dispose: () => {
      running = false;
      if (currentState !== 'closed') transition('closed');
      if (reconnectTimer2) { clearTimeout(reconnectTimer2); reconnectTimer2 = null; }
      if (degradedTimer) { clearTimeout(degradedTimer); degradedTimer = null; }
      disconnect();
      events$.complete();
      state$.complete();
    },
  };
}
