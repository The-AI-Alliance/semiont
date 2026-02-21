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

import ky, { type KyInstance } from 'ky';
import type { paths } from '@semiont/core';
import type {
  AnnotationUri,
  ResourceUri,
  ResourceAnnotationUri,
  AccessToken,
  BaseUrl,
  CloneToken,
  ContentFormat,
  Email,
  EntityType,
  GoogleCredential,
  JobId,
  Motivation,
  RefreshToken,
  SearchQuery,
  UserDID
} from '@semiont/core';
import { SSEClient } from './sse/index';
import type { Logger } from './logger';

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

export interface SemiontApiClientConfig {
  baseUrl: BaseUrl;
  timeout?: number;
  retry?: number;
  logger?: Logger;
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
  private baseUrl: BaseUrl;
  private logger?: Logger;

  /**
   * SSE streaming client for real-time operations
   *
   * Separate from the main HTTP client to clearly mark streaming endpoints.
   * Uses native fetch() instead of ky for SSE support.
   *
   * @example
   * ```typescript
   * const stream = client.sse.detectAnnotations(
   *   resourceId,
   *   { entityTypes: ['Person', 'Organization'] },
   *   { auth: accessToken }
   * );
   *
   * stream.onProgress((p) => console.log(p.message));
   * stream.onComplete((r) => console.log(`Found ${r.foundCount} entities`));
   * stream.close();
   * ```
   */
  public readonly sse: SSEClient;

  constructor(config: SemiontApiClientConfig) {
    const { baseUrl, timeout = 30000, retry = 2, logger } = config;

    // Store logger and baseUrl for constructing full URLs
    this.logger = logger;

    // Remove trailing slash for consistent URL construction
    this.baseUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) as BaseUrl;

    // Don't use prefixUrl - we'll construct full URLs or use provided full URIs
    this.http = ky.create({
      timeout,
      retry,
      hooks: {
        beforeRequest: [
          (request, options) => {
            // Add auth header from request options
            const auth = (options as any).auth;
            if (auth) {
              request.headers.set('Authorization', `Bearer ${auth}`);
            }

            // Log HTTP request
            if (this.logger) {
              this.logger.debug('HTTP Request', {
                type: 'http_request',
                url: request.url,
                method: request.method,
                timestamp: Date.now(),
                hasAuth: !!auth
              });
            }
          },
        ],
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
              const body = await response.json().catch(() => ({})) as any;

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
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  async authenticatePassword(email: Email, password: string, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/password']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/password`, {
      json: { email, password },
      ...options,
      auth: options?.auth
    } as any).json<any>();
  }

  async refreshToken(token: RefreshToken, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/refresh']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/refresh`, {
      json: { refreshToken: token },
      ...options,
      auth: options?.auth
    } as any).json<any>();
  }

  async authenticateGoogle(credential: GoogleCredential, options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/google']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/google`, {
      json: { credential },
      ...options,
      auth: options?.auth
    } as any).json<any>();
  }

  async generateMCPToken(options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/mcp-generate']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/mcp-generate`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  // ============================================================================
  // USERS
  // ============================================================================

  async getMe(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/me']['get']>> {
    return this.http.get(`${this.baseUrl}/api/users/me`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async acceptTerms(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/accept-terms']['post']>> {
    return this.http.post(`${this.baseUrl}/api/users/accept-terms`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async logout(options?: RequestOptions): Promise<ResponseContent<paths['/api/users/logout']['post']>> {
    if (options) {
      return this.http.post(`${this.baseUrl}/api/users/logout`, options as any).json();
    }
    return this.http.post(`${this.baseUrl}/api/users/logout`).json();
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
  async createResource(data: {
    name: string;
    file: File | Buffer;
    format: string;
    entityTypes?: string[];
    language?: string;
    creationMethod?: string;
    sourceAnnotationId?: string;
    sourceResourceId?: string;
  }, options?: RequestOptions): Promise<ResponseContent<paths['/resources']['post']>> {
    // Build FormData
    const formData = new FormData();
    formData.append('name', data.name);
    formData.append('format', data.format);

    // Handle File or Buffer
    if (data.file instanceof File) {
      formData.append('file', data.file);
    } else if (Buffer.isBuffer(data.file)) {
      // Node.js environment: convert Buffer to Blob
      const blob = new Blob([data.file], { type: data.format });
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
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getResource(resourceUri: ResourceUri, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}']['get']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(resourceUri, {
      ...options,
      auth: options?.auth
    } as any).json();
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
    resourceUri: ResourceUri,
    options?: { accept?: ContentFormat; auth?: AccessToken }
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    // resourceUri is already a full URI, use it directly with Accept header
    const response = await this.http.get(resourceUri, {
      headers: {
        Accept: options?.accept || 'text/plain'
      },
      auth: options?.auth
    } as any);

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
    resourceUri: ResourceUri,
    options?: { accept?: ContentFormat; auth?: AccessToken }
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    // resourceUri is already a full URI, use it directly with Accept header
    const response = await this.http.get(resourceUri, {
      headers: {
        Accept: options?.accept || 'text/plain'
      },
      auth: options?.auth
    } as any);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    if (!response.body) {
      throw new Error('Response body is null - cannot create stream');
    }

    return { stream: response.body, contentType };
  }

  async listResources(
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
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async updateResource(
    resourceUri: ResourceUri,
    data: RequestContent<paths['/resources/{id}']['patch']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{id}']['patch']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.patch(resourceUri, {
      json: data,
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getResourceEvents(resourceUri: ResourceUri, options?: RequestOptions): Promise<{ events: any[] }> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/events`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getResourceAnnotations(
    resourceUri: ResourceUri,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['get']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/annotations`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getAnnotationLLMContext(
    resourceUri: ResourceUri,
    annotationId: string,
    options?: { contextWindow?: number; auth?: AccessToken }
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/llm-context']['get']>> {
    const searchParams = new URLSearchParams();
    if (options?.contextWindow) {
      searchParams.append('contextWindow', options.contextWindow.toString());
    }
    // resourceUri is already a full URI, use it directly
    return this.http.get(
      `${resourceUri}/annotations/${annotationId}/llm-context`,
      {
        searchParams,
        auth: options?.auth
      } as any
    ).json();
  }

  async getResourceReferencedBy(resourceUri: ResourceUri, options?: RequestOptions): Promise<{ referencedBy: any[] }> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/referenced-by`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async generateCloneToken(resourceUri: ResourceUri, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{id}/clone-with-token']['post']>> {
    const id = resourceUri.split('/').pop();
    return this.http.post(`${this.baseUrl}/resources/${id}/clone-with-token`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getResourceByToken(token: CloneToken, options?: RequestOptions): Promise<ResponseContent<paths['/api/clone-tokens/{token}']['get']>> {
    return this.http.get(`${this.baseUrl}/api/clone-tokens/${token}`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async createResourceFromToken(
    data: RequestContent<paths['/api/clone-tokens/create-resource']['post']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/api/clone-tokens/create-resource']['post']>> {
    return this.http.post(`${this.baseUrl}/api/clone-tokens/create-resource`, {
      json: data,
      ...options,
      auth: options?.auth
    } as any).json();
  }

  // ============================================================================
  // ANNOTATIONS
  // ============================================================================

  async createAnnotation(
    resourceUri: ResourceUri,
    data: RequestContent<paths['/resources/{id}/annotations']['post']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['post']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.post(`${resourceUri}/annotations`, {
      json: data,
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getAnnotation(annotationUri: AnnotationUri, options?: RequestOptions): Promise<ResponseContent<paths['/annotations/{id}']['get']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.get(annotationUri, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getResourceAnnotation(annotationUri: ResourceAnnotationUri, options?: RequestOptions): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}']['get']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.get(annotationUri, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async listAnnotations(
    resourceUri: ResourceUri,
    motivation?: Motivation,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['get']>> {
    const searchParams = new URLSearchParams();
    if (motivation) searchParams.append('motivation', motivation);

    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/annotations`, {
      searchParams,
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async deleteAnnotation(annotationUri: ResourceAnnotationUri, options?: RequestOptions): Promise<void> {
    // annotationUri is already a full URI, use it directly
    await this.http.delete(annotationUri, {
      ...options,
      auth: options?.auth
    } as any);
  }

  async updateAnnotationBody(
    annotationUri: ResourceAnnotationUri,
    data: RequestContent<paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']>,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.put(`${annotationUri}/body`, {
      json: data,
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getAnnotationHistory(
    annotationUri: ResourceAnnotationUri,
    options?: RequestOptions
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/history']['get']>> {
    // annotationUri is already a full URI, use it directly
    if (options) {
      return this.http.get(`${annotationUri}/history`, options as any).json();
    }
    return this.http.get(`${annotationUri}/history`).json();
  }

  // ============================================================================
  // ENTITY TYPES
  // ============================================================================

  async addEntityType(type: EntityType, options?: RequestOptions): Promise<ResponseContent<paths['/api/entity-types']['post']>> {
    return this.http.post(`${this.baseUrl}/api/entity-types`, {
      json: { type },
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async addEntityTypesBulk(types: EntityType[], options?: RequestOptions): Promise<ResponseContent<paths['/api/entity-types/bulk']['post']>> {
    return this.http.post(`${this.baseUrl}/api/entity-types/bulk`, {
      json: { tags: types },
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async listEntityTypes(options?: RequestOptions): Promise<ResponseContent<paths['/api/entity-types']['get']>> {
    return this.http.get(`${this.baseUrl}/api/entity-types`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  // ============================================================================
  // ADMIN
  // ============================================================================

  async listUsers(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getUserStats(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users/stats']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users/stats`, {
      ...options,
      auth: options?.auth
    } as any).json();
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
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getOAuthConfig(options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/oauth/config']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/oauth/config`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  // ============================================================================
  // JOB STATUS
  // ============================================================================

  async getJobStatus(id: JobId, options?: RequestOptions): Promise<ResponseContent<paths['/api/jobs/{id}']['get']>> {
    if (options) {
      return this.http.get(`${this.baseUrl}/api/jobs/${id}`, options as any).json();
    }
    return this.http.get(`${this.baseUrl}/api/jobs/${id}`).json();
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
  // LLM CONTEXT
  // ============================================================================

  async getResourceLLMContext(
    resourceUri: ResourceUri,
    options?: {
      depth?: number;
      maxResources?: number;
      includeContent?: boolean;
      includeSummary?: boolean;
      auth?: AccessToken;
    }
  ): Promise<ResponseContent<paths['/resources/{id}/llm-context']['get']>> {
    const searchParams = new URLSearchParams();
    if (options?.depth !== undefined) searchParams.append('depth', options.depth.toString());
    if (options?.maxResources !== undefined) searchParams.append('maxResources', options.maxResources.toString());
    if (options?.includeContent !== undefined) searchParams.append('includeContent', options.includeContent.toString());
    if (options?.includeSummary !== undefined) searchParams.append('includeSummary', options.includeSummary.toString());

    return this.http.get(`${resourceUri}/llm-context`, {
      searchParams,
      auth: options?.auth
    } as any).json();
  }

  // ============================================================================
  // SYSTEM STATUS
  // ============================================================================

  async healthCheck(options?: RequestOptions): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.http.get(`${this.baseUrl}/api/health`, {
      ...options,
      auth: options?.auth
    } as any).json();
  }

  async getStatus(options?: RequestOptions): Promise<ResponseContent<paths['/api/status']['get']>> {
    if (options) {
      return this.http.get(`${this.baseUrl}/api/status`, options as any).json();
    }
    return this.http.get(`${this.baseUrl}/api/status`).json();
  }
}
