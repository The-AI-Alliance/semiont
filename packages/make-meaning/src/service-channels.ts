/**
 * Per-service bus channel rosters for the standalone make-meaning entry
 * points (smelter, weaver, librarian, archivist).
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

// ── Archivist ────────────────────────────────────────────────────────

/**
 * The command channels Stower subscribes to — the Archivist's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in archivist-decoupling.test.ts: grow one, and the gate
 * fails until the other moves with it.
 */
export const STOWER_CHANNELS = [
  'yield:create', 'yield:clone-persist', 'yield:update', 'yield:mv',
  'mark:create', 'mark:commit', 'mark:delete', 'mark:update-body',
  'frame:add-entity-type', 'frame:add-tag-schema',
  // Gateway-emitted when a person ACTS — a write, never mere presence —
  // carrying the name it verified. Declared, not bridged: no client
  // consumes it.
  'person:profile',
  'mark:archive', 'mark:unarchive', 'mark:update-entity-types',
  'job:start', 'job:assign', 'job:complete', 'job:fail',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The request channels Browser subscribes to — the Archivist's inbound wire
 * roster for this actor. Pinned to `initialize()`'s actual subscriptions by
 * the census gate in archivist-decoupling.test.ts.
 */
export const BROWSER_CHANNELS = [
  'browse:resource-requested', 'browse:anchored-text-requested',
  'browse:resources-requested', 'browse:annotations-requested',
  'browse:annotation-requested', 'browse:events-requested',
  'browse:annotation-history-requested',
  'browse:entity-types-requested', 'browse:tag-schemas-requested',
  'browse:agents-requested', 'browse:kb-requested', 'browse:directory-requested',
] as const satisfies readonly (keyof EventMap)[];

/**
 * The command channels CloneTokenManager subscribes to — the Archivist's
 * inbound wire roster for this actor. Pinned to `initialize()`'s actual
 * subscriptions by the census gate in archivist-decoupling.test.ts.
 */
export const CLONE_TOKEN_CHANNELS = [
  'yield:clone-token-requested', 'yield:clone-resource-requested', 'yield:clone-create',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Everything the actors subscribe to (each roster pinned by a census gate),
 * plus the smelt barrier's fold input, plus `mark:create-request` —
 * annotation-assembly registers beside the Stower whose `mark:added` facts
 * it consumes. The Archivist awaits no wire replies, so this inbound set IS
 * its transport's whole global subscription.
 */
export const ARCHIVIST_INBOUND_CHANNELS = [
  ...STOWER_CHANNELS,
  ...BROWSER_CHANNELS,
  ...CLONE_TOKEN_CHANNELS,
  'mark:create-request',
  'smelt:settled',
  // The annotation-context read registers beside the bytes it reads.
  'browse:annotation-context-requested',
  // The bind re-emit registers beside the Stower it drives. Its replies are
  // DERIVED from here — `bind:update-body` is a registered operation, so
  // `replyChannelsFor` picks up bind:body-updated / bind:body-update-failed
  // without a hand-written entry.
  'bind:update-body',
] as const satisfies readonly (keyof EventMap)[];

/**
 * Reply channels the Archivist forwards that the BUS_OPERATIONS derivation
 * cannot see, because no registered operation names them as its result or
 * failure. Each is named with its owner; anything else belongs in the
 * derivation, never here.
 */
export const ARCHIVIST_OUTBOUND_STRAYS = [
  'yield:move-failed',       // the Stower's failure answer to `yield:mv`, which has no registered operation
] as const satisfies readonly (keyof EventMap)[];

/** Every reply channel the Archivist's outbound pump forwards — the derivation over the inbound set, plus the strays. */
export const ARCHIVIST_OUTBOUND_CHANNELS: readonly (keyof EventMap)[] = [
  ...ARCHIVIST_OUTBOUND_STRAYS,
  ...replyChannelsFor(ARCHIVIST_INBOUND_CHANNELS),
];
