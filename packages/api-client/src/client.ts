/**
 * Common API client for Semiont backend
 *
 * This client can be used by:
 * - MCP server (Node.js)
 * - Demo scripts (Node.js)
 * - Frontend (Next.js/React - can wrap with hooks)
 *
 * Uses ky for HTTP requests with built-in retry, timeout, and error handling.
 */

import ky, { HTTPError, type KyInstance } from 'ky';
import type { paths, components } from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  AccessToken,
  BaseUrl,
  BodyOperation,
  CloneToken,
  ContentFormat,
  Email,
  EntityType,
  EventBus,
  GoogleCredential,
  JobId,
  Motivation,
  RefreshToken,
  SearchQuery,
  UserDID
} from '@semiont/core';
import { createActorVM, type ActorVM } from './view-models/domain/actor-vm';
import { busRequest } from './bus-request';
import { BehaviorSubject } from 'rxjs';
import { BrowseNamespace } from './namespaces/browse';
import { MarkNamespace } from './namespaces/mark';
import { BindNamespace } from './namespaces/bind';
import { GatherNamespace } from './namespaces/gather';
import { MatchNamespace } from './namespaces/match';
import { YieldNamespace } from './namespaces/yield';
import { BeckonNamespace } from './namespaces/beckon';
import { JobNamespace } from './namespaces/job';
import { AuthNamespace } from './namespaces/auth';
import { AdminNamespace } from './namespaces/admin';
import type { Logger } from '@semiont/core';
import { PERSISTED_EVENT_TYPES, RESOURCE_BROADCAST_TYPES } from '@semiont/core';
import type { Subscription } from 'rxjs';

const RESOURCE_SCOPED_CHANNELS = [
  ...PERSISTED_EVENT_TYPES.filter(t => t !== 'mark:entity-type-added'),
  ...RESOURCE_BROADCAST_TYPES,
];

const BUS_RESULT_CHANNELS = [
  'browse:resources-result', 'browse:resources-failed',
  'browse:resource-result', 'browse:resource-failed',
  'browse:annotations-result', 'browse:annotations-failed',
  'browse:annotation-result', 'browse:annotation-failed',
  'browse:annotation-history-result', 'browse:annotation-history-failed',
  'browse:events-result', 'browse:events-failed',
  'browse:referenced-by-result', 'browse:referenced-by-failed',
  'browse:entity-types-result', 'browse:entity-types-failed',
  'browse:directory-result', 'browse:directory-failed',
  'browse:annotation-context-result', 'browse:annotation-context-failed',
  'mark:delete-ok', 'mark:delete-failed',
  'mark:create-ok', 'mark:create-failed',
  'mark:progress', 'mark:assist-finished', 'mark:assist-failed',
  'match:search-results', 'match:search-failed',
  'gather:complete', 'gather:failed',
  'gather:annotation-progress', 'gather:annotation-finished',
  'gather:summary-result', 'gather:summary-failed',
  'yield:progress',
  'bind:body-updated', 'bind:body-update-failed',
  'job:status-result', 'job:status-failed',
  'job:created', 'job:create-failed',
  'job:claimed', 'job:claim-failed',
  'yield:clone-token-generated', 'yield:clone-token-failed',
  'yield:clone-resource-result', 'yield:clone-resource-failed',
  'yield:clone-created', 'yield:clone-create-failed',
  'mark:entity-type-added',
  'beckon:focus', 'beckon:sparkle',
  'bus:resume-gap',
] as const;

// Every global-SSE-delivered channel is bridged from the bus actor
// into the local EventBus so namespace Observables, flow VMs, and UI
// components subscribing via `eventBus.get(channel)` receive events
// without needing to know about the actor or SSE wire format.
//
// In practice this is all `BUS_RESULT_CHANNELS` plus cross-participant
// UI signals — the set is identical, since every channel the frontend
// subscribes to globally is one we want on the local bus. Scoped
// channels are bridged separately inside `subscribeToResource`.
const ACTOR_TO_LOCAL_BRIDGES = BUS_RESULT_CHANNELS;

// Type helpers to extract request/response types from OpenAPI paths
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : T extends { responses: { 201: { content: { 'application/json': infer R } } } }
    ? R
    : never;

type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

// API Error class
export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
  }
}

/**
 * Optional callback invoked when a request fails with HTTP 401. If it
 * resolves to a non-null token, the failed request is retried once with
 * the new Bearer token. If it resolves to null (or throws), the original
 * 401 propagates as an APIError.
 *
 * Implementations must dedupe concurrent calls so that simultaneous 401s
 * don't fire multiple parallel refresh requests. The frontend's
 * KnowledgeBaseSessionProvider provides this via an in-flight Promise map
 * keyed by KB id.
 */
export type TokenRefresher = () => Promise<string | null>;

export interface SemiontApiClientConfig {
  baseUrl: BaseUrl;
  /** Per-workspace EventBus. Required — one bus per workspace, constructed externally. */
  eventBus: EventBus;
  /**
   * Observable access token. All auth (HTTP + bus) reads the current value.
   * Update by calling `.next(newToken)` on the BehaviorSubject. The bus actor
   * auto-starts when the value transitions from null to a real token.
   * If omitted, the client operates unauthenticated (public endpoints only).
   */
  token$?: BehaviorSubject<AccessToken | null>;
  timeout?: number;
  retry?: number;
  logger?: Logger;
  /** Optional 401-recovery hook. See {@link TokenRefresher}. */
  tokenRefresher?: TokenRefresher;
}

/**
 * Options for individual API requests
 */
export interface RequestOptions {
  /** Access token for this request */
  auth?: AccessToken;
}

/**
 * Semiont API Client
 *
 * Provides type-safe methods for all Semiont backend API endpoints.
 * This client is fully stateless - authentication must be provided per request.
 */
export class SemiontApiClient {
  private http: KyInstance;
  readonly baseUrl: BaseUrl;
  /** The workspace-scoped EventBus this client was constructed with. */
  readonly eventBus: EventBus;
  private logger?: Logger;

  /**
   * Observable token source. All auth reads from this.
   */
  private readonly token$: BehaviorSubject<AccessToken | null>;

  private _actor: ActorVM | null = null;

  // ── Verb-oriented namespace API ──────────────────────────────────────────
  public readonly browse: BrowseNamespace;
  public readonly mark: MarkNamespace;
  public readonly bind: BindNamespace;
  public readonly gather: GatherNamespace;
  public readonly match: MatchNamespace;
  public readonly yield: YieldNamespace;
  public readonly beckon: BeckonNamespace;
  public readonly job: JobNamespace;
  public readonly auth: AuthNamespace;
  public readonly admin: AdminNamespace;

  constructor(config: SemiontApiClientConfig) {
    const { baseUrl, eventBus, timeout = 30000, retry = 2, logger, tokenRefresher } = config;

    this.eventBus = eventBus;

    // Store logger and baseUrl for constructing full URLs
    this.logger = logger;

    // Remove trailing slash for consistent URL construction
    this.baseUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) as BaseUrl;

    // When a tokenRefresher is configured, expand ky's retry policy to retry
    // 401 exactly once on any method. The limit of 1 means: at most one auth
    // retry per failed request. If the refreshed token also 401s, the request
    // fails and the modal surfaces — the api-client does not chain refreshes.
    //
    // Tradeoff vs the default `retry: 2`: transient 5xx errors are also
    // retried only once instead of twice. Acceptable: a single retry handles
    // ephemeral upstream blips, and chaining more retries on 5xx delays the
    // user-visible failure without meaningfully improving outcomes.
    const retryConfig = tokenRefresher
      ? {
          limit: 1,
          methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
          statusCodes: [401, 408, 413, 429, 500, 502, 503, 504],
        }
      : retry;

    // Don't use prefixUrl - we'll construct full URLs or use provided full URIs
    this.http = ky.create({
      timeout,
      retry: retryConfig,
      credentials: 'include',
      hooks: {
        beforeRequest: [
          (request) => {
            // Log HTTP request
            if (this.logger) {
              this.logger.debug('HTTP Request', {
                type: 'http_request',
                url: request.url,
                method: request.method,
                timestamp: Date.now(),
                hasAuth: request.headers.has('Authorization'),
              });
            }
          },
        ],
        beforeRetry: tokenRefresher
          ? [
              async ({ request, error }) => {
                // Only intercept 401s — let ky retry the rest with default behavior
                if (!(error instanceof HTTPError) || error.response.status !== 401) {
                  return undefined;
                }
                try {
                  const newToken = await tokenRefresher();
                  if (!newToken) return ky.stop;
                  request.headers.set('Authorization', `Bearer ${newToken}`);
                  return undefined;
                } catch {
                  return ky.stop;
                }
              },
            ]
          : [],
        afterResponse: [
          (request, _options, response) => {
            // Log HTTP response
            if (this.logger) {
              this.logger.debug('HTTP Response', {
                type: 'http_response',
                url: request.url,
                method: request.method,
                status: response.status,
                statusText: response.statusText
              });
            }
            return response;
          }
        ],
        beforeError: [
          async (error) => {
            const { response, request } = error;
            if (response) {
              const body = await response.json().catch(() => ({})) as { message?: string };

              // Log HTTP error
              if (this.logger) {
                this.logger.error('HTTP Request Failed', {
                  type: 'http_error',
                  url: request.url,
                  method: request.method,
                  status: response.status,
                  statusText: response.statusText,
                  error: body.message || `HTTP ${response.status}: ${response.statusText}`
                });
              }

              throw new APIError(
                body.message || `HTTP ${response.status}: ${response.statusText}`,
                response.status,
                response.statusText,
                body
              );
            }
            return error;
          },
        ],
      },
    });

    // Observable token source. Namespaces read the current value synchronously
    // via token$.getValue(). The bus actor's token getter does the same.
    this.token$ = config.token$ ?? new BehaviorSubject<AccessToken | null>(null);
    const getToken = () => this.token$.getValue() ?? undefined;

    // Verb-oriented namespace API
    this.browse = new BrowseNamespace(this, this.eventBus, getToken, this.actor);
    this.mark = new MarkNamespace(this, this.eventBus, getToken, this.actor);
    this.bind = new BindNamespace(this.actor);
    this.gather = new GatherNamespace(this.eventBus, this.actor);
    this.match = new MatchNamespace(this.eventBus, this.actor);
    this.yield = new YieldNamespace(this, this.eventBus, getToken, this.actor);
    this.beckon = new BeckonNamespace(this.actor);
    this.job = new JobNamespace(this.actor);
    this.auth = new AuthNamespace(this, getToken);
    this.admin = new AdminNamespace(this, getToken);

    // Auto-start the bus actor when the token transitions from null to a
    // real value. This avoids unauthenticated connect attempts during
    // bootstrap and lets refresh-after-expiry resume cleanly.
    this.token$.subscribe((token) => {
      if (token && !this._actorStarted) {
        this._actorStarted = true;
        this.actor.start();
      }
    });
  }

  private _actorStarted = false;

  get actor(): ActorVM {
    if (!this._actor) {
      this._actor = createActorVM({
        baseUrl: this.baseUrl,
        token: () => this.token$.getValue() ?? '',
        channels: [...BUS_RESULT_CHANNELS],
      });
      for (const channel of ACTOR_TO_LOCAL_BRIDGES) {
        this._actor.on$<Record<string, unknown>>(channel).subscribe((payload) => {
          (this.eventBus.get(channel as keyof import('@semiont/core').EventMap) as { next(v: unknown): void }).next(payload);
        });
      }
    }
    return this._actor;
  }

  private activeResource: {
    resourceId: ResourceId;
    refCount: number;
    bridgeSubs: Subscription[];
  } | null = null;

  /**
   * Subscribe the bus actor to the resource-scoped SSE stream for a single
   * resource and bridge incoming scoped events into the workspace event bus.
   *
   * **One distinct scope at a time**: the client supports subscriptions
   * to a single resource scope concurrently. Multiple calls with the
   * **same** resourceId are ref-counted — each returns an independent
   * unsubscribe; the underlying SSE scope is torn down only when the
   * last unsubscribe fires. Calling with a **different** resourceId
   * while a subscription is live throws. Widening this to multiple
   * concurrent scopes is deferred until a product requirement (e.g.
   * split-pane viewer, headless fleet-watcher) forces the design.
   *
   * @returns a disposer that decrements the ref count (and tears down
   *          the SSE scope + bridges when it reaches zero).
   */
  subscribeToResource(resourceId: ResourceId): () => void {
    if (this.activeResource) {
      if (this.activeResource.resourceId !== resourceId) {
        throw new Error(
          `SemiontApiClient already subscribed to resource ${this.activeResource.resourceId}; ` +
          `call the unsubscribe returned from the previous subscribeToResource before subscribing to ${resourceId}.`,
        );
      }
      this.activeResource.refCount++;
      return this.makeUnsubscriber();
    }

    this.actor.addChannels([...RESOURCE_SCOPED_CHANNELS], resourceId as string);

    const bridgeSubs: Subscription[] = [];
    for (const channel of RESOURCE_SCOPED_CHANNELS) {
      bridgeSubs.push(
        this.actor.on$<Record<string, unknown>>(channel).subscribe((payload) => {
          (this.eventBus.get(channel as keyof import('@semiont/core').EventMap) as { next(v: unknown): void }).next(payload);
        })
      );
    }

    this.activeResource = { resourceId, refCount: 1, bridgeSubs };
    return this.makeUnsubscriber();
  }

  private makeUnsubscriber(): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      if (!this.activeResource) return;
      this.activeResource.refCount--;
      if (this.activeResource.refCount > 0) return;
      for (const sub of this.activeResource.bridgeSubs) sub.unsubscribe();
      this.actor.removeChannels([...RESOURCE_SCOPED_CHANNELS]);
      this.activeResource = null;
    };
  }

  dispose(): void {
    if (this.activeResource) {
      for (const sub of this.activeResource.bridgeSubs) sub.unsubscribe();
      this.activeResource = null;
    }
    if (this._actor) {
      this._actor.dispose();
      this._actor = null;
    }
  }

  /**
   * Build the `Authorization: Bearer <token>` header. If the caller passed
   * an explicit `{ auth }` it wins (used by session-internal throwaway
   * clients that need to run a validation request with a specific token).
   * Otherwise the current value of `this.token$` is used, so external
   * callers never have to plumb the token themselves.
   */
  private authHeaders(options?: { auth?: AccessToken }): Record<string, string> {
    const token = options?.auth ?? this.token$.getValue() ?? undefined;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  async authenticatePassword(email: Email, password: string, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/password']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/password`, {
      json: { email, password },
      headers: this.authHeaders(options),
    }).json();
  }

  async refreshToken(token: RefreshToken, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/refresh']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/refresh`, {
      json: { refreshToken: token },
      headers: this.authHeaders(options),
    }).json();
  }

  async authenticateGoogle(credential: GoogleCredential, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/google']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/google`, {
      json: { credential },
      headers: this.authHeaders(options),
    }).json();
  }

  async generateMCPToken(options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/mcp-generate']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/mcp-generate`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async getMediaToken(resourceId: ResourceId, options?: RequestOptions): Promise<{ token: string }> {
    return this.http.post(`${this.baseUrl}/api/tokens/media`, {
      json: { resourceId },
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // USERS
  // ============================================================================

  async getMe(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/me']['get']>> {
    return this.http.get(`${this.baseUrl}/api/users/me`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async acceptTerms(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/accept-terms']['post']>> {
    return this.http.post(`${this.baseUrl}/api/users/accept-terms`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async logout(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/logout']['post']>> {
    return this.http.post(`${this.baseUrl}/api/users/logout`, {
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // RESOURCES
  // ============================================================================

  /**
   * Create a new resource with binary content support
   *
   * @param data - Resource creation data
   * @param data.name - Resource name
   * @param data.file - File object or Buffer with binary content
   * @param data.format - MIME type (e.g., 'text/markdown', 'image/png')
   * @param data.entityTypes - Optional array of entity types
   * @param data.language - Optional ISO 639-1 language code
   * @param data.creationMethod - Optional creation method
   * @param data.sourceAnnotationId - Optional source annotation ID
   * @param data.sourceResourceId - Optional source resource ID
   * @param options - Request options including auth
   */
  async yieldResource(data: {
    name: string;
    file: File | Buffer;
    format: string;
    entityTypes?: string[];
    language?: string;
    creationMethod?: string;
    sourceAnnotationId?: string;
    sourceResourceId?: string;
    storageUri: string;
  }, options?: RequestOptions): Promise<{ resourceId: string }> {
    // Build FormData
    const formData = new FormData();
    formData.append('name', data.name);
    formData.append('format', data.format);
    formData.append('storageUri', data.storageUri);

    // Handle File or Buffer
    if (data.file instanceof File) {
      formData.append('file', data.file);
    } else if (Buffer.isBuffer(data.file)) {
      // Node.js environment: convert Buffer to Blob via Uint8Array to satisfy BlobPart's ArrayBuffer constraint
      const blob = new Blob([new Uint8Array(data.file)], { type: data.format });
      formData.append('file', blob, data.name);
    } else {
      throw new Error('file must be a File or Buffer');
    }

    // Optional fields
    if (data.entityTypes && data.entityTypes.length > 0) {
      formData.append('entityTypes', JSON.stringify(data.entityTypes));
    }
    if (data.language) {
      formData.append('language', data.language);
    }
    if (data.creationMethod) {
      formData.append('creationMethod', data.creationMethod);
    }
    if (data.sourceAnnotationId) {
      formData.append('sourceAnnotationId', data.sourceAnnotationId);
    }
    if (data.sourceResourceId) {
      formData.append('sourceResourceId', data.sourceResourceId);
    }

    // POST with multipart/form-data (ky automatically sets Content-Type)
    return this.http.post(`${this.baseUrl}/resources`, {
      body: formData,
      headers: this.authHeaders(options),
    }).json();
  }

  async browseResource(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetResourceResponse']> {
    return busRequest(this.actor, 'browse:resource-requested', { resourceId: id }, 'browse:resource-result', 'browse:resource-failed');
  }

  /**
   * Get resource representation using W3C content negotiation
   * Returns raw binary content (images, PDFs, text, etc.) with content type
   *
   * @param resourceUri - Full resource URI
   * @param options - Options including Accept header for content negotiation and auth
   * @returns Object with data (ArrayBuffer) and contentType (string)
   *
   * @example
   * ```typescript
   * // Get markdown representation
   * const { data, contentType } = await client.getResourceRepresentation(rUri, { accept: 'text/markdown', auth: token });
   * const markdown = new TextDecoder().decode(data);
   *
   * // Get image representation
   * const { data, contentType } = await client.getResourceRepresentation(rUri, { accept: 'image/png', auth: token });
   * const blob = new Blob([data], { type: contentType });
   *
   * // Get PDF representation
   * const { data, contentType } = await client.getResourceRepresentation(rUri, { accept: 'application/pdf', auth: token });
   * ```
   */
  async getResourceRepresentation(
    id: ResourceId,
    options?: { accept?: ContentFormat; auth?: AccessToken }
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const response = await this.http.get(`${this.baseUrl}/resources/${id}`, {
      headers: {
        Accept: options?.accept || 'text/plain',
        ...this.authHeaders(options),
      },
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const data = await response.arrayBuffer();

    return { data, contentType };
  }

  /**
   * Get resource representation as a stream using W3C content negotiation
   * Returns streaming binary content (for large files: videos, large PDFs, etc.)
   *
   * Use this for large files to avoid loading entire content into memory.
   * The stream is consumed incrementally and the backend connection stays open
   * until the stream is fully consumed or closed.
   *
   * @param resourceUri - Full resource URI
   * @param options - Options including Accept header for content negotiation and auth
   * @returns Object with stream (ReadableStream) and contentType (string)
   *
   * @example
   * ```typescript
   * // Stream large file
   * const { stream, contentType } = await client.getResourceRepresentationStream(rUri, {
   *   accept: 'video/mp4',
   *   auth: token
   * });
   *
   * // Consume stream chunk by chunk (never loads entire file into memory)
   * for await (const chunk of stream) {
   *   // Process chunk
   *   console.log(`Received ${chunk.length} bytes`);
   * }
   *
   * // Or pipe to a file in Node.js
   * const fileStream = fs.createWriteStream('output.mp4');
   * const reader = stream.getReader();
   * while (true) {
   *   const { done, value } = await reader.read();
   *   if (done) break;
   *   fileStream.write(value);
   * }
   * ```
   */
  async getResourceRepresentationStream(
    id: ResourceId,
    options?: { accept?: ContentFormat; auth?: AccessToken }
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    const response = await this.http.get(`${this.baseUrl}/resources/${id}`, {
      headers: {
        Accept: options?.accept || 'text/plain',
        ...this.authHeaders(options),
      },
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    if (!response.body) {
      throw new Error('Response body is null - cannot create stream');
    }

    return { stream: response.body, contentType };
  }

  async browseResources(
    limit?: number,
    archived?: boolean,
    query?: SearchQuery,
    _options?: RequestOptions
  ): Promise<components['schemas']['ListResourcesResponse']> {
    return busRequest(this.actor, 'browse:resources-requested',
      { search: query, archived, limit: limit ?? 100, offset: 0 },
      'browse:resources-result', 'browse:resources-failed');
  }

  async updateResource(
    id: ResourceId,
    data: { archived?: boolean; entityTypes?: string[] },
    options?: RequestOptions
  ): Promise<void> {
    // PATCH /resources/:id stays as HTTP — it delegates to ResourceOperations
    // with complex conditional logic (archive/unarchive/entity-types)
    await this.http.patch(`${this.baseUrl}/resources/${id}`, {
      json: data,
      headers: this.authHeaders(options),
    }).text();
  }

  async getResourceEvents(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetEventsResponse']> {
    return busRequest(this.actor, 'browse:events-requested', { resourceId: id }, 'browse:events-result', 'browse:events-failed');
  }

  async browseReferences(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetReferencedByResponse']> {
    return busRequest(this.actor, 'browse:referenced-by-requested', { resourceId: id }, 'browse:referenced-by-result', 'browse:referenced-by-failed');
  }

  async generateCloneToken(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['CloneResourceWithTokenResponse']> {
    return busRequest(this.actor, 'yield:clone-token-requested', { resourceId: id }, 'yield:clone-token-generated', 'yield:clone-token-failed');
  }

  async getResourceByToken(token: CloneToken, _options?: RequestOptions): Promise<components['schemas']['GetResourceByTokenResponse']> {
    return busRequest(this.actor, 'yield:clone-resource-requested', { token }, 'yield:clone-resource-result', 'yield:clone-resource-failed');
  }

  async createResourceFromToken(
    data: { token: string; name: string; content: string; archiveOriginal?: boolean },
    _options?: RequestOptions
  ): Promise<{ resourceId: string }> {
    return busRequest(this.actor, 'yield:clone-create', data as unknown as Record<string, unknown>, 'yield:clone-created', 'yield:clone-create-failed');
  }

  // ============================================================================
  // ANNOTATIONS
  // ============================================================================

  async markAnnotation(
    id: ResourceId,
    data: components['schemas']['CreateAnnotationRequest'],
    _options?: RequestOptions
  ): Promise<{ annotationId: string }> {
    return busRequest<{ annotationId: string }>(this.actor, 'mark:create-request',
      { resourceId: id, request: data }, 'mark:create-ok', 'mark:create-failed');
  }

  async getAnnotation(id: AnnotationId, _options?: RequestOptions): Promise<components['schemas']['GetAnnotationResponse']> {
    return busRequest(this.actor, 'browse:annotation-requested', { annotationId: id }, 'browse:annotation-result', 'browse:annotation-failed');
  }

  async browseAnnotation(resourceId: ResourceId, annotationId: AnnotationId, _options?: RequestOptions): Promise<components['schemas']['GetAnnotationResponse']> {
    return busRequest(this.actor, 'browse:annotation-requested', { resourceId, annotationId }, 'browse:annotation-result', 'browse:annotation-failed');
  }

  async browseAnnotations(
    id: ResourceId,
    _motivation?: Motivation,
    _options?: RequestOptions
  ): Promise<components['schemas']['GetAnnotationsResponse']> {
    return busRequest(this.actor, 'browse:annotations-requested', { resourceId: id }, 'browse:annotations-result', 'browse:annotations-failed');
  }

  async deleteAnnotation(resourceId: ResourceId, annotationId: AnnotationId, _options?: RequestOptions): Promise<void> {
    await this.actor.emit('mark:delete', { annotationId, resourceId });
  }

  async bindAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { operations: BodyOperation[] },
    _options?: RequestOptions
  ): Promise<{ correlationId: string }> {
    const correlationId = crypto.randomUUID();
    await this.actor.emit('bind:update-body', { correlationId, annotationId, resourceId, operations: data.operations });
    return { correlationId };
  }

  async getAnnotationHistory(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    _options?: RequestOptions
  ): Promise<components['schemas']['GetAnnotationHistoryResponse']> {
    return busRequest(this.actor, 'browse:annotation-history-requested', { resourceId, annotationId }, 'browse:annotation-history-result', 'browse:annotation-history-failed');
  }

  async annotateReferences(
    resourceId: ResourceId,
    data: { entityTypes: string[]; includeDescriptiveReferences?: boolean },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'reference-annotation', resourceId, params: data }, 'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateHighlights(
    resourceId: ResourceId,
    data: { instructions?: string; density?: number },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'highlight-annotation', resourceId, params: data }, 'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateAssessments(
    resourceId: ResourceId,
    data: { instructions?: string; tone?: string; density?: number; language?: string },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'assessment-annotation', resourceId, params: data }, 'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateComments(
    resourceId: ResourceId,
    data: { instructions?: string; tone?: string; density?: number; language?: string },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'comment-annotation', resourceId, params: data }, 'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateTags(
    resourceId: ResourceId,
    data: { schemaId: string; categories: string[] },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'tag-annotation', resourceId, params: data }, 'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async yieldResourceFromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { title: string; storageUri: string; context: unknown; prompt?: string; language?: string; temperature?: number; maxTokens?: number },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.actor, 'job:create',
      { jobType: 'generation', resourceId, params: { referenceId: annotationId, ...data } },
      'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async gatherAnnotationContext(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { correlationId: string; contextWindow?: number },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    await this.actor.emit('gather:requested', {
      correlationId: data.correlationId,
      annotationId,
      resourceId,
      contextWindow: data.contextWindow ?? 2000,
    });
    return { correlationId: data.correlationId };
  }

  async matchSearch(
    resourceId: ResourceId,
    data: { correlationId: string; referenceId: string; context: unknown; limit?: number; useSemanticScoring?: boolean },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    await this.actor.emit('match:search-requested', {
      correlationId: data.correlationId,
      resourceId,
      referenceId: data.referenceId,
      context: data.context as Record<string, unknown>,
      limit: data.limit ?? 10,
      useSemanticScoring: data.useSemanticScoring ?? true,
    });
    return { correlationId: data.correlationId };
  }

  // ============================================================================
  // ENTITY TYPES
  // ============================================================================

  async addEntityType(type: EntityType, _options?: RequestOptions): Promise<void> {
    await this.actor.emit('mark:add-entity-type', { tag: type });
  }

  async addEntityTypesBulk(types: EntityType[], _options?: RequestOptions): Promise<void> {
    for (const tag of types) {
      await this.actor.emit('mark:add-entity-type', { tag });
    }
  }

  async listEntityTypes(_options?: RequestOptions): Promise<components['schemas']['GetEntityTypesResponse']> {
    return busRequest(this.actor, 'browse:entity-types-requested', {}, 'browse:entity-types-result', 'browse:entity-types-failed');
  }

  // ============================================================================
  // PARTICIPANTS
  // ============================================================================

  async beckonAttention(
    _participantId: string,
    data: { annotationId?: string; resourceId: string; message?: string },
    _options?: RequestOptions
  ): Promise<components['schemas']['BeckonResponse']> {
    await this.actor.emit('beckon:focus', data as unknown as Record<string, unknown>);
    return {} as components['schemas']['BeckonResponse'];
  }

  // ============================================================================
  // ADMIN
  // ============================================================================

  async listUsers(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async getUserStats(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users/stats']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users/stats`, {
      headers: this.authHeaders(options),
    }).json();
  }

  /**
   * Update a user by ID
   * Note: Users use DID identifiers (did:web:domain:users:id), not HTTP URIs.
   */
  async updateUser(
    id: UserDID,
    data: RequestContent<paths['/api/admin/users/{id}']['patch']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/api/admin/users/{id}']['patch']>> {
    return this.http.patch(`${this.baseUrl}/api/admin/users/${id}`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  async getOAuthConfig(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/oauth/config']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/oauth/config`, {
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // ADMIN — EXCHANGE (Backup/Restore)
  // ============================================================================

  /**
   * Create a backup of the knowledge base. Returns raw Response for streaming download.
   * Caller should use response.blob() to trigger a file download.
   */
  async backupKnowledgeBase(
    options?: RequestOptions,
  ): Promise<Response> {
    return this.http.post(`${this.baseUrl}/api/admin/exchange/backup`, {
      headers: this.authHeaders(options),
    });
  }

  /**
   * Restore knowledge base from a backup file. Parses SSE progress events and calls onProgress.
   * Returns the final SSE event (phase: 'complete' or 'error').
   */
  async restoreKnowledgeBase(
    file: File,
    options?: RequestOptions & {
      onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
    },
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.http.post(`${this.baseUrl}/api/admin/exchange/restore`, {
      body: formData,
      headers: this.authHeaders(options),
    });

    return this.parseSSEStream(response, options?.onProgress);
  }

  // ============================================================================
  // ADMIN — EXCHANGE (Linked Data Export/Import)
  // ============================================================================

  /**
   * Export the knowledge base as a JSON-LD Linked Data archive. Returns raw Response for streaming download.
   * Caller should use response.blob() to trigger a file download.
   */
  async exportKnowledgeBase(
    params?: { includeArchived?: boolean },
    options?: RequestOptions,
  ): Promise<Response> {
    const searchParams = params?.includeArchived ? new URLSearchParams({ includeArchived: 'true' }) : undefined;
    return this.http.post(`${this.baseUrl}/api/moderate/exchange/export`, {
      headers: this.authHeaders(options),
      ...(searchParams ? { searchParams } : {}),
    });
  }

  /**
   * Import a JSON-LD Linked Data archive into the knowledge base. Parses SSE progress events and calls onProgress.
   * Returns the final SSE event (phase: 'complete' or 'error').
   */
  async importKnowledgeBase(
    file: File,
    options?: RequestOptions & {
      onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
    },
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.http.post(`${this.baseUrl}/api/moderate/exchange/import`, {
      body: formData,
      headers: this.authHeaders(options),
    });

    return this.parseSSEStream(response, options?.onProgress);
  }

  private async parseSSEStream(
    response: Response,
    onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void,
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: { phase: string; message?: string; result?: Record<string, unknown> } = { phase: 'unknown' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          onProgress?.(event);
          finalResult = event;
        }
      }
    }

    return finalResult;
  }

  // ============================================================================
  // JOB STATUS
  // ============================================================================

  async getJobStatus(id: JobId, _options?: RequestOptions): Promise<components['schemas']['JobStatusResponse']> {
    return busRequest(this.actor, 'job:status-requested', { jobId: id }, 'job:status-result', 'job:status-failed');
  }

  /**
   * Poll a job until it completes or fails
   * @param id - The job ID to poll
   * @param options - Polling options
   * @returns The final job status
   */
  async pollJobUntilComplete(
    id: JobId,
    options?: {
      interval?: number; // Milliseconds between polls (default: 1000)
      timeout?: number;  // Total timeout in milliseconds (default: 60000)
      onProgress?: (status: components['schemas']['JobStatusResponse']) => void;
      auth?: AccessToken;
    }
  ): Promise<components['schemas']['JobStatusResponse']> {
    const interval = options?.interval ?? 1000;
    const timeout = options?.timeout ?? 60000;
    const startTime = Date.now();

    while (true) {
      const status = await this.getJobStatus(id, { auth: options?.auth });

      // Call progress callback if provided
      if (options?.onProgress) {
        options.onProgress(status);
      }

      // Check if job is in a terminal state
      if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
        return status;
      }

      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error(`Job polling timeout after ${timeout}ms`);
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  // ============================================================================
  // SYSTEM STATUS
  // ============================================================================

  async healthCheck(options?: RequestOptions): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.http.get(`${this.baseUrl}/api/health`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async getStatus(options?: RequestOptions): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.http.get(`${this.baseUrl}/api/status`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async browseFiles(
    dirPath?: string,
    sort?: 'name' | 'mtime' | 'annotationCount',
    _options?: RequestOptions,
  ): Promise<components['schemas']['BrowseFilesResponse']> {
    return busRequest(this.actor, 'browse:directory-requested',
      { path: dirPath ?? '.', sort: sort ?? 'name' },
      'browse:directory-result', 'browse:directory-failed');
  }
}
