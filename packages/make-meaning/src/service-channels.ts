/**
 * Per-service bus channel rosters for the standalone make-meaning entry
 * points (smelter, weaver, librarian, archivist).
 *
 * Reply channels are global fan-out on the gateway, so a transport that
 * subscribes the full `BRIDGED_CHANNELS` receives every OTHER client's reply
 * traffic too — measured at ~85 multi-MB `browse:annotations-result`
 * frames/min during the 2026-09-03 worker OOM, all parsed and dropped by
 * correlation-id filtering. Each service's transport subscribes exactly what
 * that service consumes instead (the worker-runtime precedent,
 * `WORKER_AWAITED_OPERATIONS` in `@semiont/jobs`):
 *
 *   - The SMELTER and WEAVER await `busRequest` replies (embed/catch-up/
 *     reconcile reads), so their transports carry the reply channels DERIVED
 *     from `BUS_OPERATIONS` over the operations they await; their
 *     domain-event channels are added by their actor state units at
 *     `start()`.
 *   - The LIBRARIAN answers operations AND awaits one read (the anchored-text
 *     ask behind gather's text dispatcher), so its transport carries its
 *     inbound roster plus that operation's reply channels.
 *   - The ARCHIVIST answers operations and folds broadcast signals but never
 *     awaits a wire reply, so its transport carries exactly its inbound
 *     request/signal roster. (Its own anchored-text ask runs on its LOCAL
 *     bus — the Browser beside it answers — so no wire reply is awaited.)
 *
 * Each awaited-operations list restates a fact the code owns (which
 * operations that service calls `busRequest` on); its gate is the build-time
 * census beside each list: every awaiting site declares its operation next to
 * the call (a `*Awaits` alias, `satisfies`-tied to the literal), and a drift
 * between a list and its declarations fails COMPILATION with the operation
 * named (the worker-runtime pattern — .plans/WORKER-ANCHORED-TEXT-CHANNEL.md,
 * whose subject was exactly such an omission killing every PDF detection
 * job). `busRequest`'s `isSubscribed` probe remains the runtime backstop for
 * an await nobody declared.
 */

import { replyChannelsFor, type BusOperationKey, type EventMap } from '@semiont/core';
import { MATCHER_CHANNELS } from './matcher';
import { GATHERER_CHANNELS } from './gatherer';
import type { AnchoredTextAskAwaits } from './anchored-text-ask';
import { STOWER_CHANNELS } from './stower';
import { BROWSER_CHANNELS } from './browser';
import { CLONE_TOKEN_CHANNELS } from './clone-token-manager';
import type {
  SmelterResourceReadAwaits,
  SmelterAnnotationsReadAwaits,
  SmelterCatalogPageAwaits,
} from './smelter';
import type {
  WeaverCatalogPageAwaits,
  WeaverEventsReadAwaits,
  WeaverAnnotationsReadAwaits,
} from './weaver';

// ── Smelter ──────────────────────────────────────────────────────────

/** The operations the Smelter awaits replies to (embed + reconcile reads). */
export const SMELTER_AWAITED_OPERATIONS = [
  'browse:resource-requested',
  'browse:annotations-requested',
  'browse:resources-requested',
] as const satisfies readonly BusOperationKey[];

/** The Smelter transport's global SSE channel set. */
export const SMELTER_REPLY_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(SMELTER_AWAITED_OPERATIONS);

type DeclaredSmelterAwaits =
  | SmelterResourceReadAwaits
  | SmelterAnnotationsReadAwaits
  | SmelterCatalogPageAwaits;
type SmelterAwaitCensusDrift =
  | Exclude<DeclaredSmelterAwaits, (typeof SMELTER_AWAITED_OPERATIONS)[number]>
  | Exclude<(typeof SMELTER_AWAITED_OPERATIONS)[number], DeclaredSmelterAwaits>;
/** The build-time census gate — see the header. Drift names the operation. */
export const smelterAwaitCensus: [SmelterAwaitCensusDrift] extends [never]
  ? 'in-census'
  : SmelterAwaitCensusDrift = 'in-census';

// ── Weaver ───────────────────────────────────────────────────────────

/** The operations the Weaver awaits replies to (catch-up + reconcile reads). */
export const WEAVER_AWAITED_OPERATIONS = [
  'browse:resources-requested',
  'browse:events-requested',
  'browse:annotations-requested',
] as const satisfies readonly BusOperationKey[];

/** The Weaver transport's global SSE channel set. */
export const WEAVER_REPLY_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(WEAVER_AWAITED_OPERATIONS);

type DeclaredWeaverAwaits =
  | WeaverCatalogPageAwaits
  | WeaverEventsReadAwaits
  | WeaverAnnotationsReadAwaits;
type WeaverAwaitCensusDrift =
  | Exclude<DeclaredWeaverAwaits, (typeof WEAVER_AWAITED_OPERATIONS)[number]>
  | Exclude<(typeof WEAVER_AWAITED_OPERATIONS)[number], DeclaredWeaverAwaits>;
/** The build-time census gate — see the header. Drift names the operation. */
export const weaverAwaitCensus: [WeaverAwaitCensusDrift] extends [never]
  ? 'in-census'
  : WeaverAwaitCensusDrift = 'in-census';

// ── Librarian ────────────────────────────────────────────────────────

/**
 * The actors' rosters (each pinned to its actor's real subscriptions by a
 * census gate), the gather-summary handler's channel, and the two progress
 * SIGNALS the local folds consume (`weave:applied` for the graph grace,
 * `smelt:settled` for the settle barrier). Signals have no BUS_OPERATIONS
 * entries, so the outbound derivation ignores them and nothing echoes. The
 * Librarian awaits no wire replies, so this inbound set IS its transport's
 * whole global subscription.
 */
export const LIBRARIAN_INBOUND_CHANNELS = [
  ...MATCHER_CHANNELS,
  ...GATHERER_CHANNELS,
  'gather:summary-requested',
  'weave:applied',
  'smelt:settled',
] as const satisfies readonly (keyof EventMap)[];

/** Every reply channel the Librarian's outbound pump forwards — derived over the inbound set. */
export const LIBRARIAN_OUTBOUND_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(LIBRARIAN_INBOUND_CHANNELS);

/**
 * The operations the Librarian awaits replies to: the anchored-text ask
 * behind gather's text dispatcher (bugs/gather-ships-raw-pdf-bytes P1 —
 * derived text for `pdf-text-layer` media, answered by the Archivist).
 */
export const LIBRARIAN_AWAITED_OPERATIONS = [
  'browse:anchored-text-requested',
] as const satisfies readonly BusOperationKey[];

/** The Librarian transport's awaited-reply SSE channels, beyond its inbound roster. */
export const LIBRARIAN_REPLY_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(LIBRARIAN_AWAITED_OPERATIONS);

type DeclaredLibrarianAwaits = AnchoredTextAskAwaits;
type LibrarianAwaitCensusDrift =
  | Exclude<DeclaredLibrarianAwaits, (typeof LIBRARIAN_AWAITED_OPERATIONS)[number]>
  | Exclude<(typeof LIBRARIAN_AWAITED_OPERATIONS)[number], DeclaredLibrarianAwaits>;
/** The build-time census gate — see the header. Drift names the operation. */
export const librarianAwaitCensus: [LibrarianAwaitCensusDrift] extends [never]
  ? 'in-census'
  : LibrarianAwaitCensusDrift = 'in-census';

// ── Archivist ────────────────────────────────────────────────────────

/**
 * Everything the actors subscribe to (each roster pinned by a census gate),
 * plus the smelt barrier's fold input, plus `mark:create-request` —
 * annotation-assembly registers beside the Stower whose `mark:added` facts
 * it consumes (EXTRACT-ARCHIVIST P3, D2 i). The Archivist awaits no wire
 * replies, so this inbound set IS its transport's whole global subscription.
 */
export const ARCHIVIST_INBOUND_CHANNELS = [
  ...STOWER_CHANNELS,
  ...BROWSER_CHANNELS,
  ...CLONE_TOKEN_CHANNELS,
  'mark:create-request',
  'smelt:settled',
  // The annotation-context read moved here with the bytes (SINGLE-KB-MOUNT D5).
  'browse:annotation-context-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Reply channels the Archivist emits for operations whose REGISTRY KEY is a
 * gateway-handler channel, not one of our inbound channels — so the
 * BUS_OPERATIONS derivation cannot see them. Each is named with its owner;
 * anything else belongs in the derivation, never here.
 */
export const ARCHIVIST_OUTBOUND_STRAYS = [
  'mark:body-update-failed', // op keyed 'bind:update-body' (gateway handler re-emits mark:update-body)
  'yield:move-failed',       // yield:mv has no registered operation; failure is direct-subscribed
] as const satisfies readonly (keyof EventMap)[];

/** Every reply channel the Archivist's outbound pump forwards — the derivation over the inbound set, plus the strays. */
export const ARCHIVIST_OUTBOUND_CHANNELS: readonly (keyof EventMap)[] = [
  ...ARCHIVIST_OUTBOUND_STRAYS,
  ...replyChannelsFor(ARCHIVIST_INBOUND_CHANNELS),
];
