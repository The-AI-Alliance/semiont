/**
 * `SignalPlane` — the gateway's hub role as a driver contract
 * (SIGNAL-PLANE D1/D2; the conformance suite in `__tests__/conformance.test.ts`
 * IS the spec — if a caller can tell which driver is installed, the phase
 * failed).
 *
 * Three verb groups, matching the three things the hub does:
 *
 *  1. **Ingest** — accept an emitted event for a channel + scope, AFTER the
 *     gateway's auth and validation (which never enter this interface). Two
 *     callers by contract (P0.1 q0, RATIFIED (a)): the HTTP `/bus/emit` route,
 *     and the gateway-resident actors. Under the in-process driver the actor
 *     caller is satisfied trivially — actors and driver share one `EventBus` —
 *     and P1's remote driver makes the funnel literal.
 *  2. **Fan-out, in TWO subscription modes** (invisible at N=1):
 *     - client mode: every subscriber receives every matching frame;
 *     - handler mode: a named group; each frame reaches AT MOST ONE member,
 *       never two, across all instances (a queue group under NATS; a group of
 *       one here).
 *  3. **Correlated-reply addressing** — ADDRESS-ONLY, by ratified decision:
 *     the interface learns WHERE a reply goes (`ReplyAddress`), never WHETHER
 *     a principal is entitled to one, and never takes a `correlationId` —
 *     that key lives in 71 payload schemas today, and an interface parsing
 *     payloads for its routing key would be rebuilt by BUS-ROUTING-DECLARED
 *     P2 (the envelope migration). The gateway's ledger (`./ledger.ts` —
 *     gateway POLICY, not driver code) owns claims, entitlement and its
 *     refusals, and mints the address. Under this in-process driver,
 *     owner-only delivery is realized by the gateway's entitlement gate over
 *     client-mode fan-out; a remote driver realizes it structurally
 *     (`clientId` inbox subjects) — where claims live cross-replica is
 *     explicitly P3's open question, prejudged by nothing here.
 *
 * Delivery contract (every plausible driver can sign it): at-most-once, best
 * effort, duplicates tolerated — consumers are idempotent. Ordering per
 * channel + scope at most, never across channels. A frame reaching handler
 * subscriptions is delivered to at most one group member; what the mode
 * forbids is the duplicate, not the loss.
 *
 * The driver moves frames and honors addresses; it never decides entitlement
 * — and it never inspects a payload (the P0.5 guard makes both mechanical).
 */
import type { SignalPlaneOptions } from './options';

declare const REPLY_ADDRESS: unique symbol;
/**
 * An opaque routing address for correlated replies. Minted by the gateway's
 * ledger from the client's identity; the driver routes to it and nothing
 * else. Deterministic per bus-client so both halves of a make-before-break
 * overlap share it.
 */
export type ReplyAddress = string & { readonly [REPLY_ADDRESS]: true };

export function toReplyAddress(clientId: string): ReplyAddress {
  return clientId as ReplyAddress;
}

/** One frame as the plane carries it: channel, payload, optional scope. */
export type OnFrame = (channel: string, payload: unknown, scope: string | undefined) => void;

export interface ScopedChannels {
  scope: string;
  channels: readonly string[];
}

export interface ClientSubscriptionSpec {
  /** The subscriber's reply address (see `ReplyAddress`). */
  address: ReplyAddress;
  /** Unscoped channels — includes the correlated set for a bus client. */
  global: readonly string[];
  /** The per-scope subscription matrix. */
  scoped: readonly ScopedChannels[];
  onFrame: OnFrame;
}

export interface PlaneSubscription {
  close(): void;
}

export interface IngestReceipt {
  /**
   * How many observers the target had AT DISPATCH — exact for a broadcast,
   * an upper bound for a correlated channel (owner filtering happens above
   * the plane). Zero is the signal the emit route's unanswerable-request
   * synthesis keys on.
   */
  observers: number;
}

export interface SignalPlane {
  ingest(channel: string, payload: unknown, scope?: string): IngestReceipt;
  subscribeClient(spec: ClientSubscriptionSpec): PlaneSubscription;
  /**
   * Handler mode. `group` names the competing-consumer group; each frame on
   * each channel reaches at most one member of the group, never two.
   */
  subscribeHandlers(group: string, channels: readonly string[], onFrame: OnFrame): PlaneSubscription;
  dispose(): void;
}

export type SignalPlaneFactory = (opts?: SignalPlaneOptions) => SignalPlane;
