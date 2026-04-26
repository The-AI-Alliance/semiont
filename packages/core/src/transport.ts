/**
 * Transport interfaces — the shared contract for any wire-or-local
 * communication path consumed by `SemiontClient`. Concrete implementations
 * live alongside the runtime they wrap (`HttpTransport` in
 * `@semiont/api-client`, in-process variants in `@semiont/make-meaning`,
 * etc.).
 *
 * Two interfaces:
 *
 *   ITransport          — full surface: bus primitives + auth + admin +
 *                         exchange + health/status + connection state.
 *   IContentTransport   — binary I/O (putBinary / getBinary). Narrow by
 *                         design because binary has different backpressure
 *                         and streaming characteristics.
 *
 * The behavioral guarantees every implementation must honor are documented
 * in `packages/core/docs/TRANSPORT-CONTRACT.md`.
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
import type { CreationMethod } from './creation-methods';
import type { AnnotationId, ResourceId } from './identifiers';
import type { EventMap } from './bus-protocol';
import type { EventBus } from './event-bus';

type Agent = components['schemas']['Agent'];

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

export type ProgressEvent = {
  phase: string;
  message?: string;
  result?: Record<string, unknown>;
};
export type ProgressCallback = (event: ProgressEvent) => void;

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
   */
  emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<void>;
  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void;
  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;

  /**
   * Subscribe to a resource-scoped channel set. HTTP attaches a scope to
   * its SSE connection; in-process transports may be a no-op because
   * local events are delivered without scoping.
   *
   * Returns a disposer that detaches the scope when the last subscriber
   * unsubscribes (ref-counted).
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

  // ── Auth ──────────────────────────────────────────────────────────────

  authenticatePassword(email: Email, password: string): Promise<AuthResponse>;
  authenticateGoogle(credential: GoogleCredential): Promise<AuthResponse>;
  refreshAccessToken(token: RefreshToken): Promise<TokenRefreshResponse>;
  logout(): Promise<void>;
  acceptTerms(): Promise<void>;
  getCurrentUser(): Promise<UserResponse>;
  generateMcpToken(): Promise<{ token: string }>;
  getMediaToken(resourceId: ResourceId): Promise<{ token: string }>;

  // ── Admin ─────────────────────────────────────────────────────────────

  listUsers(): Promise<ListUsersResponse>;
  getUserStats(): Promise<AdminUserStatsResponse>;
  updateUser(id: UserDID, data: UpdateUserRequest): Promise<UpdateUserResponse>;
  getOAuthConfig(): Promise<OAuthConfigResponse>;

  // ── Exchange ──────────────────────────────────────────────────────────

  backupKnowledgeBase(): Promise<Response>;
  restoreKnowledgeBase(file: File, onProgress?: ProgressCallback): Promise<ProgressEvent>;
  exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response>;
  importKnowledgeBase(file: File, onProgress?: ProgressCallback): Promise<ProgressEvent>;

  // ── System ────────────────────────────────────────────────────────────

  healthCheck(): Promise<HealthCheckResponse>;
  getStatus(): Promise<StatusResponse>;

  // ── Connection state + lifecycle ──────────────────────────────────────

  /**
   * Transport-level connection state. For HTTP, reflects the SSE
   * connection's health; for in-process transports, typically `'open'`
   * from construction onward (no connection to lose).
   */
  readonly state$: Observable<ConnectionState>;

  dispose(): void;
}

// ── IContentTransport ───────────────────────────────────────────────────

export interface PutBinaryRequest {
  name: string;
  file: File | Buffer;
  format: ContentFormat | string;
  storageUri: string;
  entityTypes?: string[];
  language?: string;
  creationMethod?: CreationMethod | string;
  sourceAnnotationId?: AnnotationId | string;
  sourceResourceId?: ResourceId | string;
  generationPrompt?: string;
  generator?: Agent | Agent[];
  isDraft?: boolean;
}

export interface IContentTransport {
  putBinary(
    request: PutBinaryRequest,
    options?: { auth?: AccessToken },
  ): Promise<{ resourceId: ResourceId }>;

  getBinary(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }>;

  getBinaryStream(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;

  dispose(): void;
}
