/**
 * Transport interfaces — the shared contract for any wire-or-local
 * communication path consumed by `SemiontClient`. Concrete implementations
 * live alongside the runtime they wrap (`HttpTransport` in
 * `@semiont/http-transport`).
 *
 * Three interfaces:
 *
 *   ITransport          — bus primitives + lifecycle. Universal: every
 *                         concrete transport implements this.
 *   IGatewayOperations  — auth and system endpoints.
 *                         HTTP-shaped; a non-HTTP transport may
 *                         implement none, some, or a different set.
 *                         Optional on `SemiontClient` — passed only when
 *                         the host has a gateway that supports them.
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
} from './branded-types';
import type { AnnotationId, ResourceId } from './identifiers';
import type { EventMap } from './bus-protocol';
import type { BusEnvelope, BusFrame } from './event-bus';
import type { EventBus } from './event-bus';
import type { SemiontError } from './errors';

type Agent = components['schemas']['Agent'];
type GetResourceResponse = components['schemas']['GetResourceResponse'];

// ── Connection state ────────────────────────────────────────────────────

/**
 * Seven-state lifecycle for a transport's connection. Drives UI affordances
 * (connecting spinners, reconnecting banners, etc.) and is observed via
 * `ITransport.state$`.
 *
 *   initial         ─ pre-`start()`; never enters subscribers' streams
 *                     except as the first replayed value
 *   connecting      ─ in-flight initial open
 *   open            ─ healthy, delivering events. Left only when the
 *                     stream DROPS: a transport that changes what its
 *                     stream carries without missing anything stays
 *                     `open`, so `open` reached again always means
 *                     something may have been missed
 *   reconnecting    ─ open → dropped, retrying; may be transient
 *   degraded        ─ has been reconnecting for > DEGRADED_THRESHOLD_MS;
 *                     UI banner threshold; distinguishes a blip from
 *                     sustained disconnection
 *   unauthenticated ─ not attempting: the credential is absent, or was
 *                     refused (401) and only a DIFFERENT one is worth
 *                     trying. No network activity; recovers on its own
 *                     when a usable credential appears (a re-login, a
 *                     session refresh). The refusal itself surfaces on
 *                     the transport's error stream; one state covers
 *                     both "no credential yet" and "credential refused"
 *   closed          ─ stop()/dispose() called; terminal
 */
export type ConnectionState =
  | 'initial'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'degraded'
  | 'unauthenticated'
  | 'closed';

// ── Response type helpers (shape-equivalent to the OpenAPI surface) ─────

type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : T extends { responses: { 201: { content: { 'application/json': infer R } } } }
    ? R
    : T extends { responses: { 202: { content: { 'application/json': infer R } } } }
      ? R
      : never;

export type HealthCheckResponse = ResponseContent<paths['/api/health']['get']>;
export type StatusResponse = ResponseContent<paths['/api/status']['get']>;
export type UserResponse = ResponseContent<paths['/api/users/me']['get']>;

// ── ITransport ──────────────────────────────────────────────────────────

export interface ITransport {
  /**
   * Base URL the transport speaks to. For HTTP this is `https://host[:port]`;
   * for a transport with no wire, an opaque identifier (e.g. `local://kb-id`).
   */
  readonly baseUrl: BaseUrl;

  // Bus primitives
  /**
   * Publish a payload on the named channel.
   *
   * The third argument is the ENVELOPE — the routing facts, none of which
   * belong in a channel's domain type. `scope`, when set, marks the emit as
   * a resource-scoped broadcast, delivered only to subscribers attached to
   * that resource's scope; `correlationId` pairs a reply with its request.
   *
   * Resolves with the number of subscribers the emit reached
   * (`/bus/emit` responds `{subscribers: n}`, so a signal that reached an
   * empty room is visible to its caller), or with `undefined` when there is
   * no count — a gateway on a broker signal plane, which cannot count and
   * omits `subscribers`, an unreadable body, or a transport with no wire, where
   * the question does not apply. The absence is carried through as an
   * absence: an uncounted emit must stay distinguishable from a genuine empty
   * room, and a number standing in for "unknown" would compare, add and print
   * as a count.
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    envelope?: BusEnvelope,
  ): Promise<number | undefined>;
  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void;
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;

  /**
   * Subscribe to a resource-scoped channel set. HTTP attaches a scope to
   * its SSE connection; a transport with no wire may be a no-op because
   * it delivers events without scoping.
   *
   * Returns a disposer that detaches the scope when the last subscriber
   * unsubscribes (ref-counted).
   *
   * SDK-internal: this is the scope primitive the SDK's resource-scoped
   * `browse.*` live queries drive on subscribe/teardown (freshness follows
   * observation) — it is not part of the application-facing surface.
   * Distinct resources COMPOSE: each resource's subscriptions are
   * ref-counted independently, and one client may hold many resource scopes
   * at once on its single connection.
   */
  subscribeToResource(resourceId: ResourceId): () => void;

  /**
   * Hand the given bus to the transport so the transport can publish
   * the events it receives into it. The reference flows
   * client → transport (the client owns the bus); transports never
   * construct or replace it. Concrete transports decide what "receives"
   * means: HTTP bridges every channel it observes on its SSE wire;
   * a transport with no wire bridges from its own source.
   */
  bridgeInto(bus: EventBus): void;

  // ── Connection state + lifecycle ──────────────────────────────────────

  /**
   * Transport-level connection state. For HTTP, reflects the SSE
   * connection's health; for a transport with no wire, typically `'open'`
   * from construction onward (no connection to lose).
   *
   * Load-bearing beyond UI: `busRequest` gates its emit on this
   * (`BusRequestPrimitive.state$`) — no
   * correlated emit before the reply path exists. Implementers back it
   * with a `BehaviorSubject` so the current state arrives synchronously
   * on subscribe.
   */
  readonly state$: Observable<ConnectionState>;

  /**
   * Correlated-reply retention, client side. `busRequest` registers its
   * correlationId here before emitting and releases on settle; a wire
   * transport includes the tracked set as `pendingReplies` on each subscribe
   * body so a reply published while the connection was down replays from the
   * server's retention buffer. Required of every transport: one that cannot
   * lose a reply has nothing to track and returns a disposer
   * that does nothing, which is its true answer.
   */
  trackReply(correlationId: string): () => void;

  /**
   * Whether this transport's receive path delivers `channel`
   * (`BusRequestPrimitive.isSubscribed` — every `ITransport` is passed to
   * `busRequest`, so it answers the same question). REQUIRED: a transport
   * with no wire answers `true` for every channel because it delivers every
   * emit, which is the true answer and not a stub.
   */
  isSubscribed(channel: keyof EventMap): boolean;

  /**
   * The ENVELOPE view (`BusRequestPrimitive.frames`). `busRequest` matches a
   * reply on `frame.correlationId`, so the key never enters a channel's
   * domain type. Required: every transport can answer it.
   */
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>>;

  /**
   * Stream of transport-level errors surfaced from typed-wire methods or
   * other transport-mediated round-trips, just before they're thrown to
   * the caller. Each emission is a `SemiontError` (or subclass — HTTP
   * emits `APIError`, other transports emit whatever subclass is
   * appropriate). Consumers can subscribe for global error handling
   * (e.g. surfacing 401/403 as modals, logging) without wrapping every
   * call site in try/catch. Distinct from bus-level errors, which are
   * surfaced via the channel-correlation pattern in `busRequest`.
   */
  readonly errors$: Observable<SemiontError>;

  dispose(): void;
}

// ── IGatewayOperations ──────────────────────────────────────────────────

/**
 * Auth and system endpoints. HTTP-shaped —
 * `HttpTransport` implements both this and `ITransport`; the
 * `SemiontClient` constructor takes a `IGatewayOperations` argument
 * separately from the bus transport so non-HTTP transports
 * can implement just the bus surface and the
 * SemiontClient cleanly omits `client.auth` / `client.system`.
 *
 * Implementations should map their native error codes to
 * `TransportErrorCode` (specs/src/errors/codes.json) so the routing layer
 * (`SemiontBrowser`) stays transport-neutral.
 */
export interface IGatewayOperations {
  // ── Auth ──────────────────────────────────────────────────────────────

  getCurrentUser(): Promise<UserResponse>;
  getMediaToken(resourceId: ResourceId): Promise<{ token: string }>;
  /** RFC 9728: which issuer the knowledge base trusts. Public; read before any token exists. */
  getProtectedResourceMetadata(): Promise<ProtectedResourceMetadata>;

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
  /** The job this resource fulfils, when a worker is creating it. Crosses the upload as a form field and lands on yield:create. */
  jobId?: string;
  isDraft?: boolean;
  /**
   * Clone provenance: when set, the Archivist stores the bytes and routes
   * creation through `yield:clone-create` — the CloneTokenManager validates
   * the token and inherits source metadata. Bytes never ride the bus.
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
   * Called as the bytes are sent: how much has gone and how much there is,
   * never less than it last said. A transport with no wire to send them
   * over never calls it.
   */
  onProgress?: PutBinaryProgress;
  /**
   * Cancels the upload. Over HTTP its connection is closed, nothing more is
   * reported, and it rejects with this signal's reason.
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
   * sees).
   */
  getResourceGraph(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<GetResourceResponse>;


  dispose(): void;
}
