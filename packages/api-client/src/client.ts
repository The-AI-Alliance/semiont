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
import type { paths } from '@semiont/core';
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
import { SSEClient } from './sse/index';
import { FlowEngine } from './flows';
import { ResourceStore } from './stores/resource-store';
import { AnnotationStore } from './stores/annotation-store';
import type { Logger } from '@semiont/core';

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
   * SSE streaming client for real-time operations
   *
   * Separate from the main HTTP client to clearly mark streaming endpoints.
   * Uses native fetch() instead of ky for SSE support.
   */
  public readonly sse: SSEClient;

  /**
   * Framework-agnostic flow orchestration.
   * Each method returns a Subscription; call .unsubscribe() to tear down.
   */
  public readonly flows: FlowEngine;

  /**
   * Per-workspace observable stores for entity data.
   * Call stores.resources.setTokenGetter() / stores.annotations.setTokenGetter()
   * from the React layer when the auth token changes.
   */
  public readonly stores: {
    resources: ResourceStore;
    annotations: AnnotationStore;
  };

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

    // Initialize SSE client (uses native fetch, not ky)
    this.sse = new SSEClient({
      baseUrl: this.baseUrl,
      logger: this.logger
    });

    // Flow engine — pure RxJS orchestration, no React imports
    this.flows = new FlowEngine(this.eventBus, this.sse, this);

    // Observable stores — EventBus-reactive caches for entity data
    this.stores = {
      resources: new ResourceStore(this, this.eventBus),
      annotations: new AnnotationStore(this, this.eventBus),
    };
  }

  private authHeaders(options?: { auth?: AccessToken }): Record<string, string> {
    return options?.auth ? { Authorization: `Bearer ${options.auth}` } : {};
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

  async browseResource(id: ResourceId, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}']['get']>> {
    return this.http.get(`${this.baseUrl}/resources/${id}`, {
      headers: this.authHeaders(options),
    }).json();
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
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources']['get']>> {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.append('limit', limit.toString());
    if (archived !== undefined) searchParams.append('archived', archived.toString());
    if (query) searchParams.append('q', query);

    return this.http.get(`${this.baseUrl}/resources`, {
      searchParams,
      headers: this.authHeaders(options),
    }).json();
  }

  async updateResource(
    id: ResourceId,
    data: RequestContent<paths['/resources/{id}']['patch']>,
    options?: RequestOptions
  ): Promise<void> {
    await this.http.patch(`${this.baseUrl}/resources/${id}`, {
      json: data,
      headers: this.authHeaders(options),
    }).text();
  }

  async getResourceEvents(id: ResourceId, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}/events']['get']>> {
    return this.http.get(`${this.baseUrl}/resources/${id}/events`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async browseReferences(id: ResourceId, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}/referenced-by']['get']>> {
    return this.http.get(`${this.baseUrl}/resources/${id}/referenced-by`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async generateCloneToken(id: ResourceId, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}/clone-with-token']['post']>> {
    return this.http.post(`${this.baseUrl}/resources/${id}/clone-with-token`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async getResourceByToken(token: CloneToken, options?: RequestOptions): Promise<ResponseContent<paths['/api/clone-tokens/{token}']['get']>> {
    return this.http.get(`${this.baseUrl}/api/clone-tokens/${token}`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async createResourceFromToken(
    data: RequestContent<paths['/api/clone-tokens/create-resource']['post']>,
    options?: RequestOptions
  ): Promise<{ resourceId: string }> {
    return this.http.post(`${this.baseUrl}/api/clone-tokens/create-resource`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // ANNOTATIONS
  // ============================================================================

  async markAnnotation(
    id: ResourceId,
    data: RequestContent<paths['/resources/{id}/annotations']['post']>,
    options?: RequestOptions
  ): Promise<{ annotationId: string }> {
    return this.http.post(`${this.baseUrl}/resources/${id}/annotations`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  async getAnnotation(id: AnnotationId, options?: RequestOptions): Promise<ResponseContent<paths['/annotations/{id}']['get']>> {
    return this.http.get(`${this.baseUrl}/annotations/${id}`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async browseAnnotation(resourceId: ResourceId, annotationId: AnnotationId, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}']['get']>> {
    return this.http.get(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async browseAnnotations(
    id: ResourceId,
    motivation?: Motivation,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['get']>> {
    const searchParams = new URLSearchParams();
    if (motivation) searchParams.append('motivation', motivation);

    return this.http.get(`${this.baseUrl}/resources/${id}/annotations`, {
      searchParams,
      headers: this.authHeaders(options),
    }).json();
  }

  async deleteAnnotation(resourceId: ResourceId, annotationId: AnnotationId, options?: RequestOptions): Promise<void> {
    await this.http.delete(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}`, {
      headers: this.authHeaders(options),
    });
  }

  async bindAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { operations: BodyOperation[] },
    options?: RequestOptions
  ): Promise<{ correlationId: string }> {
    return this.http.post(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}/bind`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  async getAnnotationHistory(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/history']['get']>> {
    return this.http.get(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}/history`, {
      headers: this.authHeaders(options),
    }).json();
  }

  async yieldResourceFromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { title: string; storageUri: string; context: unknown; prompt?: string; language?: string; temperature?: number; maxTokens?: number },
    options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    return this.http.post(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}/yield-resource`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  async gatherAnnotationContext(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { correlationId: string; contextWindow?: number },
    options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    return this.http.post(`${this.baseUrl}/resources/${resourceId}/annotations/${annotationId}/gather`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  async matchSearch(
    resourceId: ResourceId,
    data: { correlationId: string; referenceId: string; context: unknown; limit?: number; useSemanticScoring?: boolean },
    options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    return this.http.post(`${this.baseUrl}/resources/${resourceId}/match-search`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // ENTITY TYPES
  // ============================================================================

  async addEntityType(type: EntityType, options?: RequestOptions): Promise<void> {
    await this.http.post(`${this.baseUrl}/api/entity-types`, {
      json: { tag: type },
      headers: this.authHeaders(options),
    });
  }

  async addEntityTypesBulk(types: EntityType[], options?: RequestOptions): Promise<void> {
    await this.http.post(`${this.baseUrl}/api/entity-types/bulk`, {
      json: { tags: types },
      headers: this.authHeaders(options),
    });
  }

  async listEntityTypes(options?: RequestOptions): Promise<ResponseContent<paths['/api/entity-types']['get']>> {
    return this.http.get(`${this.baseUrl}/api/entity-types`, {
      headers: this.authHeaders(options),
    }).json();
  }

  // ============================================================================
  // PARTICIPANTS
  // ============================================================================

  async beckonAttention(
    participantId: string,
    data: RequestContent<paths['/api/participants/{id}/attention']['post']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/api/participants/{id}/attention']['post']>> {
    return this.http.post(`${this.baseUrl}/api/participants/${participantId}/attention`, {
      json: data,
      headers: this.authHeaders(options),
    }).json();
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

  async getJobStatus(id: JobId, options?: RequestOptions): Promise<ResponseContent<paths['/api/jobs/{id}']['get']>> {
    return this.http.get(`${this.baseUrl}/api/jobs/${id}`, {
      headers: this.authHeaders(options),
    }).json();
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
      onProgress?: (status: ResponseContent<paths['/api/jobs/{id}']['get']>) => void;
      auth?: AccessToken;
    }
  ): Promise<ResponseContent<paths['/api/jobs/{id}']['get']>> {
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
    options?: RequestOptions,
  ): Promise<ResponseContent<paths['/api/browse/files']['get']>> {
    const searchParams = new URLSearchParams();
    if (dirPath) searchParams.append('path', dirPath);
    if (sort)    searchParams.append('sort', sort);
    return this.http.get(`${this.baseUrl}/api/browse/files`, {
      searchParams,
      headers: this.authHeaders(options),
    }).json();
  }
}
