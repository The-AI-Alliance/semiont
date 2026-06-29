import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import type { EventBus, EventMap, StoredEvent } from '@semiont/core';
import { CHANNEL_SCHEMAS, busLog, resourceId as makeResourceId } from '@semiont/core';
import {
  SpanKind,
  injectTraceparent,
  recordBusEmit,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  withSpan,
  withTraceparent,
} from '@semiont/observability';
import { validateSchema } from '../utils/openapi-validator';
import { getLogger } from '../logger';
import type { startMakeMeaning } from '@semiont/make-meaning';

type AuthMiddleware = (c: Context, next: Next) => Promise<Response | void>;
type MakeMeaning = Awaited<ReturnType<typeof startMakeMeaning>>;

const getBusLogger = () => getLogger().child({ component: 'bus' });

/**
 * SSE event id stamping.
 *
 * - Persisted domain events (the set named in `PERSISTED_EVENT_TYPES` and
 *   delivered on the scoped bus via `eventBus.scope(rId)`) get an id of
 *   the form `p-<scope>-<sequenceNumber>`. These ids are resumable — a
 *   client sending `Last-Event-ID: p-<scope>-<N>` on reconnect receives
 *   replay of events with sequenceNumber > N in that scope before
 *   joining the live tail.
 *
 * - All other events — command responses, progress, ephemeral signals —
 *   get an id of the form `e-<connectionId>-<counter>`. These ids are
 *   unique per connection but carry no replay meaning; if the client
 *   sends one of them on reconnect, the server replies with a synthetic
 *   `bus:resume-gap` so the client falls back to cache invalidation.
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

export function createBusRouter(authMiddleware: AuthMiddleware) {
  const busRouter = new Hono<{ Variables: { user: User; principalDid: string; eventBus: EventBus; makeMeaning: MakeMeaning } }>();

  busRouter.use('/bus/*', authMiddleware);

  busRouter.get('/bus/subscribe', (c) => {
    const channels = c.req.queries('channel') ?? [];
    const scopedChannels = c.req.queries('scoped') ?? [];
    const scope = c.req.query('scope');
    const eventBus = c.get('eventBus');
    const makeMeaning = c.get('makeMeaning');
    const lastEventId = c.req.header('Last-Event-ID');

    if (channels.length === 0 && scopedChannels.length === 0) {
      throw new HTTPException(400, { message: 'At least one channel or scoped parameter is required' });
    }

    return streamSSE(c, async (stream) => {
      // Ephemeral id generator for this connection.
      const connectionId = crypto.randomUUID();
      let ephemeralCounter = 0;
      const nextEphemeralId = () => makeEphemeralId(connectionId, ++ephemeralCounter);

      // Per-connection record of exactly which channels this subscriber asked
      // for. Makes a missing fan-in wiring greppable: if a reply channel is
      // absent from `channels` here, the backend will never forward it to this
      // client and any `busRequest` on it times out at 30 s with no error.
      // (Pairs with the emit-side `[bus DROP]` warn; that fires when nothing
      // subscribes at all, this shows what a given client *did* subscribe to.)
      // See .plans/bugs/gather-resource-complete-not-bridged.md.
      getBusLogger().info('SSE subscribe', {
        connectionId,
        channels,
        scopedChannels,
        ...(scope ? { scope } : {}),
        ...(lastEventId ? { lastEventId } : {}),
      });

      // Tier 3: track active SSE subscribers via UpDownCounter. Connect
      // increments; disconnect (stream.onAbort) decrements. The gauge
      // reflects current concurrent SSE connections per service instance.
      recordSubscriberConnect();
      stream.onAbort(() => {
        recordSubscriberDisconnect();
        getBusLogger().info('SSE disconnect', { connectionId });
      });

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
          const cid = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
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
        // For request/reply *replies* (payloads carrying a correlationId) we
        // also open a short `sse.deliver:<channel>` span: the trace then shows
        // the reply actually leaving the backend for this client — the
        // delivered-counterpart to the emit-side `[bus DROP]` warn, so a
        // delivered-to-wrong-cid or never-delivered reply is visible in one
        // trace instead of cross-referenced by hand. `injectTraceparent` runs
        // *inside* the span so the client's recv stitches under the deliver,
        // not its parent. Non-reply broadcasts skip the span — they're
        // high-volume and have no single awaiting client.
        const cid = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
        const doWrite = async (): Promise<void> => {
          if (payload && typeof payload === 'object') {
            injectTraceparent(payload as Record<string, unknown>);
          }
          const data = eventScope
            ? JSON.stringify({ channel, payload, scope: eventScope })
            : JSON.stringify({ channel, payload });
          busLog('SSE', channel, payload, eventScope);
          await stream.writeSSE({ event: 'bus-event', data, id }).catch(() => {});
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

      const emitResumeGap = async (reason: string, gapScope?: string) => {
        const payload: { scope?: string; lastSeenId?: string; reason: string } = { reason };
        if (gapScope !== undefined) payload.scope = gapScope;
        if (lastEventId !== undefined) payload.lastSeenId = lastEventId;
        await stream.writeSSE({
          event: 'bus-event',
          data: JSON.stringify({ channel: 'bus:resume-gap', payload }),
          id: nextEphemeralId(),
        }).catch(() => {});
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
      type Queued = { channel: string; payload: unknown; scope: string | undefined };
      const liveBuffer: Queued[] = [];
      let mode: 'buffering' | 'live' = 'live';

      const emitOrBuffer = (channel: string, payload: unknown, eventScope: string | undefined) => {
        if (mode === 'buffering') {
          liveBuffer.push({ channel, payload, scope: eventScope });
        } else {
          void writeBusEvent(channel, payload, eventScope);
        }
      };

      const willReplay = Boolean(
        lastEventId && parsePersistedId(lastEventId) && scope && scopedChannels.length > 0,
      );
      if (willReplay) mode = 'buffering';

      const subs = channels.map((channel) =>
        eventBus.get(channel as keyof EventMap).subscribe((payload) => {
          emitOrBuffer(channel, payload, undefined);
        }),
      );
      if (scope && scopedChannels.length > 0) {
        const scopedBus = eventBus.scope(scope);
        for (const channel of scopedChannels) {
          subs.push(
            scopedBus.get(channel as keyof EventMap).subscribe((payload) => {
              emitOrBuffer(channel, payload, scope);
            }),
          );
        }
      }
      stream.onAbort(() => subs.forEach((s) => s.unsubscribe()));

      // ── Replay phase ──────────────────────────────────────────────────
      //
      // Failure modes:
      //   - unparseable Last-Event-ID (not `p-*` or malformed): emit
      //     `bus:resume-gap` and continue with live tail only.
      //   - scope mismatch (Last-Event-ID scope ≠ subscription scope):
      //     same — gap event, no replay.
      //   - event-store query fails: same — gap event, continue live.
      //   - replay succeeds but earliest returned seq > N+1: the gap is
      //     outside the retention window. Replay what we have and emit
      //     `bus:resume-gap`.
      if (lastEventId) {
        const parsed = parsePersistedId(lastEventId);
        if (!parsed) {
          if (!lastEventId.startsWith(EPHEMERAL_ID_PREFIX)) {
            await emitResumeGap('unparseable-last-event-id');
          }
          // else: ephemeral id — no replay meaning; continue without gap event
        } else if (!scope || parsed.scope !== scope || scopedChannels.length === 0) {
          await emitResumeGap('scope-mismatch', parsed.scope);
        } else {
          try {
            const rId = makeResourceId(scope);
            const allowedTypes = new Set(scopedChannels);
            const events = await makeMeaning.knowledgeSystem.kb.eventStore.log.queryEvents(rId, {
              fromSequence: parsed.sequence + 1,
            });
            const replayable: StoredEvent[] = events.filter((e) => allowedTypes.has(e.type as string));

            if (events.length > 0 && events[0]!.metadata.sequenceNumber > parsed.sequence + 1) {
              await emitResumeGap('retention-exceeded', scope);
            }

            for (const ev of replayable) {
              await writeBusEvent(ev.type as string, ev, scope);
            }
          } catch (err) {
            getBusLogger().warn('bus resume query failed', {
              scope,
              fromSequence: parsed.sequence + 1,
              error: err instanceof Error ? err.message : String(err),
            });
            await emitResumeGap('query-error', scope);
          }
        }
      }

      // ── Drain buffer and switch to live mode ─────────────────────────
      while (liveBuffer.length > 0) {
        const next = liveBuffer.shift()!;
        await writeBusEvent(next.channel, next.payload, next.scope);
      }
      mode = 'live';

      // Heartbeat loop — runs for the lifetime of the connection.
      while (true) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
    });
  });

  /**
   * Accepts bus events from clients.
   *
   * Scope rule:
   *
   * - **Commands** (frontend → backend handler) and **correlation-ID
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
    const body = await c.req.json();
    const { channel, payload, scope } = body;

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
      const { valid, errorMessage } = validateSchema(schemaName, payload);
      if (!valid) {
        getBusLogger().warn('Bus emit validation failed', { channel, scope, schemaName, errorMessage });
        throw new HTTPException(400, { message: `Invalid payload for ${channel}: ${errorMessage}` });
      }
    }

    const principalDid = c.get('principalDid') as string | undefined;
    if (principalDid) {
      payload._userId = principalDid;
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

    await withTraceparent(carrier, () =>
      withSpan(
        `bus.dispatch:${channel}`,
        () => {
          const bus = scope ? eventBus.scope(scope) : eventBus;
          const subject = bus.get(channel as keyof EventMap);
          subject.next(payload as never);

          busLog('EMIT', channel, payload, scope);
          recordBusEmit(channel, scope);
          getBusLogger().info('emit', { channel, scope, correlationId: (payload as Record<string, unknown>).correlationId });
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

    return c.json(null, 202);
  });

  return busRouter;
}
