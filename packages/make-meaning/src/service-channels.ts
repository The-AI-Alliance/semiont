/**
 * Per-service bus channel rosters for the standalone make-meaning entry
 * points (smelter, weaver, librarian).
 *
 * Each service's transport subscribes exactly what that service consumes
 * (the worker-runtime precedent, `WORKER_AWAITED_OPERATIONS` in
 * `@semiont/jobs`), never the full `BRIDGED_CHANNELS`: a transport
 * subscribed to the full set receives and parses every broadcast frame on
 * channels its service never reads, only to drop it. (Replies are not
 * broadcast — the gateway delivers a reply only to its requester:
 * docs/protocol/TRANSPORT-CONTRACT.md.)
 *
 *   - The SMELTER and WEAVER await `busRequest` replies (embed/catch-up/
 *     reconcile reads), so their transports carry the reply channels DERIVED
 *     from `BUS_OPERATIONS` over the operations they await, beside the
 *     domain-event and command channels their fan-ins read
 *     (`SMELTER_MANIFEST`, `WEAVER_MANIFEST`).
 *   - The LIBRARIAN answers operations AND awaits one read (the anchored-text
 *     ask behind gather's text dispatcher), so its transport carries its
 *     inbound roster plus that operation's reply channels.
 *
 * Each awaited-operations list restates a fact the code owns (which
 * operations that service calls `busRequest` on); its gate is the build-time
 * census beside each list: every awaiting site declares its operation next to
 * the call (a `*Awaits` alias, `satisfies`-tied to the literal), and a drift
 * between a list and its declarations fails COMPILATION with the operation
 * named (the worker-runtime pattern). `busRequest`'s `isSubscribed` probe is
 * the runtime backstop for an await nobody declared.
 */

import { replyChannelsFor, type BusOperationKey, type EventMap } from '@semiont/core';
import type { AnchoredTextAskAwaits } from './anchored-text-ask';
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

/** The reply channels in the Smelter transport's subscription (`SMELTER_MANIFEST`). */
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

/** The reply channels in the Weaver transport's subscription (`WEAVER_MANIFEST`). */
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
 * The request channels Matcher subscribes to — the Librarian's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in librarian-decoupling.test.ts.
 */
export const MATCHER_CHANNELS = [
  'match:search-requested',
  'match:limits-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The request channels Gatherer subscribes to — the Librarian's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in gatherer-decoupling.test.ts.
 */
export const GATHERER_CHANNELS = [
  'gather:requested',
  'gather:resource-requested',
  'gather:limits-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The request channels the retrieval handlers subscribe, spread into the
 * Librarian's inbound roster; the census gate in resource-retrieval.test.ts
 * pins it to their subscriptions.
 */
export const RETRIEVAL_HANDLER_CHANNELS = [
  'match:resources-requested',
  'gather:referenced-by-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The actors' rosters and the retrieval handlers' (each pinned to its real
 * subscriptions by a census gate), the gather-summary handler's channel, and the two progress
 * SIGNALS the local folds consume (`weave:applied` for the graph grace,
 * `smelt:settled` for the settle barrier). Signals have no BUS_OPERATIONS
 * entries, so the outbound derivation ignores them and nothing echoes. The
 * Librarian's transport subscribes this set plus `LIBRARIAN_REPLY_CHANNELS`
 * below, the replies to the one read it awaits.
 */
export const LIBRARIAN_INBOUND_CHANNELS = [
  ...MATCHER_CHANNELS,
  ...GATHERER_CHANNELS,
  ...RETRIEVAL_HANDLER_CHANNELS,
  'gather:summary-requested',
  'weave:applied',
  'smelt:settled',
] as const satisfies readonly (keyof EventMap)[];

/** Every reply channel the Librarian's outbound pump forwards — derived over the inbound set. */
export const LIBRARIAN_OUTBOUND_CHANNELS: readonly (keyof EventMap)[] =
  replyChannelsFor(LIBRARIAN_INBOUND_CHANNELS);

/**
 * The operations the Librarian awaits replies to: the anchored-text ask
 * behind gather's text dispatcher (derived text for `pdf-text-layer` media,
 * answered by the Archivist).
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
