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
  baseUrl: string;
  accessToken?: string;
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
  private accessToken: string | null = null;

  constructor(config: SemiontApiClientConfig) {
    const { baseUrl, accessToken, timeout = 30000, retry = 2 } = config;

    this.http = ky.create({
      prefixUrl: baseUrl,
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
  }

  /**
   * Set the access token for authenticated requests
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Clear the access token
   */
  clearAccessToken(): void {
    this.accessToken = null;
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  async authenticateLocal(email: string, code: string): Promise<ResponseContent<paths['/api/tokens/local']['post']>> {
    const response = await this.http.post('api/tokens/local', { json: { email, code } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async refreshToken(refreshToken: string): Promise<ResponseContent<paths['/api/tokens/refresh']['post']>> {
    const response = await this.http.post('api/tokens/refresh', { json: { refreshToken } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async authenticateGoogle(credential: string): Promise<ResponseContent<paths['/api/tokens/google']['post']>> {
    const response = await this.http.post('api/tokens/google', { json: { credential } }).json<any>();
    if (response.accessToken) {
      this.setAccessToken(response.accessToken);
    }
    return response;
  }

  async generateMCPToken(): Promise<ResponseContent<paths['/api/tokens/mcp-generate']['post']>> {
    return this.http.post('api/tokens/mcp-generate').json();
  }

  // ============================================================================
  // DOCUMENTS
  // ============================================================================

  async createDocument(
    data: RequestContent<paths['/api/documents']['post']>
  ): Promise<ResponseContent<paths['/api/documents']['post']>> {
    return this.http.post('api/documents', { json: data }).json();
  }

  async getDocument(id: string): Promise<ResponseContent<paths['/api/documents/{id}']['get']>> {
    return this.http.get(`api/documents/${id}`).json();
  }

  async listDocuments(params?: {
    limit?: number;
    archived?: boolean;
  }): Promise<ResponseContent<paths['/api/documents']['get']>> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.archived !== undefined) searchParams.append('archived', params.archived.toString());

    return this.http.get('api/documents', { searchParams }).json();
  }

  async updateDocument(
    id: string,
    data: RequestContent<paths['/api/documents/{id}']['patch']>
  ): Promise<ResponseContent<paths['/api/documents/{id}']['patch']>> {
    return this.http.patch(`api/documents/${id}`, { json: data }).json();
  }

  async deleteDocument(id: string): Promise<void> {
    await this.http.delete(`api/documents/${id}`);
  }

  async searchDocuments(query: string, limit: number = 10): Promise<{ documents: any[] }> {
    return this.http.get('api/documents/search', {
      searchParams: { q: query, limit: limit.toString() },
    }).json();
  }

  async getDocumentEvents(id: string): Promise<{ events: any[] }> {
    return this.http.get(`api/documents/${id}/events`).json();
  }

  async getDocumentAnnotations(
    id: string
  ): Promise<ResponseContent<paths['/api/documents/{id}/annotations']['get']>> {
    return this.http.get(`api/documents/${id}/annotations`).json();
  }

  async getDocumentReferencedBy(id: string): Promise<{ referencedBy: any[] }> {
    return this.http.get(`api/documents/${id}/referenced-by`).json();
  }

  // ============================================================================
  // ANNOTATIONS
  // ============================================================================

  async createAnnotation(
    data: RequestContent<paths['/api/annotations']['post']>
  ): Promise<ResponseContent<paths['/api/annotations']['post']>> {
    return this.http.post('api/annotations', { json: data }).json();
  }

  async getAnnotation(id: string): Promise<ResponseContent<paths['/api/annotations/{id}']['get']>> {
    return this.http.get(`api/annotations/${id}`).json();
  }

  async listAnnotations(params?: {
    documentId?: string;
    motivation?: string;
  }): Promise<ResponseContent<paths['/api/annotations']['get']>> {
    const searchParams = new URLSearchParams();
    if (params?.documentId) searchParams.append('documentId', params.documentId);
    if (params?.motivation) searchParams.append('motivation', params.motivation);

    return this.http.get('api/annotations', { searchParams }).json();
  }

  async deleteAnnotation(id: string, documentId: string): Promise<void> {
    await this.http.delete(`api/annotations/${id}`, {
      searchParams: { documentId },
    });
  }

  async updateAnnotationBody(
    id: string,
    data: RequestContent<paths['/api/annotations/{id}/body']['put']>
  ): Promise<ResponseContent<paths['/api/annotations/{id}/body']['put']>> {
    return this.http.put(`api/annotations/${id}/body`, {
      json: data,
    }).json();
  }

  async generateDocumentFromAnnotation(
    id: string,
    data: RequestContent<paths['/api/annotations/{id}/generate-document']['post']>
  ): Promise<ResponseContent<paths['/api/annotations/{id}/generate-document']['post']>> {
    return this.http.post(`api/annotations/${id}/generate-document`, { json: data }).json();
  }

  // ============================================================================
  // ENTITY TYPES
  // ============================================================================

  async addEntityType(type: string): Promise<ResponseContent<paths['/api/entity-types']['post']>> {
    return this.http.post('api/entity-types', { json: { type } }).json();
  }

  async listEntityTypes(): Promise<ResponseContent<paths['/api/entity-types']['get']>> {
    return this.http.get('api/entity-types').json();
  }

  // ============================================================================
  // ADMIN
  // ============================================================================

  async listUsers(): Promise<ResponseContent<paths['/api/admin/users']['get']>> {
    return this.http.get('api/admin/users').json();
  }

  async getUserStats(): Promise<ResponseContent<paths['/api/admin/users/stats']['get']>> {
    return this.http.get('api/admin/users/stats').json();
  }

  async updateUser(
    id: string,
    data: RequestContent<paths['/api/admin/users/{id}']['patch']>
  ): Promise<ResponseContent<paths['/api/admin/users/{id}']['patch']>> {
    return this.http.patch(`api/admin/users/${id}`, { json: data }).json();
  }

  // ============================================================================
  // HEALTH
  // ============================================================================

  async healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.http.get('api/health').json();
  }
}
