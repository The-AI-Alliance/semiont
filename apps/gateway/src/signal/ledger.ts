/**
 * The correlation LEDGER — gateway POLICY, deliberately NOT driver code
 * (SIGNAL-PLANE P0.1 q1, RATIFIED: the ledger SPLITS — this is the half that
 * stays). It owns claims, entitlement and its refusals, and it is the one
 * module below `routes/` allowed to know the correlation vocabulary — the
 * conformance census exempts exactly this file.
 *
 * Claims live in a table every replica shares (`plane.table` — a KV bucket
 * under NATS). Each replica holds a projection of it, fed by the table's
 * watch, and decides frames against that projection:
 *
 *  - `claim` writes the table BEFORE the payload dispatches, and the write is
 *    atomic across replicas, so a cid claimed anywhere is `'conflict'` here.
 *    Once `claim` resolves, a reply can exist — and a read of the table finds
 *    the claim. That ordering is what makes the read-through below exact.
 *  - The projection can lag: the watch can deliver a claim to another replica
 *    after a reply gets there. So a frame whose cid this replica does not hold
 *    is not refused on that evidence. The replica reads the table — once per
 *    cid, shared by every subscriber that missed — and decides again, holding
 *    that cid's later frames behind the read so none overtakes it. A replica
 *    that started after the claim, or restarted since, reads through the same
 *    way.
 *  - Nothing reports a claim's expiry, so the projection keeps its own clock:
 *    a claim's age is the one its origin stored, and the sweep and the TTL
 *    check in `decide` are what bound the projection.
 *
 * `owner` answers from the projection; `lookupReply` backs the
 * `pendingReplies` reconnect probe, gated by the same ownership. `gate` is the
 * per-frame entitlement decision for one subscriber — ONE copy, consumed by
 * the route and the harness.
 *
 * Retention keeps only CLAIMED cids, in a second shared table whose 60 s TTL
 * is the bound — the payloads live in the broker, not in this process. Every
 * replica observes every correlated frame through the composition's standing
 * tap and writes the reply to a claim it holds; the first write wins, so the
 * origin, which always holds its own claim, is enough. Recovery therefore
 * answers from any replica and survives a restart. Claims carry their own,
 * longer budget.
 *
 * The probe is gated by ownership because it is otherwise a way to fish for
 * another user's replies: replies are delivered by channel fan-out under the
 * entitlement gate, and retention must not be the gap in it.
 */
import { isObject, isString } from '@semiont/core';
import { recordReplySuppressed } from '@semiont/observability';
import { getLogger } from '../logger';
import type { PlaneSubscription, SharedTable, SignalPlane } from './interface';
import { CLAIM_MAX_GLOBAL, CLAIM_TTL_MS, PENDING_REPLIES_MAX, REPLY_RETENTION_TTL_MS } from './options';

const getBusLogger = () => getLogger().child({ component: 'bus' });

/** The shared tables claims and retained replies live in — one name each, every replica. */
const CLAIMS_TABLE = 'ledger_claims';
const REPLIES_TABLE = 'ledger_replies';

export interface RetainedReply {
  channel: string;
  payload: unknown;
  /** The key the reply rode in on — replayed onto the SSE frame's envelope,
   *  never read back out of `payload` (BUS-CARRIES-FRAMES D1). */
  correlationId: string;
  retainedAt: number;
}

interface Claim {
  clientId: string;
  principalDid: string | undefined;
  claimedAt: number;
  /** First reply seen: the claim stops counting against the per-client cap. */
  answered?: boolean;
}

/** A claim as the shared table holds it. */
interface StoredClaim {
  clientId: string;
  principalDid?: string;
  claimedAt: number;
}

/**
 * Narrowed by guard, not by cast: a stored claim crossed the fabric, and a
 * guard PROVES the shape where a cast only asserts it. Only the gateway writes
 * this table, so a value that fails is an internal bug, reported by the caller.
 */
function parseStoredClaim(value: string): StoredClaim | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  const { clientId, principalDid, claimedAt } = raw;
  if (!isString(clientId) || clientId.length === 0) return undefined;
  if (principalDid !== undefined && !isString(principalDid)) return undefined;
  if (typeof claimedAt !== 'number' || !Number.isFinite(claimedAt)) return undefined;
  return { clientId, claimedAt, ...(principalDid === undefined ? {} : { principalDid }) };
}

/** A retained reply as the shared table holds it; its cid is the key. */
function parseStoredReply(value: string): { channel: string; payload: unknown; retainedAt: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  const { channel, payload, retainedAt } = raw;
  if (!isString(channel) || typeof retainedAt !== 'number' || !Number.isFinite(retainedAt)) return undefined;
  return { channel, payload, retainedAt };
}

/** One subscriber's entitlement decision, per frame. */
export interface DeliveryGate {
  /**
   * An unscoped frame on a correlated channel: `deliver` runs if this
   * subscriber owns the frame's claim — now, when the claim is known here, or
   * after the table read, when it is not.
   */
  offer(channel: string, correlationId: string | undefined, deliver: () => void): void;
  /** The subscriber is gone: nothing held for it is delivered. */
  close(): void;
}

export function createCorrelationRegistry(
  plane: SignalPlane,
  opts: {
    ttlMs?: number;
    claimTtlMs?: number;
    pendingRepliesMax?: number;
    claimMaxGlobal?: number;
    now?: () => number;
  } = {},
): {
  /** Resolves once both tables are open and this replica's projection holds
   *  every claim the table already contained. */
  ready: Promise<void>;
  claim(cid: string, clientId: string, principalDid: string | undefined): Promise<'ok' | 'conflict' | 'at-capacity'>;
  owner(cid: string): { clientId: string; principalDid: string | undefined } | undefined;
  lookupReply(cid: string, clientId: string, principalDid: string | undefined): Promise<RetainedReply | undefined>;
  /** One correlated frame, as the composition's plane tap saw it. Takes the
   *  frame's ferried METADATA, not a named key: the correlation vocabulary
   *  lives here and nowhere else on the gateway's plane side. */
  observe(channel: string, payload: unknown, meta: Readonly<Record<string, string>> | undefined): void;
  /** The entitlement decision for one subscriber. */
  gate(clientId: string, principalDid: string | undefined): DeliveryGate;
  /** Live claims this replica holds, with the ceiling they are measured
   *  against — the ceiling rides along so no reader restates a number this
   *  file owns. */
  occupancy(): { claims: number; claimsMax: number };
  dispose(): void;
} {
  const ttlMs = opts.ttlMs ?? REPLY_RETENTION_TTL_MS;
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
  const pendingRepliesMax = opts.pendingRepliesMax ?? PENDING_REPLIES_MAX;
  const claimMaxGlobal = opts.claimMaxGlobal ?? CLAIM_MAX_GLOBAL;
  const now = opts.now ?? Date.now;

  /**
   * Insertion-ordered, which is nearly claim-ordered: a claim adopted late
   * from the table can sit behind younger ones, and the sweep passes over it
   * until they expire. `decide`'s own TTL check means that never changes a
   * verdict, and the global cap bounds it.
   */
  const claims = new Map<string, Claim>();
  const perClient = new Map<string, number>();

  // perClient counts UNANSWERED claims — the thing the 429 message names.
  // Decremented once per claim, on whichever comes first: the answer, or the
  // TTL sweep of a claim that never got one. Claims made on other replicas
  // count too: the cap is a per-client budget, and the client's requests
  // spread over whichever replicas the balancer picked.
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
   * Sweep expired claims. A claim that was never answered is the moment a
   * lossy mode begins — its future reply becomes undeliverable — so it is
   * breadcrumbed (L4: no silent lossy mode). One that was answered is
   * ordinary cleanup and stays quiet.
   */
  const sweepClaims = () => {
    const cutoff = now() - claimTtlMs;
    for (const [cid, claim] of claims) {
      if (claim.claimedAt > cutoff) break;
      if (!claim.answered) {
        getBusLogger().warn('[bus CLAIM-EXPIRED] claim swept with no reply', {
          correlationId: cid,
          clientId: claim.clientId,
          ageMs: now() - claim.claimedAt,
        });
      }
      forget(cid);
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

  const record = (cid: string, stored: StoredClaim) => {
    evictIfAtGlobalCap();
    claims.set(cid, { clientId: stored.clientId, principalDid: stored.principalDid, claimedAt: stored.claimedAt });
    perClient.set(stored.clientId, (perClient.get(stored.clientId) ?? 0) + 1);
  };

  /**
   * A claim this replica learned from the table, through its watch or a read.
   * Never refused: it was accepted where it was made, and refusing it here
   * would fork the replicas' projections. The global backstop still holds.
   */
  const adopt = (cid: string, value: string) => {
    if (claims.has(cid)) return;
    const stored = parseStoredClaim(value);
    if (!stored) {
      getBusLogger().warn('[bus CLAIM-MALFORMED] unparseable stored claim ignored', { correlationId: cid });
      return;
    }
    if (now() - stored.claimedAt > claimTtlMs) return;
    record(cid, stored);
  };

  let disposed = false;
  let watching: PlaneSubscription | undefined;
  const claimsTable: Promise<SharedTable> = (async () => {
    const table = await plane.table(CLAIMS_TABLE, claimTtlMs);
    const subscription = await table.watch(adopt);
    if (disposed) subscription.close();
    else watching = subscription;
    return table;
  })();
  const repliesTable: Promise<SharedTable> = plane.table(REPLIES_TABLE, ttlMs);

  /** One read per cid per replica, however many subscribers missed it. */
  const reads = new Map<string, Promise<void>>();
  const readThrough = (cid: string): Promise<void> => {
    let pending = reads.get(cid);
    if (!pending) {
      pending = claimsTable
        .then((table) => table.read(cid))
        .then((value) => {
          if (value !== undefined) adopt(cid, value);
        })
        .catch((err: unknown) => {
          // The frames held behind this read are dropped: a claim this replica
          // cannot confirm is not delivered on hope. Loud, because it is lossy.
          getBusLogger().warn('[bus CLAIM-READ-FAILED] claim could not be read; held frames dropped', {
            correlationId: cid,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => reads.delete(cid));
      reads.set(cid, pending);
    }
    return pending;
  };

  /**
   * Three verdicts. `unknown` is only ever provisional: `gate` reads the table
   * and asks again, and an `unknown` after that is a cid nobody claimed — the
   * structural in-process case, where a gateway-internal `busRequest` rides
   * the plane via `requestPrimitiveFor` and consumes its reply itself. That
   * drop is silent: a warn would fire on every in-process operation.
   * Claimed-then-expired is also silent here; it is breadcrumbed at sweep time.
   */
  const decide = (channel: string, cid: string, clientId: string, principalDid: string | undefined): 'deliver' | 'drop' | 'unknown' => {
    const claim = claims.get(cid);
    if (!claim) return 'unknown';
    if (now() - claim.claimedAt > claimTtlMs) return 'drop';
    if (claim.clientId === clientId && claim.principalDid === principalDid) return 'deliver';
    // Owned by someone else. THIS is the amplification the filter removes,
    // and the only refusal worth a counter.
    recordReplySuppressed(channel);
    return 'drop';
  };

  return {
    ready: Promise.all([claimsTable, repliesTable]).then(() => undefined),
    async claim(cid, clientId, principalDid) {
      const table = await claimsTable;
      sweepClaims();
      if (claims.has(cid)) return 'conflict';
      if ((perClient.get(clientId) ?? 0) >= pendingRepliesMax) return 'at-capacity';
      const stored: StoredClaim = { clientId, claimedAt: now(), ...(principalDid === undefined ? {} : { principalDid }) };
      if (!(await table.create(cid, JSON.stringify(stored)))) return 'conflict';
      // The watch may already have delivered it; it counts once either way.
      if (!claims.has(cid)) record(cid, stored);
      return 'ok';
    },
    observe(channel, payload, meta) {
      const cid = meta?.correlationId;
      if (!cid) return;
      const claim = claims.get(cid);
      if (!claim) return; // not a claim this replica holds: nothing to retain
      if (!claim.answered) {
        claim.answered = true;
        release(claim.clientId);
      }
      sweepClaims();
      // First writer wins: every replica holding the claim offers the same
      // reply, and a refusal only means another got there first.
      const stored = JSON.stringify({ channel, payload, retainedAt: now() });
      void repliesTable
        .then((table) => table.create(cid, stored))
        .catch((err: unknown) => {
          // Recovery for this cid is lost; the live delivery is unaffected.
          getBusLogger().warn('[bus REPLY-RETAIN-FAILED] reply could not be retained for recovery', {
            correlationId: cid,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    gate(clientId, principalDid) {
      /** cid → decisions waiting on that cid's read, in arrival order. */
      const held = new Map<string, Array<() => void>>();
      let closed = false;
      const later = (channel: string, cid: string, deliver: () => void) => () => {
        if (!closed && decide(channel, cid, clientId, principalDid) === 'deliver') deliver();
      };
      return {
        offer(channel, cid, deliver) {
          if (!cid) {
            getBusLogger().warn('[bus REPLY-NO-CID] correlated frame without a correlationId', { channel });
            return;
          }
          const waiting = held.get(cid);
          if (waiting) {
            waiting.push(later(channel, cid, deliver));
            return;
          }
          const verdict = decide(channel, cid, clientId, principalDid);
          if (verdict === 'deliver') {
            deliver();
            return;
          }
          if (verdict === 'drop') return;
          held.set(cid, [later(channel, cid, deliver)]);
          void readThrough(cid).then(() => {
            const queue = held.get(cid) ?? [];
            held.delete(cid);
            for (const run of queue) run();
          });
        },
        close() {
          closed = true;
          held.clear();
        },
      };
    },
    owner(cid) {
      const claim = claims.get(cid);
      if (!claim) return undefined;
      if (now() - claim.claimedAt > claimTtlMs) return undefined;
      return { clientId: claim.clientId, principalDid: claim.principalDid };
    },
    async lookupReply(cid, clientId, principalDid) {
      // Ownership first, from the projection or the claims table: a replica
      // answering recovery may not have caught up with the claim.
      if (!claims.has(cid)) await readThrough(cid);
      const claim = claims.get(cid);
      if (!claim || claim.clientId !== clientId || claim.principalDid !== principalDid) return undefined;
      const value = await (await repliesTable).read(cid);
      if (value === undefined) return undefined;
      const reply = parseStoredReply(value);
      if (!reply) {
        getBusLogger().warn('[bus REPLY-MALFORMED] unparseable retained reply ignored', { correlationId: cid });
        return undefined;
      }
      // The table's TTL is enforced by the broker on its own schedule; the
      // window a caller is promised is enforced here.
      if (now() - reply.retainedAt > ttlMs) return undefined;
      return { channel: reply.channel, payload: reply.payload, correlationId: cid, retainedAt: reply.retainedAt };
    },
    occupancy() {
      return { claims: claims.size, claimsMax: claimMaxGlobal };
    },
    dispose() {
      disposed = true;
      watching?.close();
      claims.clear();
      perClient.clear();
      reads.clear();
    },
  };
}

/** The registry's own shape, so composition need not restate it. */
export type CorrelationRegistry = ReturnType<typeof createCorrelationRegistry>;
