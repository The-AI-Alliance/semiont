/**
 * The correlation LEDGER — gateway POLICY, deliberately NOT driver code
 * (SIGNAL-PLANE P0.1 q1, RATIFIED: the ledger SPLITS — this is the half that
 * stays). It owns claims, entitlement and its refusals, and it is the one
 * module below `routes/` allowed to know the correlation vocabulary — the
 * conformance census exempts exactly this file. Where claims live under N
 * replicas is P3's open question; nothing here prejudges it.
 *
 * Relocated verbatim from `routes/bus.ts` (P0.4 — relocation allowed,
 * editing not), with one additive change: the two remaining inline caps
 * (`pendingRepliesMax`, `claimMaxGlobal`) joined the options it already had,
 * defaulting to the same values (D8 — the seven).
 *
 * (Original module comment follows.)
 *
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
import type { EventBus, EventMap } from '@semiont/core';
import type { Subscription } from 'rxjs';
import { getLogger } from '../logger';
import { CORRELATED_CHANNELS, isProgressChannel } from './channels';
import {
  CLAIM_MAX_GLOBAL,
  CLAIM_TTL_MS,
  PENDING_REPLIES_MAX,
  REPLY_RETENTION_MAX,
  REPLY_RETENTION_TTL_MS,
} from './options';

const getBusLogger = () => getLogger().child({ component: 'bus' });

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
  eventBus: EventBus,
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
  // TTL sweep of a claim that never got one.
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

  const subs: Subscription[] = CORRELATED_CHANNELS.map((channel) =>
    eventBus.get(channel as keyof EventMap).subscribe((payload) => {
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
    }),
  );

  return {
    claim(cid, clientId, principalDid) {
      sweepClaims();
      const existing = claims.get(cid);
      if (existing) return 'conflict';
      if ((perClient.get(clientId) ?? 0) >= pendingRepliesMax) return 'at-capacity';
      if (claims.size >= claimMaxGlobal) {
        // A backstop correct clients cannot reach. Oldest-first, breadcrumbed
        // per entry — never silent (L4).
        const oldest = claims.keys().next().value;
        if (oldest !== undefined) {
          getBusLogger().warn('[bus CLAIM-EVICTED] global claim cap reached', {
            correlationId: oldest,
            cap: claimMaxGlobal,
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
    occupancy() {
      let retainedReplies = 0;
      for (const claim of claims.values()) if (claim.reply) retainedReplies++;
      return { claims: claims.size, retainedReplies };
    },
    dispose() {
      for (const sub of subs) sub.unsubscribe();
      claims.clear();
      perClient.clear();
    },
  };
}
