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
import type { paths } from './types';
import type { AnnotationUri, ResourceUri, ResourceAnnotationUri } from './branded-types';
import type {
  AccessToken,
  AuthCode,
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
} from './branded-types';
import { SSEClient } from './sse';

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
  accessToken?: AccessToken;
  timeout?: number;
  retry?: number;
}

/**
 * Semiont API Client
 *
 * Provides type-safe methods for all Semiont backend API endpoints.
 */
export class SemiontApiClient {
  private http: KyInstance;
  private baseUrl: BaseUrl;
  private accessToken: AccessToken | null = null;

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
   *   { entityTypes: ['Person', 'Organization'] }
   * );
   *
   * stream.onProgress((p) => console.log(p.message));
   * stream.onComplete((r) => console.log(`Found ${r.foundCount} entities`));
   * stream.close();
   * ```
   */
  public readonly sse: SSEClient;

  constructor(config: SemiontApiClientConfig) {
    const { baseUrl, accessToken, timeout = 30000, retry = 2 } = config;

    // Store baseUrl for constructing full URLs
    // Remove trailing slash for consistent URL construction
    this.baseUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) as BaseUrl;

    // Don't use prefixUrl - we'll construct full URLs or use provided full URIs
    this.http = ky.create({
      timeout,
      retry,
      hooks: {
        beforeRequest: [
          (request) => {
            if (this.accessToken) {
              request.headers.set('Authorization', `Bearer ${this.accessToken}`);
            }
          },
        ],
        beforeError: [
          async (error) => {
            const { response } = error;
            if (response) {
              const body = await response.json().catch(() => ({})) as any;
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

    if (accessToken) {
      this.accessToken = accessToken;
    }

    // Initialize SSE client (uses native fetch, not ky)
    this.sse = new SSEClient({
      baseUrl: this.baseUrl,
      accessToken: this.accessToken || undefined
    });
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: AccessToken): void {
    this.accessToken = token;
    this.sse.setAccessToken(token);
  }

  /**
   * Clear the access token
   */
  clearAccessToken(): void {
    this.accessToken = null;
    this.sse.clearAccessToken();
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  async authenticateLocal(email: Email, code: AuthCode): Promise<ResponseContent<paths['/api/tokens/local']['post']>> {
    const response = await this.http.post(`${this.baseUrl}/api/tokens/local`, { json: { email, code } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async refreshToken(token: RefreshToken): Promise<ResponseContent<paths['/api/tokens/refresh']['post']>> {
    const response = await this.http.post(`${this.baseUrl}/api/tokens/refresh`, { json: { refreshToken: token } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async authenticateGoogle(credential: GoogleCredential): Promise<ResponseContent<paths['/api/tokens/google']['post']>> {
    const response = await this.http.post(`${this.baseUrl}/api/tokens/google`, { json: { credential } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async generateMCPToken(): Promise<ResponseContent<paths['/api/tokens/mcp-generate']['post']>> {
    return this.http.post(`${this.baseUrl}/api/tokens/mcp-generate`).json();
  }

  // ============================================================================
  // USERS
  // ============================================================================

  async getMe(): Promise<ResponseContent<paths['/api/users/me']['get']>> {
    return this.http.get(`${this.baseUrl}/api/users/me`).json();
  }

  async acceptTerms(): Promise<ResponseContent<paths['/api/users/accept-terms']['post']>> {
    return this.http.post(`${this.baseUrl}/api/users/accept-terms`).json();
  }

  async logout(): Promise<ResponseContent<paths['/api/users/logout']['post']>> {
    return this.http.post(`${this.baseUrl}/api/users/logout`).json();
  }

  // ============================================================================
  // RESOURCES
  // ============================================================================

  async createResource(
    data: RequestContent<paths['/resources']['post']>
  ): Promise<ResponseContent<paths['/resources']['post']>> {
    return this.http.post(`${this.baseUrl}/resources`, { json: data }).json();
  }

  async getResource(resourceUri: ResourceUri): Promise<ResponseContent<paths['/resources/{id}']['get']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(resourceUri).json();
  }

  /**
   * Get resource representation using W3C content negotiation
   * Returns raw response body (text) instead of JSON metadata
   *
   * @param resourceUri - Full resource URI
   * @param options - Options including Accept header for content negotiation
   * @returns Raw text representation of the resource
   *
   * @example
   * ```typescript
   * // Get markdown representation
   * const markdown = await client.getResourceRepresentation(rUri, { accept: 'text/markdown' });
   *
   * // Get plain text representation
   * const text = await client.getResourceRepresentation(rUri, { accept: 'text/plain' });
   * ```
   */
  async getResourceRepresentation(
    resourceUri: ResourceUri,
    options?: { accept?: ContentFormat }
  ): Promise<string> {
    // resourceUri is already a full URI, use it directly with Accept header
    return this.http.get(resourceUri, {
      headers: {
        Accept: options?.accept || 'text/plain'
      }
    }).text();
  }

  async listResources(
    limit?: number,
    archived?: boolean,
    query?: SearchQuery
  ): Promise<ResponseContent<paths['/resources']['get']>> {
    const searchParams = new URLSearchParams();
    if (limit) searchParams.append('limit', limit.toString());
    if (archived !== undefined) searchParams.append('archived', archived.toString());
    if (query) searchParams.append('q', query);

    return this.http.get(`${this.baseUrl}/resources`, { searchParams }).json();
  }

  async updateResource(
    resourceUri: ResourceUri,
    data: RequestContent<paths['/resources/{id}']['patch']>
  ): Promise<ResponseContent<paths['/resources/{id}']['patch']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.patch(resourceUri, { json: data }).json();
  }

  async getResourceEvents(resourceUri: ResourceUri): Promise<{ events: any[] }> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/events`).json();
  }

  async getResourceAnnotations(
    resourceUri: ResourceUri
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['get']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/annotations`).json();
  }

  async getResourceReferencedBy(resourceUri: ResourceUri): Promise<{ referencedBy: any[] }> {
    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/referenced-by`).json();
  }

  async generateCloneToken(resourceUri: ResourceUri): Promise<ResponseContent<paths['/resources/{id}/clone-with-token']['post']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.post(`${resourceUri}/clone-with-token`).json();
  }

  async getResourceByToken(token: CloneToken): Promise<ResponseContent<paths['/api/resources/token/{token}']['get']>> {
    return this.http.get(`${this.baseUrl}/api/resources/token/${token}`).json();
  }

  async createResourceFromToken(
    data: RequestContent<paths['/api/resources/create-from-token']['post']>
  ): Promise<ResponseContent<paths['/api/resources/create-from-token']['post']>> {
    return this.http.post(`${this.baseUrl}/api/resources/create-from-token`, { json: data }).json();
  }

  // ============================================================================
  // ANNOTATIONS
  // ============================================================================

  async createAnnotation(
    resourceUri: ResourceUri,
    data: RequestContent<paths['/resources/{id}/annotations']['post']>
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['post']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.post(`${resourceUri}/annotations`, { json: data }).json();
  }

  async getAnnotation(annotationUri: AnnotationUri): Promise<ResponseContent<paths['/annotations/{id}']['get']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.get(annotationUri).json();
  }

  async getResourceAnnotation(annotationUri: ResourceAnnotationUri): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}']['get']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.get(annotationUri).json();
  }

  async listAnnotations(
    resourceUri: ResourceUri,
    motivation?: Motivation
  ): Promise<ResponseContent<paths['/resources/{id}/annotations']['get']>> {
    const searchParams = new URLSearchParams();
    if (motivation) searchParams.append('motivation', motivation);

    // resourceUri is already a full URI, use it directly
    return this.http.get(`${resourceUri}/annotations`, { searchParams }).json();
  }

  async deleteAnnotation(annotationUri: ResourceAnnotationUri): Promise<void> {
    // annotationUri is already a full URI, use it directly
    await this.http.delete(annotationUri);
  }

  async updateAnnotationBody(
    annotationUri: ResourceAnnotationUri,
    data: RequestContent<paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']>
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/body']['put']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.put(`${annotationUri}/body`, {
      json: data,
    }).json();
  }

  async generateResourceFromAnnotation(
    annotationUri: ResourceAnnotationUri,
    data: RequestContent<paths['/resources/{resourceId}/annotations/{annotationId}/generate-resource']['post']>
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/generate-resource']['post']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.post(`${annotationUri}/generate-resource`, { json: data }).json();
  }

  async getAnnotationHistory(
    annotationUri: ResourceAnnotationUri
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/history']['get']>> {
    // annotationUri is already a full URI, use it directly
    return this.http.get(`${annotationUri}/history`).json();
  }

  // ============================================================================
  // ENTITY TYPES
  // ============================================================================

  async addEntityType(type: EntityType): Promise<ResponseContent<paths['/api/entity-types']['post']>> {
    return this.http.post(`${this.baseUrl}/api/entity-types`, { json: { type } }).json();
  }

  async addEntityTypesBulk(types: EntityType[]): Promise<ResponseContent<paths['/api/entity-types/bulk']['post']>> {
    return this.http.post(`${this.baseUrl}/api/entity-types/bulk`, { json: { tags: types } }).json();
  }

  async listEntityTypes(): Promise<ResponseContent<paths['/api/entity-types']['get']>> {
    return this.http.get(`${this.baseUrl}/api/entity-types`).json();
  }

  // ============================================================================
  // ADMIN
  // ============================================================================

  async listUsers(): Promise<ResponseContent<paths['/api/admin/users']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users`).json();
  }

  async getUserStats(): Promise<ResponseContent<paths['/api/admin/users/stats']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/users/stats`).json();
  }

  /**
   * Update a user by ID
   * Note: Users use DID identifiers (did:web:domain:users:id), not HTTP URIs.
   */
  async updateUser(
    id: UserDID,
    data: RequestContent<paths['/api/admin/users/{id}']['patch']>
  ): Promise<ResponseContent<paths['/api/admin/users/{id}']['patch']>> {
    return this.http.patch(`${this.baseUrl}/api/admin/users/${id}`, { json: data }).json();
  }

  async getOAuthConfig(): Promise<ResponseContent<paths['/api/admin/oauth/config']['get']>> {
    return this.http.get(`${this.baseUrl}/api/admin/oauth/config`).json();
  }

  // ============================================================================
  // ENTITY DETECTION (ASYNC JOBS)
  // ============================================================================

  async detectEntities(
    resourceUri: ResourceUri,
    entityTypes?: EntityType[]
  ): Promise<ResponseContent<paths['/resources/{id}/detect-entities']['post']>> {
    // resourceUri is already a full URI, use it directly
    return this.http.post(`${resourceUri}/detect-entities`, {
      json: entityTypes ? { entityTypes } : {},
    }).json();
  }

  async getJobStatus(id: JobId): Promise<ResponseContent<paths['/api/jobs/{id}']['get']>> {
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
    }
  ): Promise<ResponseContent<paths['/api/jobs/{id}']['get']>> {
    const interval = options?.interval ?? 1000;
    const timeout = options?.timeout ?? 60000;
    const startTime = Date.now();

    while (true) {
      const status = await this.getJobStatus(id);

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
    }
  ): Promise<ResponseContent<paths['/resources/{id}/llm-context']['get']>> {
    const searchParams = new URLSearchParams();
    if (options?.depth !== undefined) searchParams.append('depth', options.depth.toString());
    if (options?.maxResources !== undefined) searchParams.append('maxResources', options.maxResources.toString());
    if (options?.includeContent !== undefined) searchParams.append('includeContent', options.includeContent.toString());
    if (options?.includeSummary !== undefined) searchParams.append('includeSummary', options.includeSummary.toString());

    return this.http.get(`${resourceUri}/llm-context`, { searchParams }).json();
  }

  async getAnnotationLLMContext(
    annotationUri: ResourceAnnotationUri,
    options?: {
      includeSourceContext?: boolean;
      includeTargetContext?: boolean;
      contextWindow?: number;
    }
  ): Promise<ResponseContent<paths['/resources/{resourceId}/annotations/{annotationId}/llm-context']['get']>> {
    const searchParams = new URLSearchParams();
    if (options?.includeSourceContext !== undefined) searchParams.append('includeSourceContext', options.includeSourceContext.toString());
    if (options?.includeTargetContext !== undefined) searchParams.append('includeTargetContext', options.includeTargetContext.toString());
    if (options?.contextWindow !== undefined) searchParams.append('contextWindow', options.contextWindow.toString());

    return this.http.get(`${annotationUri}/llm-context`, { searchParams }).json();
  }

  // ============================================================================
  // SYSTEM STATUS
  // ============================================================================

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.http.get(`${this.baseUrl}/api/health`).json();
  }

  async getStatus(): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.http.get(`${this.baseUrl}/api/status`).json();
  }
}
