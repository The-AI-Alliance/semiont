import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';
import type { EventBus, StoredEvent, EnvironmentConfig } from '@semiont/core';
import { BUS_OPERATIONS, CHANNEL_SCHEMAS, busLog, resourceId as makeResourceId } from '@semiont/core';
import {
  SpanKind,
  injectTraceparent,
  recordBusEmit,
  recordResumeGap,
  recordUnanswerableRequest,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  withSpan,
  withTraceparent,
} from '@semiont/observability';
import { getLogger } from '../logger';
import type { Principal } from '../identity/principal';
import {
  MAX_SCOPES,
  PENDING_REPLIES_MAX,
  SCOPE_WARN_THRESHOLD,
  compositionFor,
  isCorrelatedChannel,
  toReplyAddress,
  type PlaneSubscription,
} from '../signal';
import { LEDGER_ADDRESS } from '../signal/ledger';
import { archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';
import type { ServiceAccountCredential } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import type { HttpBindings } from '@hono/node-server';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

const getBusLogger = () => getLogger().child({ component: 'bus' });

/**
 * Fetch `Last-Event-ID` replay from the Archivist's D1 read path
 * (EXTRACT-ARCHIVIST): one narrow call — the events for one resource from
 * one sequence, inclusive. The gateway is still this endpoint's only
 * customer.
 *
 * What may live on the Archivist's HTTP surface at all is decided in ONE
 * place — the standing rule in `archivist-read-path.ts`, rewritten when
 * SINGLE-KB-MOUNT D1 re-examined it. Do not restate it here; a second copy
 * is how the two drift, which is precisely what happened to the version
 * this comment used to carry.
 *
 * Address and auth come from `archivistEndpoint` (@semiont/core/node),
 * shared with the content proxying and with the fleet's own byte readers so
 * the deployment fact has one home. A missing host or secret throws — the
 * caller's catch degrades to a scoped `bus:resume-gap`, which is the honest
 * answer when the record cannot be reached.
 */
async function fetchArchivistReplay(
  config: ArchivistAddressConfig,
  credential: ServiceAccountCredential,
  resourceId: string,
  fromSequence: number,
): Promise<StoredEvent[]> {
  const { base, headers } = await archivistEndpoint(config, credential);
  // A CLIENT span for the same reason lib/archivist.ts wraps its three calls:
  // this crosses to another service, and without it a slow replay is
  // indistinguishable from a slow gateway.
  const res = await withSpan(
    'archivist.events.replay',
    () => fetch(
      `${base}/events/${encodeURIComponent(resourceId)}?fromSequence=${fromSequence}`,
      { headers },
    ),
    { kind: SpanKind.CLIENT, attrs: { 'peer.service': 'archivist' } },
  );
  if (!res.ok) {
    throw new Error(`Archivist replay read failed: ${res.status} ${res.statusText}`);
  }
  const { events } = await res.json() as { events: StoredEvent[] };
  return events;
}

/**
 * SSE event id stamping.
 *
 * - Persisted domain events (the set named in `PERSISTED_EVENT_TYPES` and
 *   delivered on the scoped bus via `eventBus.scope(rId)`) get an id of
 *   the form `p-<scope>-<sequenceNumber>`. These ids are resumable — a
 *   client reconnecting with `lastEventId: p-<scope>-<N>` on that scope's
 *   entry in the POST /bus/subscribe matrix receives replay of events
 *   with sequenceNumber > N in that scope before joining the live tail.
 *   Resumption is PER SCOPE (MULTI-RESOURCE-SCOPE): each scoped entry
 *   carries its own watermark; entries without one are fresh
 *   subscriptions and get neither replay nor gap event.
 *
 * - All other events — command responses, progress, ephemeral signals —
 *   get an id of the form `e-<connectionId>-<counter>`. These ids are
 *   unique per connection and carry no replay meaning; clients never
 *   store them as watermarks. A watermark the server cannot honor
 *   (unparseable, wrong scope, retention exceeded, query error) yields a
 *   scoped synthetic `bus:resume-gap` so the client falls back to cache
 *   invalidation for that scope.
 */
const PERSISTED_ID_PREFIX = 'p-';
const EPHEMERAL_ID_PREFIX = 'e-';

function parsePersistedId(raw: string | undefined): { scope: string; sequence: number } | null {
  if (!raw || !raw.startsWith(PERSISTED_ID_PREFIX)) return null;
  const body = raw.slice(PERSISTED_ID_PREFIX.length);
  const lastDash = body.lastIndexOf('-');
  if (lastDash <= 0 || lastDash === body.length - 1) return null;
  const scope = body.slice(0, lastDash);
  const seq = Number(body.slice(lastDash + 1));
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { scope, sequence: seq };
}

function makePersistedId(scope: string, sequence: number): string {
  return `${PERSISTED_ID_PREFIX}${scope}-${sequence}`;
}

function makeEphemeralId(connectionId: string, counter: number): string {
  return `${EPHEMERAL_ID_PREFIX}${connectionId}-${counter}`;
}

function extractSequence(payload: unknown): number | null {
  const seq = (payload as { metadata?: { sequenceNumber?: unknown } } | null | undefined)?.metadata?.sequenceNumber;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

/** One scoped entry of the POST /bus/subscribe subscription matrix. */
interface ScopedSubscription {
  scope: string;
  channels: string[];
  lastEventId?: string;
}

/**
 * Outbound flow-control bound, per SSE connection. `writeSSE` resolves only
 * when the connection's consumer accepts the chunk, so the bytes held by
 * unresolved writes measure exactly what this subscriber forces the gateway
 * to buffer. A half-open socket — a client container torn down without a
 * FIN — never errors and never closes, so without a bound its bus
 * subscriptions accumulate every fan-out payload as a pending write until
 * the heap bursts (gateway OOM, 2026-09-03: ~8 such subscribers each
 * holding the full `browse:*-result` stream). Past the bound the subscriber
 * is disconnected: a live client reconnects with Last-Event-ID /
 * `pendingReplies` and resumes; a dead one stops costing memory.
 */
export const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;

/**
 * Same protection for the buffer-during-replay window: a connection that
 * stalls mid-replay must not queue live fan-out without limit either.
 */
export const MAX_REPLAY_BUFFER_EVENTS = 1_000;

// ── The seam (SIGNAL-PLANE P0) ─────────────────────────────────────────
//
// Ingest and fan-out go through the `SignalPlane` driver (../signal — the
// in-process one here; P1 adds NATS behind the same conformance suite). The
// correlation LEDGER — claims, entitlement and its refusals, retention —
// is gateway POLICY and lives in ../signal/ledger, above the seam. The
// matrix caps and the ledger budgets are the seam's construction options
// (../signal/options — D8's seven, today's values as defaults).

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Validate the subscription-matrix body (schema: BusSubscribeRequest).
 * Returns an error message rather than throwing so the route can wrap it
 * in a single HTTPException site.
 */
function parseSubscribeBody(raw: unknown): { global: string[]; scoped: ScopedSubscription[]; pendingReplies: string[]; clientId: string } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const { global: rawGlobal, scoped: rawScoped, pendingReplies: rawPending, clientId } = raw as {
    global?: unknown;
    scoped?: unknown;
    pendingReplies?: unknown;
    clientId?: unknown;
  };
  // Required by BusSubscribeRequest (P1). It is the routing address the
  // delivery filter matches on; without it a client would silently receive no
  // correlated replies at all, which is the failure this rejects up front.
  if (typeof clientId !== 'string' || clientId === '') {
    return { error: '`clientId` is required (BusSubscribeRequest)' };
  }
  // The shared ledger address (SIGNAL-PLANE P3): every replica's claim
  // announcements fan out to subscriptions holding it, so a client wearing
  // the name would receive the cluster's claim metadata. Reserved.
  if (clientId === LEDGER_ADDRESS) {
    return { error: `\`clientId\` "${clientId}" is reserved` };
  }
  const global = rawGlobal === undefined ? [] : rawGlobal;
  if (!isStringArray(global)) return { error: '`global` must be an array of channel names' };

  const pendingReplies = rawPending === undefined ? [] : rawPending;
  if (!isStringArray(pendingReplies)) return { error: '`pendingReplies` must be an array of correlation ids' };
  if (pendingReplies.length > PENDING_REPLIES_MAX) {
    return { error: `pendingReplies count ${pendingReplies.length} exceeds the cap of ${PENDING_REPLIES_MAX}` };
  }

  const scopedList = rawScoped === undefined ? [] : rawScoped;
  if (!Array.isArray(scopedList)) return { error: '`scoped` must be an array' };
  const scoped: ScopedSubscription[] = [];
  const seenScopes = new Set<string>();
  for (const entry of scopedList) {
    if (entry === null || typeof entry !== 'object') return { error: 'each `scoped` entry must be an object' };
    const { scope, channels, lastEventId } = entry as Record<string, unknown>;
    if (typeof scope !== 'string' || scope === '') return { error: 'each `scoped` entry needs a non-empty `scope`' };
    if (!isStringArray(channels) || channels.length === 0) return { error: `scoped entry "${scope}" needs a non-empty \`channels\` array` };
    if (lastEventId !== undefined && typeof lastEventId !== 'string') return { error: `scoped entry "${scope}" has a non-string \`lastEventId\`` };
    if (seenScopes.has(scope)) return { error: `duplicate scope "${scope}" in matrix` };
    seenScopes.add(scope);
    scoped.push({ scope, channels, ...(lastEventId !== undefined ? { lastEventId } : {}) });
  }

  if (global.length === 0 && scoped.length === 0) {
    return { error: 'At least one global channel or scoped entry is required' };
  }
  if (scoped.length > MAX_SCOPES) {
    return { error: `scope count ${scoped.length} exceeds the per-connection cap of ${MAX_SCOPES}` };
  }
  return { global, scoped, pendingReplies, clientId };
}

/**
 * Plane + ledger arrive through `compositionFor` (SIGNAL-PLANE P3 GREEN):
 * boot pre-seeds the composition with the configured driver (index.ts —
 * the NATS driver's async construction is why selection happens there);
 * a bus nobody seeded — every existing test constructs the router bare —
 * lazily composes an in-process plane, which is exactly the pre-selection
 * behavior. The router owns no plane or registry state of its own anymore.
 */
export function createBusRouter(authMiddleware: AuthMiddleware) {
  const busRouter = new Hono<{ Variables: { principal: Principal; eventBus: EventBus; config: EnvironmentConfig } }>();

  busRouter.use('/bus/*', authMiddleware);

  busRouter.post('/bus/subscribe', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = parseSubscribeBody(raw);
    if ('error' in parsed) {
      throw new HTTPException(400, { message: parsed.error });
    }
    const { global: channels, scoped, pendingReplies, clientId } = parsed;
    const eventBus = c.get('eventBus');
    // Read OUTSIDE the stream callback: `c` is the request context, and the
    // presence pair below must name the principal on this connection.
    const subscriberDid = c.get('principal')?.did;

    const composition = compositionFor(eventBus);
    const plane = composition.plane;

    if (scoped.length >= SCOPE_WARN_THRESHOLD) {
      getBusLogger().warn('large scope matrix', { scopeCount: scoped.length, cap: MAX_SCOPES });
    }

    return streamSSE(c, async (stream) => {
      // Ephemeral id generator for this connection.
      const connectionId = crypto.randomUUID();
      let ephemeralCounter = 0;
      const nextEphemeralId = () => makeEphemeralId(connectionId, ++ephemeralCounter);

      // Per-connection record of exactly which channels this subscriber asked
      // for. Makes a missing fan-in wiring greppable: if a reply channel is
      // absent from `channels` here, the gateway will never forward it to this
      // client and any `busRequest` on it times out at 30 s with no error.
      // (Pairs with the emit-side `[bus DROP]` warn; that fires when nothing
      // subscribes at all, this shows what a given client *did* subscribe to.)
      // See .plans/bugs/gather-resource-complete-not-bridged.md.
      getBusLogger().info('SSE subscribe', {
        connectionId,
        channels,
        scopes: scoped.map((s) => ({
          scope: s.scope,
          channels: s.channels,
          ...(s.lastEventId ? { lastEventId: s.lastEventId } : {}),
        })),
      });

      // Tier 3: track active SSE subscribers via UpDownCounter. Connect
      // increments; disconnect (teardown below) decrements. The gauge
      // reflects current concurrent SSE connections per service instance.
      //
      // The same two moments are PRESENCE (GUIDED-TOUR D5): the gateway
      // already knew who was watching and only counted it. Publishing it
      // needs no new tracking — one emit each side. Presence is connection
      // lifecycle, NOT login: a token can be minted and sit unused for hours,
      // and what a collaborator (or a tour script) needs to know is whether
      // anyone is actually watching.
      //
      // connectionId rides along because the DID cannot stand alone: one
      // person with two tabs is two connections under one principal, so a
      // consumer that retires presence by DID would drop a viewer who merely
      // closed a duplicate tab.
      const presence = { participant: subscriberDid ?? '', connectionId };
      recordSubscriberConnect();
      plane.ingest('session:joined', presence);

      // ── Connection teardown ───────────────────────────────────────────
      //
      // One idempotent teardown, whichever detector notices the death
      // first: the stream abort (socket closed and the adapter cancelled
      // our readable), the request signal (socket closed but the readable
      // cancel path did not run), or the pending-write bound in
      // `boundedWrite` (the socket never closed at all).
      let planeSub: PlaneSubscription | undefined;
      let pendingBytes = 0;
      let tornDown = false;
      const { outgoing } = (c.env ?? {}) as Partial<HttpBindings>;
      const teardown = (reason: string) => {
        if (tornDown) return;
        tornDown = true;
        planeSub?.close();
        recordSubscriberDisconnect();
        plane.ingest('session:left', presence);
        getBusLogger().info('SSE disconnect', { connectionId, reason, pendingBytes });
        // abort() rejects the pending writer.write()s, releasing the
        // frames they hold; destroy() closes the socket itself so the OS
        // send buffer goes too. Both are no-ops on an already-dead
        // connection (and `outgoing` is absent outside the node adapter).
        stream.abort();
        outgoing?.destroy();
      };
      stream.onAbort(() => teardown('stream-abort'));
      // Hono forwards the request signal to the stream only on old Bun; on
      // Node the adapter aborts the signal when the response socket closes
      // and nothing tells the stream. Forward it ourselves so socket close
      // reaps this connection even when the readable-cancel path is wedged.
      c.req.raw.signal.addEventListener('abort', () => stream.abort(), { once: true });
      if (c.req.raw.signal.aborted) {
        teardown('pre-aborted');
        return;
      }

      /**
       * Every frame leaves through here so `pendingBytes` counts exactly
       * what this connection forces the gateway to hold: `writeSSE`
       * resolves only when the consumer accepts the chunk, so a dead or
       * stalled subscriber accumulates unresolved writes, each retaining
       * its serialized frame. Past MAX_PENDING_WRITE_BYTES the subscriber
       * is disconnected.
       */
      const boundedWrite = async (frame: { event: string; data: string; id?: string }): Promise<void> => {
        if (tornDown) return;
        const cost = frame.data.length;
        pendingBytes += cost;
        if (pendingBytes > MAX_PENDING_WRITE_BYTES) {
          getBusLogger().warn('SSE pending-write overflow — disconnecting dead or stalled subscriber', {
            connectionId,
            pendingBytes,
            cap: MAX_PENDING_WRITE_BYTES,
          });
          teardown('pending-write-overflow');
          return;
        }
        try {
          await stream.writeSSE(frame);
        } finally {
          pendingBytes -= cost;
        }
      };

      /** Tracks last persisted seq delivered per scope, for replay→live dedup. */
      const lastDeliveredSeq = new Map<string, number>();

      /**
       * Write an event-bus payload to the SSE stream with an `id:` stamp.
       * Updates `lastDeliveredSeq` so live events arriving during/after
       * replay get deduplicated against already-delivered sequences.
       */
      const writeBusEvent = async (
        channel: string,
        payload: unknown,
        eventScope: string | undefined,
        correlationId: string | undefined,
      ): Promise<void> => {
        const seq = extractSequence(payload);
        let id: string;
        if (seq !== null && eventScope) {
          const delivered = lastDeliveredSeq.get(eventScope);
          if (delivered !== undefined && seq <= delivered) return;
          lastDeliveredSeq.set(eventScope, seq);
          id = makePersistedId(eventScope, seq);
        } else {
          // Deterministic ephemeral id for correlation replies. A make-before-break
          // reconnect (subscribeToResource → addChannels) keeps the old + new SSE
          // connections live briefly, and the client dedups the overlap by event id
          // (actor-state-unit `seenEventIds`). A per-connection `nextEphemeralId()`
          // tags the same reply with a different id on each connection → the dedup
          // misses it → duplicate delivery (.plans/bugs/BRIDGE-GAPS.md). Keying on
          // channel + correlationId makes both connections agree. Still `e-`-prefixed,
          // so it stays non-replayable.
          const cid = correlationId;
          id =
            typeof cid === 'string' && cid.length > 0
              ? `${EPHEMERAL_ID_PREFIX}${channel}:${cid}`
              : nextEphemeralId();
        }
        // Tier 2: attach the active span's W3C traceparent to the payload so
        // the receiving client can stitch its bus.recv span as a child. SSE
        // has no header trailer, so trace-context rides on the payload as
        // `_trace`.
        //
        // For request/reply *replies* (frames carrying a correlationId) we
        // also open a short `sse.deliver:<channel>` span: the trace then shows
        // the reply actually leaving the gateway for this client — the
        // delivered-counterpart to the emit-side `[bus DROP]` warn, so a
        // delivered-to-wrong-cid or never-delivered reply is visible in one
        // trace instead of cross-referenced by hand. `injectTraceparent` runs
        // *inside* the span so the client's recv stitches under the deliver,
        // not its parent. Non-reply broadcasts skip the span — they're
        // high-volume and have no single awaiting client.
        const cid = correlationId;
        const doWrite = async (): Promise<void> => {
          if (payload && typeof payload === 'object') {
            injectTraceparent(payload as Record<string, unknown>);
          }
          const data = eventScope
            ? JSON.stringify({ channel, correlationId: cid, payload, scope: eventScope })
            : JSON.stringify({ channel, correlationId: cid, payload });
          busLog('SSE', channel, payload, eventScope, cid);
          await boundedWrite({ event: 'bus-event', data, id });
        };
        if (typeof cid === 'string' && cid.length > 0) {
          await withSpan(`sse.deliver:${channel}`, doWrite, {
            kind: SpanKind.PRODUCER,
            attrs: {
              'bus.channel': channel,
              'bus.cid': cid,
              ...(eventScope ? { 'bus.scope': eventScope } : {}),
            },
          });
        } else {
          await doWrite();
        }
      };

      const emitResumeGap = async (reason: string, gapScope?: string, lastSeenId?: string) => {
        // Counted at the ONE funnel every gap path goes through. `reason` is a
        // closed set (scope-mismatch, unparseable-last-event-id, replay
        // failure), so the label stays low-cardinality.
        recordResumeGap(reason);
        const payload: { scope?: string; lastSeenId?: string; reason: string } = { reason };
        if (gapScope !== undefined) payload.scope = gapScope;
        if (lastSeenId !== undefined) payload.lastSeenId = lastSeenId;
        await boundedWrite({
          event: 'bus-event',
          data: JSON.stringify({ channel: 'bus:resume-gap', payload }),
          id: nextEphemeralId(),
        });
      };

      // ── Subscribe-first, buffer-during-replay, drain-then-live ────────
      //
      // We subscribe to the live tail BEFORE running the replay query, so
      // that any event emitted between queryEvents returning and the live
      // subscription starting can't be lost in a race. While replay is
      // in progress, live events are queued in `liveBuffer`. After
      // replay writes complete, we drain the buffer (writeBusEvent's
      // seq-dedup drops any event already covered by the replay) and
      // only then flip to direct-write mode.
      //
      // The subscriber callbacks are synchronous with `Subject.next()`,
      // so no yield happens between event emission and buffer append.
      // The drain loop checks the buffer again after each await to
      // catch events emitted during the drain itself; only when the
      // buffer drains to empty do we flip to live mode. JS's single-
      // threaded model guarantees no event slips between the final
      // "buffer empty" check and the mode flip.
      type Queued = { channel: string; payload: unknown; scope: string | undefined; correlationId: string | undefined };
      const liveBuffer: Queued[] = [];
      let mode: 'buffering' | 'live' = 'live';

      const emitOrBuffer = (
        channel: string,
        payload: unknown,
        eventScope: string | undefined,
        correlationId: string | undefined,
      ) => {
        if (mode === 'buffering') {
          if (liveBuffer.length >= MAX_REPLAY_BUFFER_EVENTS) {
            getBusLogger().warn('SSE replay-buffer overflow — disconnecting stalled subscriber', {
              connectionId,
              cap: MAX_REPLAY_BUFFER_EVENTS,
            });
            teardown('replay-buffer-overflow');
            return;
          }
          liveBuffer.push({ channel, payload, scope: eventScope, correlationId });
        } else {
          void writeBusEvent(channel, payload, eventScope, correlationId);
        }
      };

      const willReplay = scoped.some((entry) => entry.lastEventId !== undefined);
      if (willReplay) mode = 'buffering';

      // One client-mode subscription over the whole matrix (SIGNAL-PLANE D2
      // group 2). The driver delivers every frame — it cannot refuse — and
      // ENTITLEMENT stays above the seam: an unscoped frame on a correlated
      // channel passes the ledger's owner gate (`mayDeliver`, ONE copy in
      // signal/ledger.ts since P3) before it costs anything. The whole
      // amplification win: a non-owner returns after one Map lookup — no
      // stringify, no pending-write bytes, no buffer slot.
      planeSub = plane.subscribeClient({
        address: toReplyAddress(clientId),
        global: channels,
        scoped,
        onFrame: (channel, payload, envelope) => {
          if (
            envelope.scope === undefined &&
            isCorrelatedChannel(channel) &&
            !composition.mayDeliver(channel, envelope.meta?.correlationId, clientId, subscriberDid)
          ) {
            return;
          }
          emitOrBuffer(channel, payload, envelope.scope, envelope.meta?.correlationId);
        },
      });

      // ── Replay phase (per scope) ──────────────────────────────────────
      //
      // Each scoped entry carrying a `lastEventId` watermark replays its
      // own gap; entries without one are fresh subscriptions (their caches
      // fetch anyway) and get neither replay nor gap event. Failure modes,
      // per entry — the gap event carries the ENTRY's scope, since that is
      // the scope whose caches need blanket invalidation:
      //   - unparseable watermark (not `p-*` or malformed): scoped
      //     `bus:resume-gap`, continue with live tail only.
      //   - scope mismatch (watermark's embedded scope ≠ entry scope):
      //     same — scoped gap event, no replay.
      //   - event-store query fails: same — scoped gap event, continue live.
      //   - replay succeeds but earliest returned seq > N+1: the gap is
      //     outside the retention window. Replay what we have and emit the
      //     scoped `bus:resume-gap`.
      for (const entry of scoped) {
        if (tornDown) break;
        if (entry.lastEventId === undefined) continue;
        const parsed = parsePersistedId(entry.lastEventId);
        if (!parsed) {
          await emitResumeGap('unparseable-last-event-id', entry.scope, entry.lastEventId);
        } else if (parsed.scope !== entry.scope) {
          await emitResumeGap('scope-mismatch', entry.scope, entry.lastEventId);
        } else {
          try {
            const rId = makeResourceId(entry.scope);
            const allowedTypes = new Set(entry.channels);
            // The record lives in the Archivist (EXTRACT-ARCHIVIST P3):
            // replay reads the D1 sequence-ranged path, this seam's one
            // customer. The +1 is ours — the path is inclusive.
            const events = await fetchArchivistReplay(c.get('config'), c.get('archivistCredential')(), String(rId), parsed.sequence + 1);
            const replayable: StoredEvent[] = events.filter((e) => allowedTypes.has(e.type as string));

            if (events.length > 0 && events[0]!.metadata.sequenceNumber > parsed.sequence + 1) {
              await emitResumeGap('retention-exceeded', entry.scope, entry.lastEventId);
            }

            for (const ev of replayable) {
              // Replayed from the event log: the log stores facts, not routing.
              await writeBusEvent(ev.type as string, ev, entry.scope, undefined);
            }
          } catch (err) {
            getBusLogger().warn('bus resume query failed', {
              scope: entry.scope,
              fromSequence: parsed.sequence + 1,
              error: err instanceof Error ? err.message : String(err),
            });
            await emitResumeGap('query-error', entry.scope, entry.lastEventId);
          }
        }
      }

      // ── Correlated-reply replay (BUS-RESUMPTION Phase 2 / S1) ─────────
      //
      // Each requested cid found in retention is written as a normal frame
      // with its DETERMINISTIC ephemeral id (`e-<channel>:<cid>` — stamped
      // by writeBusEvent from the frame's envelope), so a copy that
      // also arrived live during a connection overlap dedups client-side.
      // Entries are not consumed: a repeat replay is idempotent by id.
      for (const cid of pendingReplies) {
        if (tornDown) break;
        const retained = composition.lookupReply(cid, clientId, subscriberDid);
        if (retained) {
          await writeBusEvent(retained.channel, retained.payload, undefined, retained.correlationId);
        }
      }

      // ── Drain buffer and switch to live mode ─────────────────────────
      while (liveBuffer.length > 0 && !tornDown) {
        const next = liveBuffer.shift()!;
        await writeBusEvent(next.channel, next.payload, next.scope, next.correlationId);
      }
      mode = 'live';

      // Heartbeat loop — runs until the connection dies. The exit
      // condition is what lets this closure (and everything it captures)
      // be collected: an unconditional loop would keep every connection's
      // context alive for the life of the process.
      while (!tornDown && !stream.aborted && !stream.closed) {
        await boundedWrite({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  /**
   * Accepts bus events from clients.
   *
   * Scope rule:
   *
   * - **Commands** (frontend → gateway handler) and **correlation-ID
   *   responses** arrive un-scoped. Handlers subscribe on the global bus.
   * - **Resource-bound broadcasts** (WorkerStateUnit-emitted progress for
   *   resource generation — the `RESOURCE_BROADCAST_TYPES` set) arrive
   *   with `scope: resourceId`. These are published on
   *   `eventBus.scope(resourceId)` so the per-resource SSE subscription
   *   can deliver them only to viewers of that resource.
   *
   * The `scope` parameter is **not** derived from any UI context — it is
   * meaningful only for publishers of resource-bound broadcasts. Frontend
   * commands must never set it.
   */
  busRouter.post('/bus/emit', async (c) => {
    const eventBus = c.get('eventBus');
    const composition = compositionFor(eventBus);
    const plane = composition.plane;
    const body = await c.req.json();
    const { channel, payload, scope, correlationId } = body;
    const emitterClientId = typeof body.clientId === 'string' && body.clientId !== '' ? body.clientId : undefined;

    if (!channel || typeof channel !== 'string') {
      throw new HTTPException(400, { message: 'channel is required' });
    }
    if (!payload || typeof payload !== 'object') {
      throw new HTTPException(400, { message: 'payload must be an object' });
    }
    if (scope !== undefined && (typeof scope !== 'string' || scope === '')) {
      throw new HTTPException(400, { message: 'scope must be a non-empty string' });
    }

    if (!(channel in CHANNEL_SCHEMAS)) {
      throw new HTTPException(400, { message: `Unknown channel: ${channel}` });
    }
    const schemaName = CHANNEL_SCHEMAS[channel as keyof typeof CHANNEL_SCHEMAS];
    if (schemaName) {
      const validate = validators[schemaName as keyof typeof validators];
      // A registry naming a schema the spec does not carry is drift, not a bad
      // request — say so instead of waving the payload through unchecked.
      if (!validate) throw new Error(`No generated validator for schema "${schemaName}" (channel ${channel})`);
      if (!validate(payload)) {
        const errorMessage = formatErrors(validate.errors);
        getBusLogger().warn('Bus emit validation failed', { channel, scope, schemaName, errorMessage });
        throw new HTTPException(400, { message: `Invalid payload for ${channel}: ${errorMessage}` });
      }
    }

    // `_userId` is the verified emitter — the one identity fact the gateway
    // stamps. Who requested the work is derived downstream from the job the
    // write cites, never carried here (VERIFIED-PROVENANCE).
    //
    // `_roles` carries the claimant's capabilities (the token's roles) as a
    // TRANSIENT authz fact — the dispatcher's `job:claim` authorizes by it
    // (EXTRACT-JOBS P0). Gateway-authoritative: CLEARED unconditionally, then
    // set only from the verified principal, so a caller cannot forge a
    // capability by hand-writing the field.
    const principal = c.get('principal');
    delete payload._roles;
    if (principal) {
      payload._userId = principal.did;
      if (principal.roles?.length) payload._roles = principal.roles;
    }

    // ── Emit-as-claim (CORRELATED-REPLY-ROUTING D2) ────────────────────
    //
    // A request emit carrying a fresh correlationId records who owns the
    // reply, BEFORE `subject.next` dispatches it. Ordering is safe by
    // construction: no handler — in-process (subscribed synchronously on this
    // bus) or remote (over SSE) — can publish a reply for a cid that has not
    // dispatched yet.
    //
    // Claims are emit-derived rather than trackReply-derived, so the
    // hand-rolled correlated flows (gather.ts, match.ts mint their own uuid
    // and emit directly) are covered with no SDK change.
    const claimCid = channel in BUS_OPERATIONS ? correlationId : undefined;
    if (claimCid) {
      const clientId = emitterClientId;
      if (clientId === undefined) {
        // Loud, not lenient: a mis-wired client would otherwise burn every
        // busRequest's 30 s timeout with no server-side signal. We control
        // every emitter, so there is no compat path to keep open.
        throw new HTTPException(400, {
          message: `clientId is required to emit ${channel} with a correlationId`,
        });
      }
      const outcome = composition.claim(claimCid, clientId, principal?.did);
      if (outcome === 'conflict') {
        // A live cid claimed twice is a client bug — UUID collision is not a
        // real event — so it is refused rather than silently re-pointed.
        getBusLogger().warn('[bus CLAIM-CONFLICT] correlationId already claimed', { channel, correlationId: claimCid });
        throw new HTTPException(409, { message: `correlationId ${claimCid} is already claimed` });
      }
      if (outcome === 'at-capacity') {
        // Refused HERE, where busRequest's emit-rejection path settles
        // immediately and loudly. Evicting a live claim instead would turn
        // that request's future reply into a silent drop (LIVENESS-AXIOMS L2).
        throw new HTTPException(429, {
          message: `client has ${PENDING_REPLIES_MAX} unanswered requests; retry when one settles`,
        });
      }
    }

    // Tier 2: parent span comes from the W3C traceparent on the request.
    // Subscribers fire synchronously inside Subject.next, so they run
    // under the active bus.dispatch span (and any in-process spans
    // they create become children).
    const traceparent = c.req.header('traceparent');
    const tracestate = c.req.header('tracestate');
    const carrier = traceparent
      ? (tracestate ? { traceparent, tracestate } : { traceparent })
      : undefined;

    // How many observers the target subject had AT DISPATCH. Zero means the
    // signal reached nobody — the failure this route could not previously
    // express.
    //
    // It is EXACT for a broadcast and an UPPER BOUND for a correlated channel:
    // since P3, a subscriber on a reply channel receives the frame only if it
    // owns the correlationId, so observers counts who was eligible to be
    // considered, not who was written to. `/bus/subscribe` enforces no channel allowlist and this
    // handler publishes unconditionally, so a client can emit a channel no
    // participant subscribes to and otherwise get a clean 202 back.
    // `warnIfUnobservedReply` does not cover it: that detector requires a
    // `correlationId`, and fire-and-forget UI signals carry none.
    //
    // Counted on the SCOPED subject when `scope` is set — an unscoped
    // subscriber is not a subscriber to a scoped emit, and counting the
    // global subject would report a healthy fan-out for a signal nobody
    // scoped will receive.
    let subscribers: number | undefined = 0;

    await withTraceparent(carrier, () =>
      withSpan(
        `bus.dispatch:${channel}`,
        () => {
          subscribers = plane.ingest(channel, payload, {
            scope,
            // The envelope the frame travels under, everywhere: `meta` is
            // ferried verbatim by every driver (P0.5), so an in-process
            // handler and one across the broker read the same key.
            meta: correlationId === undefined ? undefined : { correlationId },
          }).observers;

          busLog('EMIT', channel, payload, scope, correlationId);
          recordBusEmit(channel, scope);
          // `clientId` rides the STRUCTURED line, not `busLog`: busLog's
          // signature is @semiont/core's and shared by every emitter, so
          // widening it for a field only the gateway knows would be a core
          // change in a phase that makes none. This is the line an operator
          // greps to tie an emit to the client that made it.
          getBusLogger().info('emit', {
            channel,
            scope,
            subscribers,
            clientId: emitterClientId,
            correlationId,
          });
          if (subscribers === 0) {
            // The caller is told in the response body too; this is for the
            // operator reading logs after the fact, when nobody was watching
            // the exit code of a script.
            getBusLogger().warn('emit reached no subscribers', {
              channel,
              scope,
              hint: 'Nothing on this gateway subscribes to that channel. For a UI signal meant to cross to a participant, check that the channel is in BRIDGED_BROADCASTS and that a client subscribed to it.',
            });

            // ── An unanswerable request fails fast (ARCHIVIST-STAYS-UP P3) ──
            //
            // A request whose handler is absent can never be answered, and
            // `busRequest` has no retry — so the caller's only other outcome is
            // a 30 s timeout. Synthesizing the operation's own mapped failure
            // turns "the app is hung" into "the Archivist is down", in
            // milliseconds, for every cause of absence.
            //
            // Gated on membership in BUS_OPERATIONS, never a name pattern: a
            // BROADCAST reaching nobody is normal (`job:started` with no UI
            // attached is the common case) and must stay silent.
            //
            // Since 536dbed0 narrowed each service to its own inbound roster,
            // zero subscribers on a request channel means the one service that
            // answers it is absent — a far sharper signal than when every
            // client subscribed everything.
            const operation = BUS_OPERATIONS[channel as keyof typeof BUS_OPERATIONS];
            const failureCid = correlationId;
            if (operation?.failure && failureCid) {
              // The request payload is echoed because a failure's own contract
              // is `<the request's identifying fields> & CommandError` —
              // `gather:resource-failed` needs `resourceId`,
              // `match:search-failed` needs `referenceId`. Echoing the request
              // derives those; a per-operation table would restate 36 shapes.
              // `_userId` and `_roles` are dropped: the gateway injected them
              // inbound and neither is part of any reply contract.
              const { _userId: _injected, _roles: _injectedRoles, ...echo } = payload as Record<string, unknown>;
              const failure = {
                ...echo,
                // The machine-readable class, so a caller can BRANCH on this
                // rather than parse the sentence. It is the one failure the
                // gateway synthesizes that is transient by nature — the peer is
                // usually seconds from connecting — and the weaver's boot passes
                // gave up on it for the life of the process because they could
                // not tell it apart from a refusal (2026-09-09: empty graph
                // behind a healthy /health). `busRequest` maps it to
                // `bus.peer-unavailable`; `isPeerUnavailable` is what retries on
                // it.
                code: 'peer-unavailable' as const,
                message: `No subscriber for ${channel}: the service that answers it is not connected`,
              };
              recordUnanswerableRequest(channel);
              getBusLogger().warn('[bus UNANSWERABLE] synthesizing failure for an unsubscribed request', {
                channel,
                failureChannel: operation.failure,
                correlationId: failureCid,
              });
              // Unscoped, like every other reply: retention and the delivery
              // filter both watch the unscoped subject. Through the SAME
              // funnel as every emit (P0.1 q0 (a)): one ingest, no side door.
              plane.ingest(operation.failure, failure, { meta: { correlationId: failureCid } });
            }
          }
        },
        {
          kind: SpanKind.SERVER,
          attrs: {
            'bus.channel': channel,
            ...(scope ? { 'bus.scope': scope } : {}),
          },
        },
      ),
    );

    return c.json({ subscribers }, 202);
  });

  return busRouter;
}
