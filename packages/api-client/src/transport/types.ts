/**
 * Transport interfaces — the seam between `SemiontClient` and the wire.
 *
 * Phase 1 of TRANSPORT-ABSTRACTION. Two interfaces live here:
 *
 *   ITransport          — full remote surface: bus primitives + auth +
 *                         admin + exchange + health/status. In HTTP
 *                         mode this is all HTTP; in local mode (Phase 2)
 *                         each method is either in-process or throws.
 *   IContentTransport   — binary I/O (putBinary / getBinary). Narrow by
 *                         design because binary has different backpressure
 *                         and streaming characteristics.
 *
 * Namespaces receive these as constructor args; they never care which
 * concrete transport is behind them.
 */

import type { Observable } from 'rxjs';
import type {
  AccessToken,
  AnnotationId,
  BaseUrl,
  ContentFormat,
  CreationMethod,
  Email,
  EventBus,
  EventMap,
  GoogleCredential,
  RefreshToken,
  ResourceId,
  UserDID,
  components,
  paths,
} from '@semiont/core';
import type { ConnectionState } from '../view-models/domain/actor-vm';

type Agent = components['schemas']['Agent'];

export type { ConnectionState };

// ── Response type helpers (match the legacy client's shape) ─────────────

type AuthResponse = components['schemas']['AuthResponse'];
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
   * for local transports, an in-process identifier (e.g. `local://kb-id`).
   * Exposed so consumers can compose URLs to endpoints not covered by the
   * typed methods (e.g. media URLs assembled in JSX).
   */
  readonly baseUrl: BaseUrl;

  // Bus primitives
  /**
   * Publish a payload on the named channel.
   *
   * `resourceScope`, when set, marks the emit as a resource-scoped
   * broadcast — only delivered to subscribers attached to that
   * resource's scope. HTTP routes via `POST /bus/emit` with
   * `scope: <resourceId>`; local transports publish on
   * `eventBus.scope(resourceId)`. Used by worker processes for
   * `RESOURCE_BROADCAST_TYPES` events; ordinary commands omit it.
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
   * its SSE connection; local transports are a no-op because in-process
   * events are delivered without scoping.
   *
   * Returns a disposer that detaches the scope when the last subscriber
   * unsubscribes (ref-counted).
   */
  subscribeToResource(resourceId: ResourceId): () => void;

  /**
   * Wire this transport's event fan-in into the given bus. HTTP bridges
   * every channel it receives from SSE; LocalTransport is a no-op because
   * wire == local.
   */
  bridgeInto(bus: EventBus): void;

  // ── Auth ──────────────────────────────────────────────────────────────
  // Precedes any bus session because the session needs a token. In HTTP
  // mode these are POSTs to /api/tokens/*; in local mode they'd validate
  // against an attached Users DB or throw if embedded-unauthenticated.

  authenticatePassword(email: Email, password: string): Promise<AuthResponse>;
  authenticateGoogle(credential: GoogleCredential): Promise<AuthResponse>;
  refreshAccessToken(token: RefreshToken): Promise<AuthResponse>;
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

  // ── Exchange (SSE-streamed; raw Response for download endpoints) ─────

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
   * connection's health; for local transports, always `'open'` after
   * construction (no connection to lose).
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
