/**
 * Semiont API Client
 *
 * High-level client for interacting with the Semiont backend API.
 * Handles authentication, document operations, and annotation management.
 */

import type {
  CreateDocumentRequest,
  CreateDocumentResponse,
} from './document-schemas';
import type {
  AuthResponse,
} from './user-schemas';
import type {
  GetEventsResponse,
} from './event-schemas';
import type {
  CreateAnnotationRequest as ApiCreateAnnotationRequest,
  CreateAnnotationResponse,
  ResolveAnnotationRequest as ApiResolveAnnotationRequest,
} from './annotation-schemas';
import { encodeAnnotationIdForUrl } from './annotation-schemas';
import { fetchAPI } from './http-client';

export interface SemiontClientConfig {
  backendUrl: string;
  authEmail: string;
}

/**
 * High-level client for Semiont API operations
 */
export class SemiontClient {
  private token: string | null = null;

  constructor(private config: SemiontClientConfig) {}

  /**
   * Authenticate with the backend using local development auth
   */
  async authenticate(): Promise<AuthResponse> {
    const response = await fetch(`${this.config.backendUrl}/api/tokens/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.authEmail }),
    });

    if (!response.ok) {
      throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
    }

    const authData = await response.json() as AuthResponse;
    this.token = authData.token;
    return authData;
  }

  /**
   * Get the current authentication token
   */
  getToken(): string {
    if (!this.token) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }
    return this.token;
  }

  /**
   * Create a new document
   */
  async createDocument(request: CreateDocumentRequest): Promise<CreateDocumentResponse> {
    return fetchAPI<CreateDocumentResponse>(
      '/api/documents',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      this.getToken(),
      this.config.backendUrl
    );
  }

  /**
   * Create a stub annotation (reference with source=null)
   */
  async createAnnotation(request: ApiCreateAnnotationRequest): Promise<CreateAnnotationResponse> {
    return fetchAPI<CreateAnnotationResponse>(
      '/api/annotations',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      this.getToken(),
      this.config.backendUrl
    );
  }

  /**
   * Resolve a stub annotation to point to a target document
   */
  async resolveAnnotation(
    annotationId: string,
    targetDocumentId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const encodedAnnotationId = encodeAnnotationIdForUrl(annotationId);
      const request: ApiResolveAnnotationRequest = { documentId: targetDocumentId };

      await fetchAPI(
        `/api/annotations/${encodedAnnotationId}/resolve`,
        {
          method: 'PUT',
          body: JSON.stringify(request),
        },
        this.getToken(),
        this.config.backendUrl
      );

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Get event history for a document
   */
  async getDocumentEvents(documentId: string): Promise<GetEventsResponse> {
    return fetchAPI<GetEventsResponse>(
      `/api/documents/${encodeURIComponent(documentId)}/events`,
      {},
      this.getToken(),
      this.config.backendUrl
    );
  }
}

/**
 * Batch operations helper for uploading multiple documents
 */
export async function uploadDocumentBatch(
  client: SemiontClient,
  documents: CreateDocumentRequest[]
): Promise<CreateDocumentResponse[]> {
  const results: CreateDocumentResponse[] = [];

  for (const doc of documents) {
    const result = await client.createDocument(doc);
    results.push(result);
  }

  return results;
}

/**
 * Batch operations helper for creating multiple annotations
 */
export async function createAnnotationBatch(
  client: SemiontClient,
  annotations: ApiCreateAnnotationRequest[]
): Promise<CreateAnnotationResponse[]> {
  const results: CreateAnnotationResponse[] = [];

  for (const ann of annotations) {
    const result = await client.createAnnotation(ann);
    results.push(result);
  }

  return results;
}

/**
 * Batch operations helper for resolving multiple annotations
 */
export async function resolveAnnotationBatch(
  client: SemiontClient,
  resolutions: Array<{ annotationId: string; targetDocumentId: string }>
): Promise<Array<{ annotationId: string; success: boolean; error?: string }>> {
  const results: Array<{ annotationId: string; success: boolean; error?: string }> = [];

  for (const { annotationId, targetDocumentId } of resolutions) {
    const result = await client.resolveAnnotation(annotationId, targetDocumentId);
    results.push({ annotationId, ...result });
  }

  return results;
}
