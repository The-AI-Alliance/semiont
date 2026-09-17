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
 *  3. **Correlated-reply addressing** — the interface learns WHERE a frame
 *     goes (`ReplyAddress`), never WHETHER a principal is entitled to one.
 *     It carries a `correlationId` without reading one: the key rides
 *     `PlaneEnvelope.meta`, ferried verbatim (`scope` is the only field a
 *     driver interprets). The gateway's ledger (`./ledger.ts` —
 *     gateway POLICY, not driver code) owns claims, entitlement and its
 *     refusals, and mints addresses. `deliver` is this group's publication
 *     half (P3 GREEN): a frame published TO an address, reaching every
 *     subscriber holding it and nobody else. What crosses it today is the
 *     gateway's own claim announcements to the shared ledger address —
 *     P3's cross-replica-claims resolution — carrying labels the registry
 *     never sees; the driver moves the envelope and reads nothing.
 *     Reply delivery itself stays client-mode fan-out under the gateway's
 *     entitlement gate (per-client addressed replies remain an unexercised
 *     optimization, recorded in the plan).
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
/**
 * A delivered frame: the channel, its payload, and the ENVELOPE.
 *
 * The envelope was a bare `scope` until BUS-CARRIES-FRAMES P3. That was the
 * same asymmetry the bus and the transport both had — one routing fact
 * travelling as its own argument while `correlationId` had to be smuggled
 * inside the payload. A handler cannot tell which fabric it is on, so every
 * fabric carries the same envelope.
 */
export type OnFrame = (channel: string, payload: unknown, envelope: PlaneEnvelope) => void;

/**
 * Routing facts that ride beside a payload.
 *
 * `scope` is named because the DRIVER interprets it — it selects the subject a
 * frame is published on. Everything else is `meta`: carried verbatim, never
 * read. That split is deliberate and the P0.5 census enforces it. A driver
 * that learned the correlation vocabulary would be a driver that had to
 * understand gateway policy, and (before the key left payloads) one that had
 * to deserialize an application payload to find its own routing key.
 *
 * The gateway puts `{ correlationId }` in `meta`; no driver names it.
 */
export interface PlaneEnvelope {
  readonly scope?: string;
  readonly meta?: Readonly<Record<string, string>>;
}

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
   *
   * OPTIONAL, because only an in-process fabric can count: a broker driver
   * reports NOTHING rather than a fabricated zero — zero means "dispatched
   * to provably nobody", and a remote fabric cannot prove it. Consumers gate
   * on `observers === 0`, so absence disables the fast-fail synthesis rather
   * than mis-firing it (recorded consequence for the P2 selection and the
   * Live gate).
   */
  observers?: number;
}

export interface SignalPlane {
  ingest(channel: string, payload: unknown, envelope?: PlaneEnvelope): IngestReceipt;
  subscribeClient(spec: ClientSubscriptionSpec): PlaneSubscription;
  /**
   * Handler mode. `group` names the competing-consumer group; each frame on
   * each channel reaches at most one member of the group, never two.
   */
  subscribeHandlers(group: string, channels: readonly string[], onFrame: OnFrame): PlaneSubscription;
  /**
   * Addressed publication (verb group 3's other half): the frame reaches
   * every `subscribeClient` holding `address`, and nobody else. `channel`
   * here is an envelope label for the receiver's `onFrame` — it never maps
   * to a channel subject, so it need not be registry vocabulary.
   */
  deliver(address: ReplyAddress, channel: string, payload: unknown): void;
  /**
   * Resolves when operations already issued on THIS plane's connection have
   * been processed by the broker.
   *
   * The one guarantee: after `await flush()`, a subscription issued before it
   * is registered, so a publish that happens after it will be delivered to
   * that subscription. That is what makes a readiness gate possible —
   * registering interest is asynchronous under a broker, and core NATS is
   * at-most-once, so a frame published before registration lands is DROPPED,
   * not delayed. No timeout recovers it.
   *
   * It is deliberately NOT, whatever the name suggests to a reader in a
   * hurry:
   *  - delivery confirmation — it says nothing about any subscriber receiving
   *    anything;
   *  - durability — nothing is persisted and at-most-once is unchanged;
   *  - ordering across connections — two replicas' publishes stay unordered;
   *  - a barrier for frames published by anyone else.
   *
   * REQUIRED, never optional: both drivers have a true answer, so an optional
   * member plus a caller-side `if (plane.flush)` would be one interface in two
   * dialects, running or not according to which implementation is held rather
   * than according to what is true.
   *
   * A composition-time and shutdown-time verb (D3). Never per subscribe and
   * never per frame: a flush per operation turns a fire-and-forget publish
   * into a synchronous round trip, which is a latency regression wearing the
   * costume of safety.
   */
  flush(): Promise<void>;
  dispose(): void;
}

export type SignalPlaneFactory = (opts?: SignalPlaneOptions) => SignalPlane;
