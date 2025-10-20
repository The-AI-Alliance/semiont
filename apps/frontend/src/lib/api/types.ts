/**
 * Type exports from @semiont/api-client for frontend use
 *
 * This file extracts and re-exports types from the generated OpenAPI client
 * to make them easier to use in the frontend code.
 *
 * Note: Hono OpenAPI inlines all schemas, so we extract types from response/request bodies
 */

import type { paths } from '@semiont/api-client';

// Helper type to extract response content
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

// Document types - extract from list response
export type Document = ResponseContent<paths['/api/documents']['get']>['documents'][number];
export type CreateDocumentRequest = RequestContent<paths['/api/documents']['post']>;
export type CreateDocumentResponse = paths['/api/documents']['post']['responses'][201]['content']['application/json'];
export type UpdateDocumentRequest = RequestContent<paths['/api/documents/{id}']['patch']>;
export type GetDocumentResponse = paths['/api/documents/{id}']['get']['responses'][200]['content']['application/json'];
export type ListDocumentsResponse = ResponseContent<paths['/api/documents']['get']>;
export type DocumentListResponse = ListDocumentsResponse; // Alias
export type GetAnnotationsResponse = paths['/api/documents/{id}/annotations']['get']['responses'][200]['content']['application/json'];
export type ReferencedBy = paths['/api/documents/{id}/referenced-by']['get']['responses'][200]['content']['application/json']['referencedBy'][number];
export type GetDocumentByTokenResponse = paths['/api/documents/token/{token}']['get']['responses'][200]['content']['application/json'];
export type CreateDocumentFromTokenRequest = RequestContent<paths['/api/documents/create-from-token']['post']>;
export type CreateDocumentFromTokenResponse = paths['/api/documents/create-from-token']['post']['responses'][201]['content']['application/json'];
export type CloneDocumentWithTokenResponse = paths['/api/documents/{id}/clone-with-token']['post']['responses'][200]['content']['application/json'];

// Annotation types - extract from list response
export type Annotation = ResponseContent<paths['/api/annotations']['get']>['annotations'][number];
export type CreateAnnotationRequest = RequestContent<paths['/api/annotations']['post']>;
export type CreateAnnotationResponse = paths['/api/annotations']['post']['responses'][201]['content']['application/json'];
export type DeleteAnnotationRequest = { documentId: string }; // For query param
export type DeleteAnnotationResponse = { success: boolean }; // 204 no content
export type ResolveAnnotationResponse = paths['/api/annotations/{id}/resolve']['put']['responses'][200]['content']['application/json'];
export type GenerateDocumentFromAnnotationRequest = RequestContent<paths['/api/annotations/{id}/generate-document']['post']>;
export type GenerateDocumentFromAnnotationResponse = paths['/api/annotations/{id}/generate-document']['post']['responses'][201]['content']['application/json'];
export type AnnotationListResponse = ResponseContent<paths['/api/annotations']['get']>;

// Annotation subtypes (these are the same as Annotation, but with more specific types)
export type HighlightAnnotation = Annotation & { motivation: 'highlighting' };
export type ReferenceAnnotation = Annotation & { motivation: 'linking' };
export type AnnotationUpdate = Partial<CreateAnnotationRequest>;
export type TextSelection = { exact: string; start: number; end: number };

// Admin types
export type AdminUser = ResponseContent<paths['/api/admin/users']['get']>['users'][number];
export type AdminUsersResponse = ResponseContent<paths['/api/admin/users']['get']>;
export type AdminUserStatsResponse = ResponseContent<paths['/api/admin/users/stats']['get']>;
export type UpdateUserRequest = RequestContent<paths['/api/admin/users/{id}']['patch']>;

// Auth types
export type OAuthProvider = ResponseContent<paths['/api/admin/oauth/config']['get']>['providers'][number];
export type OAuthConfigResponse = ResponseContent<paths['/api/admin/oauth/config']['get']>;
export type AcceptTermsResponse = ResponseContent<paths['/api/users/accept-terms']['post']>;

// Entity Types
export type AddEntityTypeResponse = paths['/api/entity-types']['post']['responses'][200]['content']['application/json'];

// API Error (we'll need to create this ourselves since it's not in OpenAPI)
export class APIError extends Error {
  public status: number;
  public statusText: string;
  public details: unknown;
  public data: unknown; // For test compatibility

  constructor(
    message: string,
    status: number = 500,
    statusText: string = 'Internal Server Error',
    details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
    this.data = details; // Alias for tests
  }
}
