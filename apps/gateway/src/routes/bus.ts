import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@prisma/client';
import type { Context, Next } from 'hono';
import type { EventBus, EventMap, StoredEvent, EnvironmentConfig } from '@semiont/core';
import { BUS_OPERATIONS, CHANNEL_SCHEMAS, busLog, replyChannelsFor, resourceId as makeResourceId } from '@semiont/core';
import type { Subscription } from 'rxjs';
import {
  SpanKind,
  injectTraceparent,
  recordBusEmit,
  recordSubscriberConnect,
  recordSubscriberDisconnect,
  withSpan,
  withTraceparent,
} from '@semiont/observability';
import { getLogger } from '../logger';
import { archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';
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
  resourceId: string,
  fromSequence: number,
): Promise<StoredEvent[]> {
  const { base, headers } = archivistEndpoint(config);
  const res = await fetch(
    `${base}/events/${encodeURIComponent(resourceId)}?fromSequence=${fromSequence}`,
    { headers },
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
 * Per-connection scope cap (MULTI-RESOURCE-SCOPE, open question 6). The
 * named consumer's normal working set is 40–60 scopes (one per chat
 * message), so the cap is a runaway guard, not a budget — provisional
 * pending the subscription-explosion benchmark (plan risk 5).
 */
const MAX_SCOPES = 512;
const SCOPE_WARN_THRESHOLD = 128;

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

// ── The correlation registry (CORRELATED-REPLY-ROUTING P3; absorbs the
//    reply retention of BUS-RESUMPTION.md Phase 2 / SDK-DEBT S1) ──────────
//
// Claims and retention answer the same question — *who may see the reply for
// this correlationId* — so they are one module rather than two (D4).

/**
 * Every correlated channel: result, failure and progress of every registered
 * operation. Derived with the SHARED helper — `replyChannelsFor` is the one
 * home for this derivation (`packages/core/src/bus-request.ts`), already used
 * by the worker's `WORKER_CHANNELS` and all four make-meaning service rosters.
 * A hand-rolled union here would be the fifth restatement of it, and its own
 * docstring names that as the recurring unbridged-reply bug class.
 */
const CORRELATED_CHANNELS = new Set<string>(replyChannelsFor(Object.keys(BUS_OPERATIONS)));

/**
 * The progress subset of the above. A partition of one derived set, not a
 * restatement of it: progress frames refresh a claim's TTL (a streaming op
 * that is still reporting cannot expire mid-flight) but are never retained —
 * they are a stream, not an answer.
 */
const PROGRESS_CHANNELS = new Set<string>(
  Object.values(BUS_OPERATIONS).flatMap((op) =>
    'progress' in op && op.progress ? [op.progress as string] : [],
  ),
);

/** Retained reply payloads: older than the caller's 30 s deadline is useless — 2× headroom. */
export const REPLY_RETENTION_TTL_MS = 60_000;
export const REPLY_RETENTION_MAX = 1024;
/** Per-client claim capacity, and the cap on a subscribe body's `pendingReplies`. */
export const PENDING_REPLIES_MAX = 256;
/**
 * Claims are cheap (two strings and a timestamp) and long-lived; reply
 * payloads are expensive and short-lived. Deliberately different budgets.
 */
export const CLAIM_TTL_MS = 15 * 60_000;
export const CLAIM_MAX_GLOBAL = 4096;

interface RetainedReply {
  channel: string;
  payload: unknown;
  retainedAt: number;
}

interface Claim {
  clientId: string;
  principalDid: string | undefined;
  claimedAt: number;
  reply?: RetainedReply;
}

const correlationIdOf = (payload: unknown): string | undefined => {
  const cid = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined;
};

/**
 * The correlation registry: one home for "who may see the reply for this cid".
 *
 * `claim` records ownership at the request emit, BEFORE the payload dispatches
 * — no handler, in-process or remote, can publish a reply for a cid that is not
 * yet claimed. `owner` backs the delivery filter; `lookupReply` backs the
 * `pendingReplies` reconnect probe, gated by the same ownership.
 *
 * Retention keeps only CLAIMED cids, with the old bounds (60 s TTL, FIFO cap,
 * eager sweep at insert — lookup-only expiry once pinned hundreds of MB of
 * reply payloads for nobody). Claims carry their own, longer budget.
 *
 * Exposure: replies were global fan-out when this buffer was written, so
 * retention "added no exposure" and the probe was ungated. Routing ends that,
 * and an ungated probe would become the one remaining way to fish for another
 * user's replies — hence the owner check in `lookupReply`.
 */
export function createCorrelationRegistry(
  eventBus: EventBus,
  opts: { ttlMs?: number; max?: number; claimTtlMs?: number; now?: () => number } = {},
): {
  claim(cid: string, clientId: string, principalDid: string | undefined): 'ok' | 'conflict' | 'at-capacity';
  owner(cid: string): { clientId: string; principalDid: string | undefined } | undefined;
  lookupReply(cid: string, clientId: string, principalDid: string | undefined): RetainedReply | undefined;
  size(): number;
  dispose(): void;
} {
  const ttlMs = opts.ttlMs ?? REPLY_RETENTION_TTL_MS;
  const max = opts.max ?? REPLY_RETENTION_MAX;
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const now = opts.now ?? Date.now;

  /** Insertion-ordered: expired is always a prefix, so sweeping is a walk. */
  const claims = new Map<string, Claim>();
  const perClient = new Map<string, number>();

  const forget = (cid: string) => {
    const claim = claims.get(cid);
    if (!claim) return;
    claims.delete(cid);
    const n = (perClient.get(claim.clientId) ?? 1) - 1;
    if (n <= 0) perClient.delete(claim.clientId);
    else perClient.set(claim.clientId, n);
  };

  /**
   * Sweep expired claims. A claim that never saw a retained reply is the
   * moment a lossy mode begins — its future reply becomes undeliverable — so
   * it is breadcrumbed (L4: no silent lossy mode). One that already delivered
   * is ordinary cleanup and stays quiet.
   */
  const sweepClaims = () => {
    const cutoff = now() - claimTtlMs;
    for (const [cid, claim] of claims) {
      if (claim.claimedAt > cutoff) break;
      if (!claim.reply) {
        getBusLogger().warn('[bus CLAIM-EXPIRED] claim swept with no reply', {
          correlationId: cid,
          clientId: claim.clientId,
          ageMs: now() - claim.claimedAt,
        });
      }
      forget(cid);
    }
  };

  /** Retained reply payloads expire on their own, far shorter, budget. */
  const sweepReplies = () => {
    const cutoff = now() - ttlMs;
    let retained = 0;
    for (const claim of claims.values()) {
      if (!claim.reply) continue;
      if (claim.reply.retainedAt <= cutoff) delete claim.reply;
      else retained++;
    }
    if (retained <= max) return;
    // FIFO over insertion order: drop the oldest payloads, keeping the claims
    // themselves — a claim without its payload still routes a live reply.
    let excess = retained - max;
    for (const claim of claims.values()) {
      if (excess === 0) break;
      if (claim.reply) {
        delete claim.reply;
        excess--;
      }
    }
  };

  const subs: Subscription[] = [...CORRELATED_CHANNELS].map((channel) =>
    eventBus.get(channel as keyof EventMap).subscribe((payload) => {
      const cid = correlationIdOf(payload);
      if (!cid) return;
      const claim = claims.get(cid);
      if (!claim) return; // never claimed: in-process requester, nothing to retain
      // Any activity on the cid refreshes the claim, so a streaming op that is
      // still reporting progress cannot expire mid-flight.
      claim.claimedAt = now();
      if (PROGRESS_CHANNELS.has(channel)) return; // refresh only; a stream is not an answer
      claim.reply = { channel, payload, retainedAt: now() };
      sweepClaims();
      sweepReplies();
    }),
  );

  return {
    claim(cid, clientId, principalDid) {
      sweepClaims();
      const existing = claims.get(cid);
      if (existing) return 'conflict';
      if ((perClient.get(clientId) ?? 0) >= PENDING_REPLIES_MAX) return 'at-capacity';
      if (claims.size >= CLAIM_MAX_GLOBAL) {
        // A backstop correct clients cannot reach. Oldest-first, breadcrumbed
        // per entry — never silent (L4).
        const oldest = claims.keys().next().value;
        if (oldest !== undefined) {
          getBusLogger().warn('[bus CLAIM-EVICTED] global claim cap reached', {
            correlationId: oldest,
            cap: CLAIM_MAX_GLOBAL,
          });
          forget(oldest);
        }
      }
      claims.set(cid, { clientId, principalDid, claimedAt: now() });
      perClient.set(clientId, (perClient.get(clientId) ?? 0) + 1);
      return 'ok';
    },
    owner(cid) {
      const claim = claims.get(cid);
      if (!claim) return undefined;
      if (now() - claim.claimedAt > claimTtlMs) return undefined;
      return { clientId: claim.clientId, principalDid: claim.principalDid };
    },
    lookupReply(cid, clientId, principalDid) {
      const claim = claims.get(cid);
      if (!claim?.reply) return undefined;
      if (claim.clientId !== clientId || claim.principalDid !== principalDid) return undefined;
      if (now() - claim.reply.retainedAt > ttlMs) {
        delete claim.reply;
        return undefined;
      }
      return claim.reply;
    },
    size() {
      return claims.size;
    },
    dispose() {
      for (const sub of subs) sub.unsubscribe();
      claims.clear();
      perClient.clear();
    },
  };
}

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

export function createBusRouter(authMiddleware: AuthMiddleware) {
  const busRouter = new Hono<{ Variables: { user: User; principalDid: string; eventBus: EventBus; config: EnvironmentConfig } }>();

  busRouter.use('/bus/*', authMiddleware);

  // One retention buffer per EventBus instance, wired on that bus's first
  // subscribe. Lazy-on-first-subscribe is not a coverage hole: the attach
  // gate guarantees a client holds an open connection before any busRequest
  // emit, so a reply can only exist after some subscribe has run.
  const registryByBus = new WeakMap<EventBus, ReturnType<typeof createCorrelationRegistry>>();

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
    const subscriberDid = c.get('principalDid') as string | undefined;

    let registry = registryByBus.get(eventBus);
    if (!registry) {
      registry = createCorrelationRegistry(eventBus);
      registryByBus.set(eventBus, registry);
    }
    const correlations = registry;

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
      eventBus.get('session:joined').next(presence);

      // ── Connection teardown ───────────────────────────────────────────
      //
      // One idempotent teardown, whichever detector notices the death
      // first: the stream abort (socket closed and the adapter cancelled
      // our readable), the request signal (socket closed but the readable
      // cancel path did not run), or the pending-write bound in
      // `boundedWrite` (the socket never closed at all).
      const subs: Subscription[] = [];
      let pendingBytes = 0;
      let tornDown = false;
      const { outgoing } = (c.env ?? {}) as Partial<HttpBindings>;
      const teardown = (reason: string) => {
        if (tornDown) return;
        tornDown = true;
        for (const s of subs) s.unsubscribe();
        recordSubscriberDisconnect();
        eventBus.get('session:left').next(presence);
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
        // the reply actually leaving the gateway for this client — the
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
      type Queued = { channel: string; payload: unknown; scope: string | undefined };
      const liveBuffer: Queued[] = [];
      let mode: 'buffering' | 'live' = 'live';

      const emitOrBuffer = (channel: string, payload: unknown, eventScope: string | undefined) => {
        if (mode === 'buffering') {
          if (liveBuffer.length >= MAX_REPLAY_BUFFER_EVENTS) {
            getBusLogger().warn('SSE replay-buffer overflow — disconnecting stalled subscriber', {
              connectionId,
              cap: MAX_REPLAY_BUFFER_EVENTS,
            });
            teardown('replay-buffer-overflow');
            return;
          }
          liveBuffer.push({ channel, payload, scope: eventScope });
        } else {
          void writeBusEvent(channel, payload, eventScope);
        }
      };

      /**
       * Ownership check for a frame on a correlated channel.
       *
       * Three negatives, deliberately distinguished:
       *  - a result/failure with NO correlationId violates REPLY-SHAPE-STANDARD
       *    → drop and warn (loud absence; never a manufactured broadcast);
       *  - a NEVER-CLAIMED cid → drop silently. This is the structural
       *    in-process case (`ResourceOperations` runs busRequest on the
       *    gateway's own bus and consumes the reply in-process), not a lossy
       *    mode — a warn here would fire on every in-process operation;
       *  - a cid owned by someone else → drop silently. That is the routing
       *    working.
       * The genuinely lossy case, claimed-then-expired, is breadcrumbed at
       * sweep time instead, which needs no tombstone here.
       */
      const mayDeliver = (channel: string, payload: unknown): boolean => {
        const cid = correlationIdOf(payload);
        if (!cid) {
          if (!PROGRESS_CHANNELS.has(channel)) {
            getBusLogger().warn('[bus REPLY-NO-CID] correlated frame without a correlationId', { channel });
          }
          return false;
        }
        const owner = correlations.owner(cid);
        if (!owner) return false;
        return owner.clientId === clientId && owner.principalDid === subscriberDid;
      };

      const willReplay = scoped.some((entry) => entry.lastEventId !== undefined);
      if (willReplay) mode = 'buffering';

      for (const channel of channels) {
        const correlated = CORRELATED_CHANNELS.has(channel);
        subs.push(
          eventBus.get(channel as keyof EventMap).subscribe((payload) => {
            // The whole amplification win: a non-owner returns after one Map
            // lookup — no stringify, no pending-write bytes, no buffer slot.
            if (correlated && !mayDeliver(channel, payload)) return;
            emitOrBuffer(channel, payload, undefined);
          }),
        );
      }
      for (const entry of scoped) {
        const scopedBus = eventBus.scope(entry.scope);
        for (const channel of entry.channels) {
          subs.push(
            scopedBus.get(channel as keyof EventMap).subscribe((payload) => {
              emitOrBuffer(channel, payload, entry.scope);
            }),
          );
        }
      }

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
            const events = await fetchArchivistReplay(c.get('config'), String(rId), parsed.sequence + 1);
            const replayable: StoredEvent[] = events.filter((e) => allowedTypes.has(e.type as string));

            if (events.length > 0 && events[0]!.metadata.sequenceNumber > parsed.sequence + 1) {
              await emitResumeGap('retention-exceeded', entry.scope, entry.lastEventId);
            }

            for (const ev of replayable) {
              await writeBusEvent(ev.type as string, ev, entry.scope);
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
      // by writeBusEvent from the payload's correlationId), so a copy that
      // also arrived live during a connection overlap dedups client-side.
      // Entries are not consumed: a repeat replay is idempotent by id.
      for (const cid of pendingReplies) {
        if (tornDown) break;
        const retained = correlations.lookupReply(cid, clientId, subscriberDid);
        if (retained) {
          await writeBusEvent(retained.channel, retained.payload, undefined);
        }
      }

      // ── Drain buffer and switch to live mode ─────────────────────────
      while (liveBuffer.length > 0 && !tornDown) {
        const next = liveBuffer.shift()!;
        await writeBusEvent(next.channel, next.payload, next.scope);
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

    const principalDid = c.get('principalDid') as string | undefined;
    if (principalDid) {
      payload._userId = principalDid;
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
    const claimCid = channel in BUS_OPERATIONS ? correlationIdOf(payload) : undefined;
    if (claimCid) {
      const clientId = (body as { clientId?: unknown }).clientId;
      if (typeof clientId !== 'string' || clientId === '') {
        // Loud, not lenient: a mis-wired client would otherwise burn every
        // busRequest's 30 s timeout with no server-side signal. We control
        // every emitter, so there is no compat path to keep open.
        throw new HTTPException(400, {
          message: `clientId is required to emit ${channel} with a correlationId`,
        });
      }
      let registry = registryByBus.get(eventBus);
      if (!registry) {
        registry = createCorrelationRegistry(eventBus);
        registryByBus.set(eventBus, registry);
      }
      const outcome = registry.claim(claimCid, clientId, principalDid);
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
    // express. `/bus/subscribe` enforces no channel allowlist and this
    // handler publishes unconditionally, so a client can emit a channel no
    // participant subscribes to and otherwise get a clean 202 back.
    // `warnIfUnobservedReply` does not cover it: that detector requires a
    // `correlationId`, and fire-and-forget UI signals carry none.
    //
    // Counted on the SCOPED subject when `scope` is set — an unscoped
    // subscriber is not a subscriber to a scoped emit, and counting the
    // global subject would report a healthy fan-out for a signal nobody
    // scoped will receive.
    let subscribers = 0;

    await withTraceparent(carrier, () =>
      withSpan(
        `bus.dispatch:${channel}`,
        () => {
          const bus = scope ? eventBus.scope(scope) : eventBus;
          const subject = bus.get(channel as keyof EventMap);
          subscribers = subject.observers.length;
          subject.next(payload as never);

          busLog('EMIT', channel, payload, scope);
          recordBusEmit(channel, scope);
          getBusLogger().info('emit', { channel, scope, subscribers, correlationId: (payload as Record<string, unknown>).correlationId });
          if (subscribers === 0) {
            // The caller is told in the response body too; this is for the
            // operator reading logs after the fact, when nobody was watching
            // the exit code of a script.
            getBusLogger().warn('emit reached no subscribers', {
              channel,
              scope,
              hint: 'Nothing on this gateway subscribes to that channel. For a UI signal meant to cross to a participant, check that the channel is in BRIDGED_BROADCASTS and that a client subscribed to it.',
            });
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
