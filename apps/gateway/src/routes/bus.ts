import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';
import type { EventBus, components } from '@semiont/core';
import { BUS_OPERATIONS, CHANNEL_SCHEMAS, busLog, resourceId as makeResourceId } from '@semiont/core';
import {
  SpanKind,
  getActiveTraceparent,
  injectTraceparent,
  recordBusEmit,
  recordResumeGap,
  recordUnanswerableRequest,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  withSpan,
  withTraceparent,
  type TraceCarrier,
} from '@semiont/observability';
import { getLogger } from '../logger';
import type { Principal } from '../identity/principal';
import {
  SCOPE_WARN_THRESHOLD,
  SignalPlaneUnavailable,
  compositionFor,
  isCorrelatedChannel,
  toReplyAddress,
  type PlaneSubscription,
} from '../signal';
import { replayEvents } from '../lib/archivist';
import { formatErrors, itemLimits, operationLimits, validators } from '@semiont/core/openapi';
import { validBody } from './valid-body';
import type { HttpBindings } from '@hono/node-server';
import { profileForWrite } from '../identity/person-profile';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;

const getBusLogger = () => getLogger().child({ component: 'bus' });

type BusEmitAccepted = components['schemas']['BusEmitAccepted'];
type BusSubscribeRequest = components['schemas']['BusSubscribeRequest'];
type BusResumeGap = components['schemas']['BusResumeGap'];

/**
 * The trace a frame was published under, as its envelope carries it. The
 * frame is written to a connection later and elsewhere — after a broker hop,
 * or out of the replay buffer — so the context rides the envelope rather than
 * the call stack, and every plane delivers `_trace` alike.
 */
function envelopeMeta(correlationId: string | undefined): Record<string, string> | undefined {
  const meta: Record<string, string> = { ...getActiveTraceparent() };
  if (correlationId !== undefined) meta['correlationId'] = correlationId;
  // Absent rather than empty, so every plane presents the same envelope.
  return Object.keys(meta).length === 0 ? undefined : meta;
}

function traceOf(meta: Readonly<Record<string, string>> | undefined): TraceCarrier | undefined {
  const traceparent = meta?.['traceparent'];
  if (!traceparent) return undefined;
  const tracestate = meta?.['tracestate'];
  return tracestate ? { traceparent, tracestate } : { traceparent };
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
type ScopedSubscription = NonNullable<BusSubscribeRequest['scoped']>[number];

/**
 * The stream's bounds, as the spec states them.
 *
 * `pendingWriteBytes` is outbound flow control, per SSE connection.
 * `writeSSE` resolves only when the connection's consumer accepts the chunk,
 * so the bytes held by unresolved writes measure exactly what this subscriber
 * forces the gateway to buffer. A half-open socket — a client container torn
 * down without a FIN — never errors and never closes, so without a bound its
 * bus subscriptions accumulate every fan-out payload as a pending write until
 * the heap bursts (gateway OOM, 2026-09-03: ~8 such subscribers each holding
 * the full `browse:*-result` stream). Past the bound the subscriber is
 * disconnected: a live client reconnects with Last-Event-ID /
 * `pendingReplies` and resumes; a dead one stops costing memory.
 *
 * `replayBufferEvents` is the same protection for the buffer-during-replay
 * window: a connection that stalls mid-replay must not queue live fan-out
 * without limit either.
 */
const subscribeLimits = operationLimits['POST /bus/subscribe'];

// ── The seam (SIGNAL-PLANE P0) ─────────────────────────────────────────
//
// Ingest and fan-out go through the `SignalPlane` driver (../signal — the
// in-process one here; P1 adds NATS behind the same conformance suite). The
// correlation LEDGER — claims, entitlement and its refusals, retention —
// is gateway POLICY and lives in ../signal/ledger, above the seam. The
// matrix caps and the ledger budgets are the seam's construction options
// (../signal/options — D8's seven, today's values as defaults).

/**
 * The subscription matrix: the spec's schema (BusSubscribeRequest), then the
 * two rules it cannot state — something is subscribed, and no scope is named
 * twice. Every refusal is a 400.
 */
async function subscription(c: Context): Promise<{ global: string[]; scoped: ScopedSubscription[]; pendingReplies: string[]; clientId: string }> {
  const body = await validBody(c, validators.BusSubscribeRequest);
  const global = body.global ?? [];
  const scoped = body.scoped ?? [];
  if (global.length === 0 && scoped.length === 0) {
    throw new HTTPException(400, { message: 'At least one global channel or scoped entry is required' });
  }
  const seen = new Set<string>();
  for (const { scope } of scoped) {
    if (seen.has(scope)) throw new HTTPException(400, { message: `duplicate scope "${scope}" in matrix` });
    seen.add(scope);
  }
  return { global, scoped, pendingReplies: body.pendingReplies ?? [], clientId: body.clientId };
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
  const busRouter = new Hono<{ Variables: { principal: Principal; eventBus: EventBus } }>();

  busRouter.use('/bus/*', authMiddleware);

  busRouter.post('/bus/subscribe', async (c) => {
    const { global: channels, scoped, pendingReplies, clientId } = await subscription(c);
    const eventBus = c.get('eventBus');
    // Read OUTSIDE the stream callback: `c` is the request context, and the
    // presence pair below must name the principal on this connection.
    const subscriberDid = c.get('principal')?.did;

    const composition = compositionFor(eventBus);
    const plane = composition.plane;

    if (scoped.length >= SCOPE_WARN_THRESHOLD) {
      getBusLogger().warn('large scope matrix', { scopeCount: scoped.length });
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
      // A stream outlives a broker outage; its presence frames do not.
      const announce = (channel: 'session:joined' | 'session:left') => {
        try {
          plane.ingest(channel, presence);
        } catch (error) {
          if (!(error instanceof SignalPlaneUnavailable)) throw error;
          getBusLogger().warn('[bus PRESENCE-DROPPED] the signal plane could not carry a presence frame', { channel, connectionId });
        }
      };
      recordSubscriberConnect();
      announce('session:joined');

      // ── Connection teardown ───────────────────────────────────────────
      //
      // One idempotent teardown, whichever detector notices the death
      // first: the stream abort (socket closed and the adapter cancelled
      // our readable), the request signal (socket closed but the readable
      // cancel path did not run), or the pending-write bound in
      // `boundedWrite` (the socket never closed at all).
      let planeSub: PlaneSubscription | undefined;
      const gate = composition.gate(clientId, subscriberDid);
      let pendingBytes = 0;
      let tornDown = false;
      const { outgoing } = (c.env ?? {}) as Partial<HttpBindings>;
      const teardown = (reason: string) => {
        if (tornDown) return;
        tornDown = true;
        planeSub?.close();
        gate.close();
        recordSubscriberDisconnect();
        announce('session:left');
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
       * its serialized frame. Past subscribeLimits.pendingWriteBytes the subscriber
       * is disconnected.
       */
      const boundedWrite = async (frame: { event: string; data: string; id?: string }): Promise<void> => {
        if (tornDown) return;
        const cost = frame.data.length;
        pendingBytes += cost;
        if (pendingBytes > subscribeLimits.pendingWriteBytes) {
          getBusLogger().warn('SSE pending-write overflow — disconnecting dead or stalled subscriber', {
            connectionId,
            pendingBytes,
            cap: subscribeLimits.pendingWriteBytes,
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
        trace: TraceCarrier | undefined,
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
        await withTraceparent(trace, async () => {
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
        });
      };

      const emitResumeGap = async (reason: BusResumeGap['reason'], gapScope?: string, lastSeenId?: string) => {
        // Counted at the ONE funnel every gap path goes through. `reason` is
        // the spec's closed set, so the label stays low-cardinality.
        recordResumeGap(reason);
        const payload: BusResumeGap = { reason };
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
      type Queued = { channel: string; payload: unknown; scope: string | undefined; correlationId: string | undefined; trace: TraceCarrier | undefined };
      const liveBuffer: Queued[] = [];
      let mode: 'buffering' | 'live' = 'live';

      const emitOrBuffer = (
        channel: string,
        payload: unknown,
        eventScope: string | undefined,
        correlationId: string | undefined,
        trace: TraceCarrier | undefined,
      ) => {
        if (mode === 'buffering') {
          if (liveBuffer.length >= subscribeLimits.replayBufferEvents) {
            getBusLogger().warn('SSE replay-buffer overflow — disconnecting stalled subscriber', {
              connectionId,
              cap: subscribeLimits.replayBufferEvents,
            });
            teardown('replay-buffer-overflow');
            return;
          }
          liveBuffer.push({ channel, payload, scope: eventScope, correlationId, trace });
        } else {
          void writeBusEvent(channel, payload, eventScope, correlationId, trace);
        }
      };

      const willReplay = scoped.some((entry) => entry.lastEventId !== undefined);
      if (willReplay) mode = 'buffering';

      // One client-mode subscription over the whole matrix (SIGNAL-PLANE D2
      // group 2). The driver delivers every frame — it cannot refuse — and
      // ENTITLEMENT stays above the seam: an unscoped frame on a correlated
      // channel passes this subscriber's gate (ONE copy, in signal/ledger.ts)
      // before it costs anything. The whole amplification win: a non-owner
      // returns after one Map lookup — no stringify, no pending-write bytes,
      // no buffer slot. A cid this replica does not hold yet is read from the
      // claims table first, not refused.
      planeSub = plane.subscribeClient({
        address: toReplyAddress(clientId),
        global: channels,
        scoped,
        onFrame: (channel, payload, envelope) => {
          const correlationId = envelope.meta?.correlationId;
          const trace = traceOf(envelope.meta);
          if (envelope.scope === undefined && isCorrelatedChannel(channel)) {
            gate.offer(channel, correlationId, () => emitOrBuffer(channel, payload, undefined, correlationId, trace));
            return;
          }
          emitOrBuffer(channel, payload, envelope.scope, correlationId, trace);
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
            const events = await replayEvents(c.get('archivist'), String(rId), parsed.sequence + 1);
            const replayable = events.filter((e) => allowedTypes.has(e.type));

            if (events.length > 0 && events[0]!.metadata.sequenceNumber > parsed.sequence + 1) {
              await emitResumeGap('retention-exceeded', entry.scope, entry.lastEventId);
            }

            for (const ev of replayable) {
              // Replayed from the event log: the log stores facts, not routing.
              await writeBusEvent(ev.type, ev, entry.scope, undefined, undefined);
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
        const retained = await composition.lookupReply(cid, clientId, subscriberDid);
        if (retained) {
          await writeBusEvent(retained.channel, retained.payload, undefined, retained.correlationId, undefined);
        }
      }

      // ── Drain buffer and switch to live mode ─────────────────────────
      while (liveBuffer.length > 0 && !tornDown) {
        const next = liveBuffer.shift()!;
        await writeBusEvent(next.channel, next.payload, next.scope, next.correlationId, next.trace);
      }
      mode = 'live';

      // Heartbeat loop — runs until the connection dies. The exit
      // condition is what lets this closure (and everything it captures)
      // be collected: an unconditional loop would keep every connection's
      // context alive for the life of the process.
      while (!tornDown && !stream.aborted && !stream.closed) {
        await boundedWrite({ event: 'ping', data: '' });
        await stream.sleep(subscribeLimits.heartbeatSeconds * 1000);
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
    const { channel, payload, scope, correlationId, clientId } = await validBody(c, validators.BusEmitRequest);
    // An empty clientId is no clientId (BusEmitRequest).
    const emitterClientId = clientId === '' ? undefined : clientId;

    if (!(channel in CHANNEL_SCHEMAS)) {
      throw new HTTPException(400, { message: `Unknown channel: ${channel}` });
    }
    const schemaName = CHANNEL_SCHEMAS[channel as keyof typeof CHANNEL_SCHEMAS];
    if (schemaName) {
      const validate = validators[schemaName as keyof typeof validators];
      // A registry naming a schema the spec does not carry is drift, not a bad
      // request — say so instead of waving the payload through unchecked.
      if (!validate) throw new Error(`No generated validator for schema "${schemaName}" (channel ${channel})`);
      // Checked through its own name: the guard would narrow `payload` to the
      // union of every schema, and the stamping below writes to it as a record.
      const candidate: unknown = payload;
      if (!validate(candidate)) {
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
    // Refused before anything is recorded: a claim made now would stand for a
    // request the plane cannot carry.
    if (!plane.available()) throw new SignalPlaneUnavailable();

    const principal = c.get('principal');
    delete payload._roles;
    if (principal) {
      payload._userId = principal.did;
      if (principal.roles?.length) payload._roles = principal.roles;
      // A person WRITING is when the record learns what they are called
      // (PERSON-PROFILE D3). Gated on the channel, not on the stamp: every
      // emit carries a `_userId`, `browse:*` requests included, so stamping
      // is not the test for an act. The name rides its own system event,
      // never this payload.
      profileForWrite(channel, principal, (ch, p) => plane.ingest(ch, p));
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
      const outcome = await composition.claim(claimCid, clientId, principal?.did);
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
          message: `client has ${itemLimits['BusSubscribeRequest.pendingReplies']} unanswered requests; retry when one settles`,
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
    // signal reached nobody, which is the failure this count exists to express.
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
    //
    // Undefined when the plane cannot count: a broker driver reports nothing
    // rather than a zero it never observed (IngestReceipt), so neither the
    // warning nor the fast-fail below fires, and the body carries no count.
    const observers = await withTraceparent(carrier, () =>
      withSpan(
        `bus.dispatch:${channel}`,
        () => {
          const subscribers = plane.ingest(channel, payload, {
            scope,
            // The envelope the frame travels under, everywhere: `meta` is
            // ferried verbatim by every driver (P0.5), so an in-process
            // handler and one across the broker read the same keys — the
            // correlation key, and the trace this dispatch runs under.
            meta: envelopeMeta(correlationId),
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
              plane.ingest(operation.failure, failure, { meta: envelopeMeta(failureCid) });
            }
          }
          return subscribers;
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

    const accepted: BusEmitAccepted = observers === undefined ? {} : { subscribers: observers };
    return c.json(accepted, 202);
  });

  return busRouter;
}
