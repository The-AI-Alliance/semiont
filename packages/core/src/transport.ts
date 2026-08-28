/**
 * Transport interfaces — the shared contract for any wire-or-local
 * communication path consumed by `SemiontClient`. Concrete implementations
 * live alongside the runtime they wrap (`HttpTransport` in
 * `@semiont/http-transport`, in-process variants in `@semiont/make-meaning`,
 * etc.).
 *
 * Three interfaces:
 *
 *   ITransport          — bus primitives + lifecycle. Universal: every
 *                         concrete transport implements this.
 *   IBackendOperations  — auth, admin, and system endpoints.
 *                         HTTP-shaped today; an in-process transport may
 *                         implement none, some, or a different set.
 *                         Optional on `SemiontClient` — passed only when
 *                         the host has a backend that supports them.
 *   IContentTransport   — binary I/O (putBinary / getBinary). Narrow by
 *                         design because binary has different backpressure
 *                         and streaming characteristics.
 *
 * The behavioral guarantees every implementation must honor are documented
 * in `docs/protocol/TRANSPORT-CONTRACT.md`.
 */

import type { Observable } from 'rxjs';

import type { components, paths } from './types';
import type {
  AccessToken,
  BaseUrl,
  ContentFormat,
  Email,
  GoogleCredential,
  RefreshToken,
  UserDID,
} from './branded-types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { ExtractionOutcome } from './pdf-anchoring';
import type { EventMap } from './bus-protocol';
import type { EventBus } from './event-bus';
import type { SemiontError } from './errors';

type Agent = components['schemas']['Agent'];
type GetResourceResponse = components['schemas']['GetResourceResponse'];

// ── Connection state ────────────────────────────────────────────────────

/**
 * Six-state lifecycle for a transport's connection. Drives UI affordances
 * (connecting spinners, reconnecting banners, etc.) and is observed via
 * `ITransport.state$`.
 *
 *   initial      ─ pre-`start()`; never enters subscribers' streams
 *                  except as the first replayed value
 *   connecting   ─ in-flight initial open
 *   open         ─ healthy, delivering events
 *   reconnecting ─ open → dropped, retrying; may be transient
 *   degraded     ─ has been reconnecting for > DEGRADED_THRESHOLD_MS;
 *                  UI banner threshold; distinguishes brief mount-
 *                  churn cycles from sustained disconnection
 *   closed       ─ stop()/dispose() called; terminal
 */
export type ConnectionState =
  | 'initial'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'degraded'
  | 'closed';

// ── Response type helpers (shape-equivalent to the OpenAPI surface) ─────

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : T extends { responses: { 201: { content: { 'application/json': infer R } } } }
    ? R
    : T extends { responses: { 202: { content: { 'application/json': infer R } } } }
      ? R
      : never;

type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } }
  ? R
  : never;

export type HealthCheckResponse = ResponseContent<paths['/api/health']['get']>;
export type StatusResponse = ResponseContent<paths['/api/status']['get']>;
export type UserResponse = ResponseContent<paths['/api/users/me']['get']>;
export type UpdateUserRequest = RequestContent<paths['/api/admin/users/{id}']['patch']>;
export type UpdateUserResponse = ResponseContent<paths['/api/admin/users/{id}']['patch']>;
export type ListUsersResponse = ResponseContent<paths['/api/admin/users']['get']>;

// ── ITransport ──────────────────────────────────────────────────────────

export interface ITransport {
  /**
   * Base URL the transport speaks to. For HTTP this is `https://host[:port]`;
   * for in-process transports, an opaque identifier (e.g. `local://kb-id`).
   */
  readonly baseUrl: BaseUrl;

  // Bus primitives
  /**
   * Publish a payload on the named channel.
   *
   * `resourceScope`, when set, marks the emit as a resource-scoped
   * broadcast — only delivered to subscribers attached to that
   * resource's scope.
   *
   * Resolves with the number of subscribers the emit reached
   * (`/bus/emit` responds `{subscribers: n}`; GUIDED-TOUR P1), or `-1`
   * when the count is unknown — an older backend, an unreadable body, or
   * an in-process transport where the question does not apply. `-1` is
   * the same sentinel the Go client uses: a parse failure must stay
   * distinguishable from a genuine empty room.
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<number>;
  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void;
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;

  /**
   * Subscribe to a resource-scoped channel set. HTTP attaches a scope to
   * its SSE connection; in-process transports may be a no-op because
   * local events are delivered without scoping.
   *
   * Returns a disposer that detaches the scope when the last subscriber
   * unsubscribes (ref-counted).
   *
   * SDK-internal: this is the scope primitive the SDK's resource-scoped
   * `browse.*` live queries drive on subscribe/teardown (freshness follows
   * observation; #847) — it is not part of the application-facing surface.
   * Distinct resources COMPOSE (`.plans/MULTI-RESOURCE-SCOPE.md`): each
   * resource's subscriptions are ref-counted independently, and one client
   * may hold many resource scopes at once on its single connection.
   */
  subscribeToResource(resourceId: ResourceId): () => void;

  /**
   * Hand the given bus to the transport so the transport can publish
   * the events it receives into it. The reference flows
   * client → transport (the client owns the bus); transports never
   * construct or replace it. Concrete transports decide what "receives"
   * means: HTTP bridges every channel it observes on its SSE wire;
   * an in-process transport bridges from the local actor bus.
   */
  bridgeInto(bus: EventBus): void;

  // ── Connection state + lifecycle ──────────────────────────────────────

  /**
   * Transport-level connection state. For HTTP, reflects the SSE
   * connection's health; for in-process transports, typically `'open'`
   * from construction onward (no connection to lose).
   *
   * Load-bearing beyond UI: `busRequest` gates its emit on this
   * (`BusRequestPrimitive.state$`, .plans/BUS-ATTACH-GATE.md) — no
   * correlated emit before the reply path exists. Implementers back it
   * with a `BehaviorSubject` so the current state arrives synchronously
   * on subscribe.
   */
  readonly state$: Observable<ConnectionState>;

  /**
   * Correlated-reply retention, client side (BUS-RESUMPTION Phase 2 /
   * SDK-DEBT S1). `busRequest` registers its correlationId here before
   * emitting and releases on settle; a wire transport includes the
   * tracked set as `pendingReplies` on each subscribe body so a reply
   * published while the connection was down replays from the server's
   * retention buffer. OPTIONAL: in-process transports that cannot lose
   * replies omit it.
   */
  trackReply?(correlationId: string): () => void;

  /**
   * Stream of transport-level errors surfaced from typed-wire methods or
   * other transport-mediated round-trips, just before they're thrown to
   * the caller. Each emission is a `SemiontError` (or subclass — HTTP
   * emits `APIError`, in-process transports emit whatever subclass is
   * appropriate). Consumers can subscribe for global error handling
   * (e.g. surfacing 401/403 as modals, logging) without wrapping every
   * call site in try/catch. Distinct from bus-level errors, which are
   * surfaced via the channel-correlation pattern in `busRequest`.
   */
  readonly errors$: Observable<SemiontError>;

  dispose(): void;
}

// ── IBackendOperations ──────────────────────────────────────────────────

/**
 * Auth, admin, and system endpoints. HTTP-shaped today —
 * `HttpTransport` implements both this and `ITransport`; the
 * `SemiontClient` constructor takes a `IBackendOperations` argument
 * separately from the bus transport so non-HTTP transports
 * (`LocalTransport`) can implement just the bus surface and the
 * SemiontClient cleanly omits `client.auth` / `client.admin`.
 *
 * Implementations should map their native error codes to
 * `TransportErrorCode` (see `errors.ts`) so the routing layer
 * (`SemiontBrowser`) stays transport-neutral.
 */
export interface IBackendOperations {
  // ── Auth ──────────────────────────────────────────────────────────────

  authenticatePassword(email: Email, password: string): Promise<AuthResponse>;
  authenticateGoogle(credential: GoogleCredential): Promise<AuthResponse>;
  refreshAccessToken(token: RefreshToken): Promise<TokenRefreshResponse>;
  logout(): Promise<void>;
  acceptTerms(): Promise<void>;
  getCurrentUser(): Promise<UserResponse>;
  getMediaToken(resourceId: ResourceId): Promise<{ token: string }>;

  // ── Admin ─────────────────────────────────────────────────────────────

  listUsers(): Promise<ListUsersResponse>;
  getUserStats(): Promise<AdminUserStatsResponse>;
  updateUser(id: UserDID, data: UpdateUserRequest): Promise<UpdateUserResponse>;
  getOAuthConfig(): Promise<OAuthConfigResponse>;

  // ── System ────────────────────────────────────────────────────────────

  healthCheck(): Promise<HealthCheckResponse>;
  getStatus(): Promise<StatusResponse>;
}

// ── IContentTransport ───────────────────────────────────────────────────

export interface PutBinaryRequest {
  name: string;
  file: File | Buffer;
  format: ContentFormat;
  storageUri: string;
  entityTypes?: string[];
  language?: string;
  sourceAnnotationId?: AnnotationId | string;
  sourceResourceId?: ResourceId | string;
  generationPrompt?: string;
  generator?: Agent | Agent[];
  isDraft?: boolean;
  /**
   * Clone provenance (EXTRACT-ARCHIVIST P3): when set, the gateway stores
   * the bytes and routes creation through `yield:clone-create` — the
   * CloneTokenManager validates the token and inherits source metadata.
   * Bytes never ride the bus (D4a).
   */
  cloneToken?: string;
  /** Clone-only: archive the source resource after a successful clone. */
  archiveOriginal?: boolean;
}

/**
 * Optional byte-progress hook for `putBinary`. Receives raw byte counts;
 * derived shapes (percentage, ETA) are the caller's responsibility.
 *
 * `totalBytes` may be 0 when the underlying transport can't determine it
 * (chunked encoding, indeterminate streams). Consumers should render an
 * indeterminate state in that case.
 */
export type PutBinaryProgress = (event: { bytesUploaded: number; totalBytes: number }) => void;

export interface PutBinaryOptions {
  auth?: AccessToken;
  /**
   * Called as bytes flow over the wire. Honored by transports that can
   * observe upload progress (HTTP via XHR). Transports that can't
   * (in-process LocalContentTransport, current `ky`-based fetch path
   * with no `onProgress`) simply ignore it.
   */
  onProgress?: PutBinaryProgress;
  /**
   * Signal that aborts the in-flight request. The XHR-based HTTP path
   * calls `xhr.abort()` when the signal fires; in-process and
   * non-XHR HTTP paths complete in the background after abort.
   */
  signal?: AbortSignal;
}

export interface IContentTransport {
  putBinary(
    request: PutBinaryRequest,
    options?: PutBinaryOptions,
  ): Promise<{ resourceId: ResourceId }>;

  getBinary(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }>;

  getBinaryStream(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;

  /**
   * Fetch the resource's JSON-LD metadata graph (descriptor + annotations +
   * inbound entity references). The HTTP transport dereferences
   * `GET /resources/:id/jsonld` (the LD face an external linked-data client
   * sees); in-process transports assemble it from their `KnowledgeSystem`.
   * See `.plans/SIMPLER-JSON-LD.md` §5 / decision 7.
   */
  getResourceGraph(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<GetResourceResponse>;

  /**
   * Store anchored text — the coordinate map a producer derived from a
   * representation's bytes (OCR, a native text layer, a table or form
   * reader) — under **the content checksum of those bytes** (PERSIST-ANCHORS
   * decision A: one artifact per representation, and a representation IS its
   * bytes).
   *
   * The producer supplies the checksum because it alone knows which bytes it
   * actually read. That is a correctness rule, not a convenience: if the
   * store derived the key from the resource's CURRENT representation at
   * write time, a byte change racing the publish would file old geometry
   * under the new checksum — wrong quotes served, and the reconcile diff
   * sees "artifact present" so it never heals. Producer-supplied, the same
   * race files the map under the OLD checksum: an unreachable orphan, and
   * the new checksum's missing artifact is exactly what the third drift
   * class re-derives (SMELTER-AXIOMS S15).
   *
   * Its own method rather than a `putBinary` of some derived media type: a
   * coordinate map is not a *representation* of the resource, and dressing it
   * as one would make a derived artifact indistinguishable from content a user
   * uploaded.
   *
   * Whole-representation, like `getResourceGraph` is whole-resource. The
   * producer iterates page by page; every consumer wants one map.
   */
  putAnchoredText(
    checksum: string,
    outcome: ExtractionOutcome,
    options?: { auth?: AccessToken },
  ): Promise<void>;

  /**
   * The resource's anchored text, or `null` when none has been derived.
   *
   * Deliberately resource-addressed while `putAnchoredText` is
   * checksum-addressed: readers hold a resource id, and the server resolves
   * it to the current representation's checksum through the view — the
   * `resourceId → checksum` index of PERSIST-ANCHORS decision A. A reader
   * therefore can never receive geometry for bytes the resource no longer
   * has: the pointer moves, the artifacts stay, the index always follows
   * the pointer.
   *
   * `null` is not an error and is the common case: a native text layer is read
   * in the browser, and a resource whose media type has no extractor never
   * produces a map at all. Callers degrade — for a PDF annotation that means
   * geometry with no quoted text, which is the behaviour that shipped before
   * any of this existed.
   */
  getAnchoredText(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<ExtractionOutcome | null>;

  /**
   * The stored extraction outcome for exactly this byte content, or `null`
   * for a miss — the cache-consult read (PERSIST-ANCHORS P2c). Every cache
   * consumer runs out of process (the smelter worker, the detection
   * workers), so the `extract()` seam's consult crosses the wire through
   * this method; without it the cache would be write-only from exactly the
   * processes it exists to serve.
   *
   * Checksum-addressed and barrier-free, unlike `getAnchoredText`:
   * presence at this instant is the question (the keys listing's
   * semantics), and a caller holding the checksum already holds the
   * content identity — nothing to resolve, nothing to wait for.
   */
  getAnchoredTextByChecksum(
    checksum: string,
    options?: { auth?: AccessToken },
  ): Promise<ExtractionOutcome | null>;

  /**
   * Every key under which anchored text would currently be served — the
   * reconcile planner's bulk existence read (PERSIST-ANCHORS P0). The
   * Smelter diffs this against the catalog to find resources whose artifact
   * was lost (a transient store, a failed publish) and plans re-derivation;
   * one call per reconcile, never a `getAnchoredText` probe per resource,
   * because each map is ~32 KB per scanned page and only presence is asked.
   *
   * Keys are resource ids today; after PERSIST-ANCHORS P1 they are content
   * checksums. Callers compare against whichever handle the store is keyed
   * by — the diff moves with the rekey, this contract does not.
   */
  listAnchoredTextKeys(options?: { auth?: AccessToken }): Promise<string[]>;

  dispose(): void;
}
