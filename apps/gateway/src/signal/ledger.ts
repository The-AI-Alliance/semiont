/**
 * The correlation LEDGER — gateway POLICY, deliberately NOT driver code
 * (SIGNAL-PLANE P0.1 q1, RATIFIED: the ledger SPLITS — this is the half that
 * stays). It owns claims, entitlement and its refusals, and it is the one
 * module below `routes/` allowed to know the correlation vocabulary — the
 * conformance census exempts exactly this file.
 *
 * P3 GREEN (2026-09-15) changed HOW the ledger hears, twice:
 *
 *  1. **It is fed by the PLANE, not the in-process EventBus.** The old RxJS
 *     tap subscribed a bus the NATS driver never feeds (the harness's H0:
 *     replies delivered while claims were never marked answered). The tap is
 *     gone; `observe()` receives every correlated frame from the composition's
 *     standing plane subscription (`signal/composition.ts`), identically under
 *     both drivers.
 *  2. **Claims are cluster-visible.** Every replica's composition subscribes
 *     ONE shared reply-address (`LEDGER_ADDRESS`), and a successful local
 *     `claim` is announced to it via the plane's addressed delivery — so every
 *     ledger converges on the same claim table, the entitlement filter answers
 *     correctly on replicas that never saw the emit (H1/H6), and retention +
 *     `pendingReplies` recovery work from any replica (H5). `observeClaim`
 *     applies announcements idempotently (the origin hears its own echo).
 *     Announcement payload and parsing live HERE — the composition moves the
 *     frames and never learns their shape. The recorded, tolerated race
 *     (OBSERVED, not theoretical — the harness's H1 dropped its reply when
 *     emitted microseconds after the claim): a reply that reaches a replica
 *     before its claim's announcement is refused once, permanently. A real
 *     reply follows a handler round-trip while the announcement needs one
 *     broker hop, so the window is microscopic in practice; a loss inside
 *     it is recoverable only where a ledger retained the reply (always the
 *     origin), which `pendingReplies` recovery may or may not reach behind
 *     a balancer. Accepted at-most-once semantics, recorded here.
 *
 * `claim` records ownership at the request emit, BEFORE the payload
 * dispatches. `owner` backs the delivery filter; `lookupReply` backs the
 * `pendingReplies` reconnect probe, gated by the same ownership. `mayDeliver`
 * (relocated from `routes/bus.ts` at P3, so the route and the harness consume
 * ONE copy) is the per-frame entitlement decision over `owner`.
 *
 * Retention keeps only CLAIMED cids, with the old bounds (60 s TTL, FIFO cap,
 * eager sweep at insert — lookup-only expiry once pinned hundreds of MB of
 * reply payloads for nobody). Claims carry their own, longer budget. At N
 * replicas the cluster retains N copies of a reply (each replica within its
 * own caps) — that is what makes recovery replica-agnostic.
 *
 * Exposure: replies were global fan-out when this buffer was written, so
 * retention "added no exposure" and the probe was ungated. Routing ends that,
 * and an ungated probe would become the one remaining way to fish for another
 * user's replies — hence the owner check in `lookupReply`. The shared ledger
 * address adds one more surface: a client MUST NOT subscribe under the
 * `LEDGER_ADDRESS` clientId (claim metadata would fan out to it) — the
 * subscribe route refuses the name.
 */
import { recordReplySuppressed } from '@semiont/observability';
import { getLogger } from '../logger';
import { isProgressChannel } from './channels';
import { toReplyAddress, type ReplyAddress } from './interface';
import {
  CLAIM_MAX_GLOBAL,
  CLAIM_TTL_MS,
  PENDING_REPLIES_MAX,
  REPLY_RETENTION_MAX,
  REPLY_RETENTION_TTL_MS,
} from './options';

const getBusLogger = () => getLogger().child({ component: 'bus' });

/**
 * The ONE reply-address every replica's ledger tap subscribes — claim
 * announcements are delivered to it, so publishing once reaches every
 * ledger. Reserved: the subscribe route refuses a client claiming this name.
 */
export const LEDGER_ADDRESS: ReplyAddress = toReplyAddress('ledger');

/**
 * The envelope label claim announcements travel under. NOT a bus channel:
 * it exists only inside addressed (inbox) delivery, never on a channel
 * subject, never in the spec registry, never on the SSE surface.
 */
export const CLAIM_CHANNEL = 'ledger:claim';

export interface RetainedReply {
  channel: string;
  payload: unknown;
  retainedAt: number;
}

interface Claim {
  clientId: string;
  principalDid: string | undefined;
  claimedAt: number;
  /** First reply seen: the claim no longer counts against the per-client cap.
   *  A flag rather than reply-presence, because sweepReplies drops payloads
   *  while the claim (and its answered-ness) must persist. */
  answered?: boolean;
  reply?: RetainedReply;
}

export const correlationIdOf = (payload: unknown): string | undefined => {
  const cid = (payload as { correlationId?: unknown } | null | undefined)?.correlationId;
  return typeof cid === 'string' && cid.length > 0 ? cid : undefined;
};

export function createCorrelationRegistry(
  opts: {
    ttlMs?: number;
    max?: number;
    claimTtlMs?: number;
    pendingRepliesMax?: number;
    claimMaxGlobal?: number;
    now?: () => number;
  } = {},
): {
  claim(cid: string, clientId: string, principalDid: string | undefined): 'ok' | 'conflict' | 'at-capacity';
  owner(cid: string): { clientId: string; principalDid: string | undefined } | undefined;
  lookupReply(cid: string, clientId: string, principalDid: string | undefined): RetainedReply | undefined;
  /** One correlated frame, as the composition's plane tap saw it. */
  observe(channel: string, payload: unknown): void;
  /** A claim announcement from the shared ledger address — idempotent. */
  observeClaim(payload: unknown): void;
  /** The announcement for a just-accepted claim, built here so callers never
   *  learn the shape. */
  announcementFor(cid: string, clientId: string, principalDid: string | undefined): unknown;
  /** Per-frame entitlement: may THIS subscriber see THIS unscoped frame? */
  mayDeliver(channel: string, payload: unknown, clientId: string, principalDid: string | undefined): boolean;
  size(): number;
  /** Live claims and how many of them still hold a reply payload. */
  occupancy(): { claims: number; retainedReplies: number };
  dispose(): void;
} {
  const ttlMs = opts.ttlMs ?? REPLY_RETENTION_TTL_MS;
  const max = opts.max ?? REPLY_RETENTION_MAX;
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const pendingRepliesMax = opts.pendingRepliesMax ?? PENDING_REPLIES_MAX;
  const claimMaxGlobal = opts.claimMaxGlobal ?? CLAIM_MAX_GLOBAL;
  const now = opts.now ?? Date.now;

  /** Insertion-ordered: expired is always a prefix, so sweeping is a walk. */
  const claims = new Map<string, Claim>();
  const perClient = new Map<string, number>();

  // perClient counts UNANSWERED claims — the thing the 429 message names.
  // Decremented once per claim, on whichever comes first: the answer, or the
  // TTL sweep of a claim that never got one. Remote claims count too: the
  // cap is a per-client budget, and the client's requests spread over
  // whichever replicas the balancer picked.
  const release = (clientId: string) => {
    const n = (perClient.get(clientId) ?? 1) - 1;
    if (n <= 0) perClient.delete(clientId);
    else perClient.set(clientId, n);
  };

  const forget = (cid: string) => {
    const claim = claims.get(cid);
    if (!claim) return;
    claims.delete(cid);
    if (!claim.answered) release(claim.clientId);
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

  /** The global-cap backstop correct clients cannot reach. Oldest-first,
   *  breadcrumbed per entry — never silent (L4). */
  const evictIfAtGlobalCap = () => {
    if (claims.size < claimMaxGlobal) return;
    const oldest = claims.keys().next().value;
    if (oldest !== undefined) {
      getBusLogger().warn('[bus CLAIM-EVICTED] global claim cap reached', {
        correlationId: oldest,
        cap: claimMaxGlobal,
      });
      forget(oldest);
    }
  };

  const record = (cid: string, clientId: string, principalDid: string | undefined) => {
    claims.set(cid, { clientId, principalDid, claimedAt: now() });
    perClient.set(clientId, (perClient.get(clientId) ?? 0) + 1);
  };

  return {
    claim(cid, clientId, principalDid) {
      sweepClaims();
      const existing = claims.get(cid);
      if (existing) return 'conflict';
      if ((perClient.get(clientId) ?? 0) >= pendingRepliesMax) return 'at-capacity';
      evictIfAtGlobalCap();
      record(cid, clientId, principalDid);
      return 'ok';
    },
    observeClaim(payload) {
      const p = payload as { correlationId?: unknown; clientId?: unknown; principalDid?: unknown } | null | undefined;
      const cid = typeof p?.correlationId === 'string' && p.correlationId.length > 0 ? p.correlationId : undefined;
      const clientId = typeof p?.clientId === 'string' && p.clientId.length > 0 ? p.clientId : undefined;
      const principalDid = typeof p?.principalDid === 'string' ? p.principalDid : undefined;
      if (!cid || !clientId) {
        // Only the gateway itself publishes to the ledger address; a
        // malformed announcement is an internal bug, not client input.
        getBusLogger().warn('[bus CLAIM-MALFORMED] unparseable claim announcement dropped', {});
        return;
      }
      sweepClaims();
      if (claims.has(cid)) return; // the origin's own echo, or a duplicate delivery
      // No refusals: the announcement was ACCEPTED at its origin, and refusing
      // it here would fork the cluster's claim tables. The global backstop
      // still holds the line.
      evictIfAtGlobalCap();
      record(cid, clientId, principalDid);
    },
    announcementFor(cid, clientId, principalDid) {
      return { correlationId: cid, clientId, ...(principalDid === undefined ? {} : { principalDid }) };
    },
    observe(channel, payload) {
      const cid = correlationIdOf(payload);
      if (!cid) return;
      const claim = claims.get(cid);
      if (!claim) return; // never claimed: in-process requester, nothing to retain
      // Any activity on the cid refreshes the claim, so a streaming op that is
      // still reporting progress cannot expire mid-flight.
      claim.claimedAt = now();
      if (isProgressChannel(channel)) return; // refresh only; a stream is not an answer
      if (!claim.answered) {
        claim.answered = true;
        release(claim.clientId);
      }
      claim.reply = { channel, payload, retainedAt: now() };
      sweepClaims();
      sweepReplies();
    },
    /**
     * Ownership check for a frame on a correlated channel.
     *
     * Three negatives, deliberately distinguished:
     *  - a result/failure with NO correlationId violates REPLY-SHAPE-STANDARD
     *    → drop and warn (loud absence; never a manufactured broadcast);
     *  - a NEVER-CLAIMED cid → drop silently. This is the structural
     *    in-process case (`eventBusRequest` runs on the gateway's own plane
     *    and consumes the reply itself), not a lossy mode — a warn here would
     *    fire on every in-process operation;
     *  - a cid owned by someone else → drop silently. That is the routing
     *    working.
     * The genuinely lossy case, claimed-then-expired, is breadcrumbed at
     * sweep time instead, which needs no tombstone here.
     */
    mayDeliver(channel, payload, clientId, principalDid) {
      const cid = correlationIdOf(payload);
      if (!cid) {
        if (!isProgressChannel(channel)) {
          getBusLogger().warn('[bus REPLY-NO-CID] correlated frame without a correlationId', { channel });
        }
        return false;
      }
      const claim = claims.get(cid);
      if (!claim || now() - claim.claimedAt > claimTtlMs) return false;
      if (claim.clientId === clientId && claim.principalDid === principalDid) return true;
      // Owned by someone else. THIS is the amplification the filter removes,
      // and the only one of the three refusals worth a counter.
      recordReplySuppressed(channel);
      return false;
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
    occupancy() {
      let retainedReplies = 0;
      for (const claim of claims.values()) if (claim.reply) retainedReplies++;
      return { claims: claims.size, retainedReplies };
    },
    dispose() {
      claims.clear();
      perClient.clear();
    },
  };
}
