import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { filter, map, share } from 'rxjs/operators';
import { busLog, busLogEnabled, uuidV4, type components, type ConnectionState, type StateUnit } from '@semiont/core';
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
  reconnectMs?: number;
  /**
   * Remove-side reconnect hysteresis (MULTI-RESOURCE-SCOPE). Scope
   * additions need liveness quickly (100 ms debounce), but a removal only
   * narrows delivery — extra events for a just-released scope are
   * idempotent locally — so remove-only changes wait this long before
   * reconnecting. Keeps hover-churn (transient per-citation previews)
   * from turning every mouse pass into a reconnect storm; any addition
   * flushes pending removals with it on the fast path.
   */
  lazyRemoveMs?: number;
  /**
   * B17 (LOCAL-STORAGE) — IO-abstracted persistence of the last seen
   * PERSISTED event id PER SCOPE, so a reloaded client resumes each
   * scope's replay instead of gapping. `load` runs once at construction;
   * `save` fires per persisted (`p-*`) id with that frame's scope —
   * ephemeral (`e-*`) ids are never saved: they carry no replay meaning,
   * and letting them displace a scope's watermark was exactly the silent
   * replay-loss hole the single-id design had. The transport stays
   * storage-free; callers wrap their own adapter in these thunks.
   */
  loadLastEventIds?: () => Record<string, string> | null;
  saveLastEventId?: (scope: string, id: string) => void;
}

/** Time in the `reconnecting` state before transitioning to `degraded`. */
export const DEGRADED_THRESHOLD_MS = 3_000;

/**
 * Deadline on the `/bus/emit` POST (JOB-RESTART-SAFETY P7). The gateway
 * accepts an emit and returns 202 promptly; a POST that has not resolved by
 * here means the gateway is unresponsive (mid-restart, overwhelmed), and the
 * emit is rejected rather than awaited forever. This is the transport-level
 * bound behind the 2026-09-03 finalization hang: a worker's mark:create /
 * job:complete emit to a wedged gateway used to hang the worker loop with no
 * timeout of its own. The rejection surfaces as a job failure the queue
 * classifies transient (an unreachable gateway is not the request's fault),
 * so the work retries instead of wedging. Covers EVERY emit and every job
 * type — not just the reference-annotation persist P6 bounded.
 */
export const EMIT_TIMEOUT_MS = 30_000;

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
  emit(channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<number>;
  state$: Observable<ConnectionState>;
  /** With `scope`: upsert channels into that scope's matrix entry. Without: global channels. */
  addChannels(channels: string[], scope?: string): void;
  /**
   * Whether `channel` is in the current GLOBAL subscription set — i.e. the
   * gateway delivers it on this connection. Correlated replies always ride
   * global channels, so this is `busRequest`'s fail-fast probe on a
   * narrowed-subscription transport (see `BusRequestPrimitive.isSubscribed`).
   */
  isSubscribed(channel: string): boolean;
  /** With `scope`: remove channels from that scope's entry (empty entry drops the scope). Without: global channels. */
  removeChannels(channels: string[], scope?: string): void;
  /**
   * Correlated-reply retention, client side (BUS-RESUMPTION Phase 2 /
   * SDK-DEBT S1): register a busRequest correlationId as awaiting its
   * reply. Every connect body includes the currently-tracked set as
   * `pendingReplies`, so a reply published while the connection was down
   * is replayed from the server's retention buffer. The returned disposer
   * (idempotent) removes the id on settle.
   */
  trackReply(correlationId: string): () => void;
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
  const { baseUrl, token: tokenOrGetter, channels: initialChannels, reconnectMs = 5_000, lazyRemoveMs = 5_000 } = options;
  const getToken = typeof tokenOrGetter === 'function' ? tokenOrGetter : () => tokenOrGetter;

  const globalChannels = new Set(initialChannels);
  /** The subscription matrix's scoped half: scope → channels (MULTI-RESOURCE-SCOPE). */
  const scopedSubscriptions = new Map<string, Set<string>>();
  /**
   * Per-scope resumption watermarks: the last PERSISTED (`p-*`) id seen for
   * each scope. Sent as `lastEventId` on that scope's matrix entry so the
   * server replays each scope's own gap. A scope keeps its watermark after
   * its channels are removed — re-subscribing later replays what was missed
   * in between. Ephemeral ids never touch this map.
   */
  const scopeWatermarks = new Map<string, string>(
    Object.entries(options.loadLastEventIds?.() ?? {}),
  );
  /** Outstanding busRequest correlationIds — ride every connect body (S1). */
  const pendingReplies = new Set<string>();
  /**
   * This bus client's routing address for correlated replies
   * (CORRELATED-REPLY-ROUTING D1). Minted once per ACTOR — deliberately not
   * per connection: a make-before-break handover runs two connections at
   * once and a reconnect replaces one, so a per-connection id would strand
   * the reply on the dying socket. Both overlap connections present this
   * same address, and the deterministic `e-<channel>:<cid>` id dedups the
   * double delivery exactly as it does today.
   *
   * Not persisted: "stable" means across transport reconnects, not across
   * page reloads. A reload builds a new actor, and its `pendingReplies`
   * replay is what recovers in-flight replies (S1).
   */
  const clientId = uuidV4();

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
  /** Release a claim whose apply threw, so a redelivery is re-processed
   *  rather than swallowed by its own dedup entry. */
  const forgetEventId = (id: string): void => {
    seenEventIds.delete(id);
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

    // POST subscription matrix (MULTI-RESOURCE-SCOPE): global channels plus
    // one entry per scope, each carrying its own resumption watermark.
    // `satisfies` is the drift-lock (the MEDIA_TYPES idiom): the body is
    // hand-written while the schema owns the shape, so the compiler — not a
    // reviewer — is what notices a required field going missing. That is
    // what makes `clientId` required in BusSubscribeRequest worth anything
    // on this side of the wire (CORRELATED-REPLY-ROUTING P2).
    const body = JSON.stringify({
      global: [...globalChannels],
      scoped: [...scopedSubscriptions.entries()].map(([scope, chans]) => {
        const watermark = scopeWatermarks.get(scope);
        return {
          scope,
          channels: [...chans],
          ...(watermark !== undefined ? { lastEventId: watermark } : {}),
        };
      }),
      ...(pendingReplies.size > 0 ? { pendingReplies: [...pendingReplies] } : {}),
      clientId,
    } satisfies components['schemas']['BusSubscribeRequest']);
    const url = `${baseUrl}/bus/subscribe`;

    const controller = new AbortController();
    inflightControllers.add(controller);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      };
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status}`);
      }

      // Stopped/disposed while the fetch was in flight — don't proceed to open
      // (and retire the old connection on) a stream we've been told to tear
      // down. `stop()`/`dispose()` already aborted this controller.
      if (!running) return;

      // Make-before-break handoff: the new connection is established (the
      // gateway has subscribed it and any `Last-Event-ID` replay is flowing),
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

      /**
       * Segments of the current, still-incomplete line. A single `data:`
       * line carries a whole JSON payload — a browse reply can run to
       * megabytes — delivered across many `reader.read()` chunks. The
       * previous `buffer += chunk` + `buffer.split('\n')` re-flattened and
       * re-scanned the ENTIRE accumulated buffer on every read: O(frame² /
       * chunkSize) bytes of large-string allocation per frame, all landing
       * in V8's large-object space, which only major GC reclaims. Under the
       * reply fan-out burst (~85 multi-MB `browse:*-result` frames/min)
       * that allocation rate outran mark-compact and OOM'd the worker
       * (2026-09-03, DoD #7). Segments are joined exactly once, when the
       * line's newline arrives; each read scans only its own chunk.
       */
      let lineSegments: string[] = [];

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

        const text = decoder.decode(value, { stream: true });

        let searchFrom = 0;
        while (searchFrom <= text.length) {
          const nl = text.indexOf('\n', searchFrom);
          if (nl === -1) {
            if (searchFrom < text.length) {
              lineSegments.push(searchFrom === 0 ? text : text.slice(searchFrom));
            }
            break;
          }
          let line = text.slice(searchFrom, nl);
          searchFrom = nl + 1;
          if (lineSegments.length > 0) {
            lineSegments.push(line);
            line = lineSegments.join('');
            lineSegments = [];
          }
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
              // gateway's writeBusEvent puts it there). The synchronous
              // fan-out to subscribers happens inside the bus.recv span,
              // so handlers see the parent trace.
              const carrier = extractTraceparent(
                parsed.payload as Record<string, unknown>,
              );
              // The two kinds of id bookkeeping sit on OPPOSITE sides of the
              // awaited fan-out, because they answer different questions.
              //
              // `seenEventIds` answers "has this frame been claimed?" and must
              // be recorded BEFORE the await: the await yields the event loop,
              // so during a make-before-break overlap the sibling connection
              // can read the same stable-id frame, find the set still missing
              // it, and deliver it a second time — defeating the overlap dedup
              // (#847) that .plans/bugs/BRIDGE-GAPS.md exists to protect.
              // Rolled back if the apply throws, so a redelivery after a
              // dropped read loop is re-processed rather than silently
              // swallowed by its own claim.
              if (currentId !== undefined) rememberEventId(currentId);
              try {
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
              } catch (err) {
                if (currentId !== undefined) forgetEventId(currentId);
                throw err;
              }
              // The resume watermark and the persisted bookmark answer "have
              // this event's effects been absorbed?" and stay AFTER the apply.
              // The pre-fix order (stash first, then an AWAITED apply) opened a
              // gap where a bystander cache's debounced save could fire
              // mid-await, find every cache quiet, and flush a bookmark whose
              // event nothing had absorbed — the fast-path reload loss
              // (.plans/bugs/annotation-lost-on-immediate-reload-after-create.md).
              // Both stay on the LAGGING side, which is safe: a reconnect or
              // crash mid-apply resumes from the previous id and redelivers,
              // and re-invalidation is idempotent.
              //
              // Watermarks are PER SCOPE and persisted-ids-only: a `p-*` id is
              // stamped only on scoped deliveries (the frame always carries
              // `scope`), and ephemeral ids never displace a scope's watermark
              // — the silent replay-loss hole the old single-id design had.
              if (currentId !== undefined && currentId.startsWith('p-') && parsed.scope) {
                scopeWatermarks.set(parsed.scope, currentId);
                // B17: persist per scope — see ActorStateUnitOptions.
                options.saveLastEventId?.(parsed.scope, currentId);
              }
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
  //
  // Two cadences (MULTI-RESOURCE-SCOPE remove-side hysteresis): additions
  // take the fast 100 ms path (a new scope needs liveness now); remove-only
  // changes wait `lazyRemoveMs` — removal merely narrows delivery, and the
  // consumer's hover churn would otherwise reconnect on every mouse pass.
  // The connect body reads current state, so whichever timer fires first
  // carries ALL pending changes; a fast schedule therefore supersedes any
  // pending lazy one, and a lazy schedule never preempts a pending fast one.
  let reconnectTimer2: ReturnType<typeof setTimeout> | null = null;
  let lazyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const RECONNECT_DEBOUNCE_MS = 100;
  const scheduleReconnect = () => {
    if (lazyReconnectTimer) { clearTimeout(lazyReconnectTimer); lazyReconnectTimer = null; }
    if (reconnectTimer2) clearTimeout(reconnectTimer2);
    reconnectTimer2 = setTimeout(() => {
      reconnectTimer2 = null;
      reconnect();
    }, RECONNECT_DEBOUNCE_MS);
  };
  const scheduleLazyReconnect = () => {
    if (reconnectTimer2 || lazyReconnectTimer) return; // a pending flush already covers this change
    lazyReconnectTimer = setTimeout(() => {
      lazyReconnectTimer = null;
      reconnect();
    }, lazyRemoveMs);
  };

  return {
    on$<T = Record<string, unknown>>(channel: string): Observable<T> {
      return shared$.pipe(
        filter((e) => e.channel === channel),
        map((e) => e.payload as T),
      );
    },

    emit: async (channel: string, payload: Record<string, unknown>, emitScope?: string): Promise<number> => {
      // EMIT logging + bus.emit span live at the transport contract layer
      // (`HttpTransport.emit`). ActorStateUnit is plumbing. We do propagate the
      // active span's W3C traceparent on the outbound POST so the gateway
      // can stitch the bus.dispatch server span as a child.
      const body: Record<string, unknown> = { channel, payload, clientId };
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
      // Bounded (JOB-RESTART-SAFETY P7): an unresponsive gateway must not hang
      // the caller's loop forever. AbortSignal.timeout rejects with a
      // TimeoutError, which propagates like any other emit failure.
      const res = await fetch(`${baseUrl}/bus/emit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
      });
      // A refused emit (validation 400, auth 401…) must REJECT — busRequest's
      // contract detaches its doomed reply and propagates this to the caller.
      // Resolving a sentinel here instead leaves that caller waiting for a
      // reply the gateway will never send.
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 500);
        } catch {
          // status alone
        }
        throw new Error(`/bus/emit ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      // `-1` = count unknown (older gateway / unreadable body) — never let a
      // parse failure read as an empty room. Same sentinel as the Go client.
      try {
        const reply = (await res.json()) as { subscribers?: unknown };
        return typeof reply.subscribers === 'number' ? reply.subscribers : -1;
      } catch {
        return -1;
      }
    },

    state$: state$.asObservable(),

    isSubscribed: (channel: string) => globalChannels.has(channel),

    addChannels: (channels: string[], scope?: string) => {
      let changed = false;
      if (scope !== undefined) {
        let entry = scopedSubscriptions.get(scope);
        if (!entry) {
          entry = new Set<string>();
          scopedSubscriptions.set(scope, entry);
        }
        for (const ch of channels) {
          if (!entry.has(ch)) { entry.add(ch); changed = true; }
        }
      } else {
        for (const ch of channels) {
          if (!globalChannels.has(ch)) { globalChannels.add(ch); changed = true; }
        }
      }
      if (changed) scheduleReconnect();
    },

    removeChannels: (channels: string[], scope?: string) => {
      let changed = false;
      if (scope !== undefined) {
        const entry = scopedSubscriptions.get(scope);
        if (entry) {
          for (const ch of channels) {
            if (entry.delete(ch)) changed = true;
          }
          // The watermark survives the scope's removal deliberately: a later
          // re-subscribe replays what was missed in between.
          if (entry.size === 0) scopedSubscriptions.delete(scope);
        }
      } else {
        for (const ch of channels) {
          if (globalChannels.delete(ch)) changed = true;
        }
      }
      if (changed) scheduleLazyReconnect();
    },

    trackReply: (correlationId: string) => {
      pendingReplies.add(correlationId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pendingReplies.delete(correlationId);
      };
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
      if (lazyReconnectTimer) { clearTimeout(lazyReconnectTimer); lazyReconnectTimer = null; }
      if (degradedTimer) { clearTimeout(degradedTimer); degradedTimer = null; }
      disconnect();
    },

    dispose: () => {
      running = false;
      if (currentState !== 'closed') transition('closed');
      if (reconnectTimer2) { clearTimeout(reconnectTimer2); reconnectTimer2 = null; }
      if (lazyReconnectTimer) { clearTimeout(lazyReconnectTimer); lazyReconnectTimer = null; }
      if (degradedTimer) { clearTimeout(degradedTimer); degradedTimer = null; }
      disconnect();
      events$.complete();
      state$.complete();
    },
  };
}
