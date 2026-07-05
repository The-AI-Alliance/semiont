import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { filter, map, share } from 'rxjs/operators';
import { busLog, busLogEnabled, type ConnectionState, type StateUnit } from '@semiont/core';
import {
  SpanKind,
  extractTraceparent,
  getActiveTraceparent,
  withSpan,
  withTraceparent,
} from '@semiont/observability';

export type { ConnectionState };

export interface BusEvent {
  channel: string;
  payload: Record<string, unknown>;
  scope?: string;
}

export interface ActorStateUnitOptions {
  baseUrl: string;
  token: string | (() => string);
  channels: string[];
  scope?: string;
  reconnectMs?: number;
}

/** Time in the `reconnecting` state before transitioning to `degraded`. */
export const DEGRADED_THRESHOLD_MS = 3_000;

/**
 * How long a superseded connection keeps DRAINING after a make-before-break
 * handoff before being aborted. Aborting the old connection the instant the
 * new one opened discarded replies already written to the old socket but not
 * yet read by the client (a freshly-hydrating page's main thread is busy —
 * exactly the N-concurrent-loaders-at-connect repro in
 * .plans/bugs/concurrent-browse-resource-starvation.md). The overlap is safe:
 * persisted ids are stable and correlated-reply ids are deterministic
 * (`e-<channel>:<cid>`, routes/bus.ts), so `seenEventIds` dedups double
 * delivery.
 */
export const LINGER_MS = 1_000;

export interface ActorStateUnit extends StateUnit {
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
  // `degraded → reconnecting` is a legitimate recovery edge: a channel-set
  // change (`addChannels`/`removeChannels`) schedules a reconnect that can
  // fire while the connection is degraded. Omitting it made `reconnect()`
  // throw a fatal, uncaught exception from the reconnect timer (#844).
  degraded:     ['connecting', 'reconnecting', 'closed'],
  closed:       [],
};

export function createActorStateUnit(options: ActorStateUnitOptions): ActorStateUnit {
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
   * Move the state machine to `next`. An unexpected edge is logged and
   * ignored — NOT thrown. `transition()` runs inside timer callbacks (the
   * reconnect and degraded timers), so a throw here is an uncaught exception
   * that takes down the host process (#844). A bad edge means a bug in the
   * reconnect loop, but degrading gracefully (keep the current state, warn)
   * is strictly better than killing a long-running job. The permitted edges
   * — including the `degraded → reconnecting` recovery edge — are in
   * `ALLOWED_TRANSITIONS`.
   *
   * Side effect: manages the `degraded` timer. Enters on
   * `reconnecting`, cleared on exit.
   */
  const transition = (next: ConnectionState): void => {
    if (currentState === next) return;
    const allowed = ALLOWED_TRANSITIONS[currentState];
    if (!allowed.includes(next)) {
      console.warn(`[actor] ignoring invalid connection state transition: ${currentState} → ${next}`);
      return;
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
   * Connections retired by a make-before-break handoff. A superseded
   * connection lingers (still draining) for LINGER_MS before its abort; its
   * read loop ending — naturally or via that abort — must NOT drive the
   * actor-wide reconnect logic, which belongs to the live connection only.
   */
  const superseded = new WeakSet<AbortController>();
  /** Pending linger-abort timers, cleared on stop/dispose. */
  const lingerTimers = new Set<ReturnType<typeof setTimeout>>();

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

  /**
   * Recently-delivered event ids, to dedup the make-before-break overlap: the
   * brief window where the old and new connection both deliver the same live
   * event during a scope-change handoff. Persisted ids (`p-<scope>-<seq>`) are
   * stable across connections, so this collapses such an overlap to a single
   * emission. Ephemeral ids (`e-<connectionId>-<counter>`) are per-connection,
   * so a cross-connection ephemeral duplicate is NOT caught here — its
   * consumers tolerate the rare double (a correlation reply is taken with
   * `take(1)`; cache invalidations and job-completion are idempotent/terminal).
   * Bounded FIFO (insertion-ordered Set) to cap memory.
   *
   * Cost note: this is *always-on* — every delivered event does a has/add here
   * — yet a duplicate is only possible during a handoff overlap; in steady
   * state there's a single connection and nothing can collide. So every
   * consumer of this transport carries a small standing structure for a path
   * that fires only on (now-rare) scope changes. It's left unconditional
   * because the per-event cost is negligible next to the JSON.parse + trace
   * span already on this path. If that ever stops being true, scope it to the
   * overlap (build on handoff start, drop once the old read loop exits) or
   * track a high-water `Map<scope, maxSeq>` instead of every id.
   */
  const seenEventIds = new Set<string>();
  const SEEN_EVENT_IDS_MAX = 512;
  const rememberEventId = (id: string): void => {
    seenEventIds.add(id);
    if (seenEventIds.size > SEEN_EVENT_IDS_MAX) {
      const oldest = seenEventIds.values().next().value;
      if (oldest !== undefined) seenEventIds.delete(oldest);
    }
  };

  const shared$ = events$.pipe(share());

  const disconnect = () => {
    for (const c of inflightControllers) {
      try { c.abort(); } catch { /* noop */ }
    }
    inflightControllers.clear();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    for (const t of lingerTimers) clearTimeout(t);
    lingerTimers.clear();
  };

  const connect = async (keepPrevious = false) => {
    // Transition to `connecting` from whichever reconnect-ish state
    // we're currently in (`initial`, `reconnecting`, `degraded`).
    transition('connecting');

    // Snapshot the connections this connect() supersedes.
    //   - keepPrevious=false (initial connect / drop-recovery): there is no
    //     live connection worth preserving, so abort up front — this closes
    //     the orphan-stream leak described above.
    //   - keepPrevious=true (scope-change reconnect): MAKE-BEFORE-BREAK. Keep
    //     the previous connection(s) ALIVE until the new one is `open`, then
    //     abort them (below, after the fetch resolves), so an in-flight
    //     ephemeral result isn't dropped in a reconnect gap (#847). The brief
    //     window where old and new both deliver is deduped by event id.
    const previous = [...inflightControllers];
    if (!keepPrevious) {
      for (const c of previous) {
        try { c.abort(); } catch { /* noop */ }
      }
      inflightControllers.clear();
    }

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

      // Stopped/disposed while the fetch was in flight — don't proceed to open
      // (and retire the old connection on) a stream we've been told to tear
      // down. `stop()`/`dispose()` already aborted this controller.
      if (!running) return;

      // Make-before-break handoff: the new connection is established (the
      // backend has subscribed it and any `Last-Event-ID` replay is flowing),
      // so mark the previous connection(s) superseded and LINGER them — keep
      // them draining for LINGER_MS before the abort. Aborting immediately
      // here discarded replies already written to the old socket but not yet
      // read (the buffered-bytes loss in
      // .plans/bugs/concurrent-browse-resource-starvation.md); an event
      // delivered by both connections during the overlap is deduped by id in
      // the read loop below (persisted ids are stable; correlated-reply ids
      // are deterministic per routes/bus.ts). Had the fetch failed, we'd have
      // thrown above and never reached here, leaving the old connection live
      // (no gap).
      if (keepPrevious) {
        for (const c of previous) superseded.add(c);
        const lingerTimer = setTimeout(() => {
          lingerTimers.delete(lingerTimer);
          for (const c of previous) {
            try { c.abort(); } catch { /* noop */ }
            inflightControllers.delete(c);
          }
        }, LINGER_MS);
        lingerTimers.add(lingerTimer);
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
            // Skip an overlap duplicate — the same stable-id event delivered
            // by both the old and new connection during a make-before-break
            // handoff (#847). Ephemeral ids are unique per connection, so this
            // never spuriously drops a distinct event.
            const isDuplicate = currentId !== undefined && seenEventIds.has(currentId);
            if (currentEvent === 'bus-event' && currentData && !isDuplicate) {
              if (currentId !== undefined) {
                lastEventId = currentId;
                rememberEventId(currentId);
              }
              const parsed = JSON.parse(currentData) as BusEvent;
              busLog('RECV', parsed.channel, parsed.payload, parsed.scope);
              // Drain-window forensics: an event delivered by a SUPERSEDED
              // (lingering) connection is one that an immediate handover abort
              // would have discarded — the loss mode of
              // .plans/bugs/concurrent-browse-resource-starvation.md. Gated
              // (per-event, bursty during overlap); flip bus logging on to
              // see how real the window is.
              if (busLogEnabled() && superseded.has(controller)) {
                // eslint-disable-next-line no-console
                console.debug(`[bus LINGER] ${parsed.channel} delivered on superseded connection`);
              }
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
    // retry after `reconnectMs` — unless this was a SUPERSEDED (lingering)
    // connection ending: its termination is expected teardown, not a drop
    // of the live stream, and must not restart the reconnect machinery.
    if (running && !superseded.has(controller)) {
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
    // Make-before-break: do NOT abort the live connection here. Cancel only a
    // pending drop-recovery retry, then connect — `connect(keepPrevious=true)`
    // retires the old connection after the new one is open (no gap).
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connect(true);
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
      // (`HttpTransport.emit`). ActorStateUnit is plumbing. We do propagate the
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
