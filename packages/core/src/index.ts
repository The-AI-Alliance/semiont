/**
 * @semiont/core
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * Types are re-exported from @semiont/api-client (generated from OpenAPI spec).
 * This package adds Zod schemas for runtime validation and utility functions.
 */

// Re-export OpenAPI-generated types as the single source of truth
export type { components, paths, operations } from '@semiont/api-client';

// Re-export common schema types for convenience
import type { components } from '@semiont/api-client';
export type Document = components['schemas']['Document'];
export type Annotation = components['schemas']['Annotation'];
export type ContentFormat = components['schemas']['ContentFormat'];

// Document input/filter types
export type {
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
} from './document-schemas';

// Creation methods
export { CREATION_METHODS } from './creation-methods';
export type { CreationMethod } from './creation-methods';

// Graph types
export type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from './graph';

// Event types
export type {
  BaseEvent,
  DocumentEvent,
  DocumentEventType,
  DocumentCreatedEvent,
  DocumentClonedEvent,
  DocumentArchivedEvent,
  DocumentUnarchivedEvent,
  HighlightAddedEvent,
  HighlightRemovedEvent,
  ReferenceCreatedEvent,
  ReferenceResolvedEvent,
  ReferenceDeletedEvent,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
  EventMetadata,
  EventSignature,
  StoredEvent,
  EventQuery,
  DocumentAnnotations,
} from './events';
export {
  isDocumentEvent,
  getEventType,
} from './events';

// Event Zod schemas
export {
  DocumentCreatedPayloadSchema,
  DocumentClonedPayloadSchema,
  DocumentArchivedPayloadSchema,
  DocumentUnarchivedPayloadSchema,
  HighlightAddedPayloadSchema,
  HighlightRemovedPayloadSchema,
  ReferenceCreatedPayloadSchema,
  ReferenceResolvedPayloadSchema,
  ReferenceDeletedPayloadSchema,
  EntityTagAddedPayloadSchema,
  EntityTagRemovedPayloadSchema,
  EventPayloadSchema,
  EventMetadataSchema,
  BaseEventSchema,
  StoredEventSchema,
  StoredEventApiSchema,
  EventQuerySchema,
} from './event-schemas';

// Document schema (Zod schemas for validation - types come from OpenAPI)
export {
  DocumentSchema,
  ContentFormatSchema,
} from './document-schemas';
// Note: Document and ContentFormat types are re-exported from @semiont/api-client above

// Annotation schema (Zod schemas for validation - types come from OpenAPI)
export {
  AnnotationSchema,
  MotivationSchema,
  AgentSchema,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  SelectorSchema,
} from './annotation-schemas';
export type {
  // Note: Annotation type is re-exported from @semiont/api-client above
  HighlightAnnotation,
  ReferenceAnnotation,
  AnnotationUpdate,
  AnnotationCategory,
  Motivation,
  Agent,
  TextPositionSelector,
  TextQuoteSelector,
  Selector,
} from './annotation-schemas';
export {
  getAnnotationCategory,
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  extractAnnotationId,
  compareAnnotationIds,
  isFullAnnotationUri,
  getAnnotationApiId,
  encodeAnnotationIdForUrl,
} from './annotation-schemas';

// Selector utilities
export {
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextPositionSelector,
  getTextQuoteSelector,
} from './selector-utils';

// Status schemas and types
export {
  StatusResponseSchema,
  HealthResponseSchema,
  ErrorResponseSchema,
} from './status-schemas';
export type {
  StatusResponse,
  HealthResponse,
  ErrorResponse,
} from './status-schemas';

// Auth schemas and types
export {
  GoogleAuthRequestSchema,
} from './auth-schemas';
export type {
  GoogleAuthRequest,
} from './auth-schemas';

// User schemas and types
export {
  AuthResponseSchema,
  UserResponseSchema,
  UserListResponseSchema,
  UserStatsResponseSchema,
  UpdateUserRequestSchema,
} from './user-schemas';
export type {
  AuthResponse,
  UserResponse,
  UserListResponse,
  UserStatsResponse,
  UpdateUserRequest,
} from './user-schemas';

// Annotation API schemas
export {
  CreateAnnotationRequestSchema,
  CreateAnnotationInternalSchema,
  CreateAnnotationResponseSchema,
  GetHighlightsResponseSchema,
  GetReferencesResponseSchema,
  GetAnnotationsResponseSchema,
  DeleteAnnotationRequestSchema,
  DeleteAnnotationResponseSchema,
  GetAnnotationResponseSchema,
  ListAnnotationsResponseSchema,
  DetectAnnotationsResponseSchema,
  ResolveAnnotationRequestSchema,
  ResolveAnnotationResponseSchema,
  AnnotationContextResponseSchema,
  ReferencedBySchema,
  GetReferencedByResponseSchema,
  ReferenceLLMContextResponseSchema,
} from './annotation-schemas';

// Document API schemas
export {
  CreateDocumentRequestSchema,
  CreateDocumentResponseSchema,
  UpdateDocumentRequestSchema,
  GetDocumentResponseSchema,
  ListDocumentsResponseSchema,
  GenerateDocumentFromAnnotationRequestSchema,
  GenerateDocumentFromAnnotationResponseSchema,
  CreateDocumentFromSelectionResponseSchema,
  GetDocumentByTokenResponseSchema,
  CreateDocumentFromTokenRequestSchema,
  CreateDocumentFromTokenResponseSchema,
  CloneDocumentWithTokenResponseSchema,
  DocumentLLMContextResponseSchema,
} from './document-schemas';

// User/Admin API schemas
export {
  AdminUserSchema,
  AdminUsersResponseSchema,
  AdminUserStatsResponseSchema,
  UpdateUserResponseSchema,
  DeleteUserResponseSchema,
} from './user-schemas';

// Auth API schemas
export {
  OAuthProviderSchema,
  OAuthConfigResponseSchema,
  AcceptTermsResponseSchema,
  TokenRefreshResponseSchema,
  MCPGenerateResponseSchema,
  LogoutResponseSchema,
  OAuthConfigResponseSchemaActual,
} from './auth-schemas';

// Type schemas
export {
  AddEntityTypeResponseSchema,
} from './type-schemas';

// Discovery schemas
export {
  DiscoverContextResponseSchema,
  ContextualSummaryResponseSchema,
} from './discovery-schemas';

// Event schemas
export {
  GetEventsResponseSchema,
} from './event-schemas';
// Annotation API types
export type {
  CreateAnnotationRequest,
  CreateAnnotationInternal,
  CreateAnnotationResponse,
  TextSelection,
  GetHighlightsResponse,
  GetReferencesResponse,
  GetAnnotationsResponse,
  DeleteAnnotationRequest,
  DeleteAnnotationResponse,
  GetAnnotationResponse,
  ListAnnotationsResponse,
  DetectAnnotationsResponse,
  ResolveAnnotationRequest,
  ResolveAnnotationResponse,
  AnnotationContextResponse,
  ReferencedBy,
  GetReferencedByResponse,
  ReferenceLLMContextResponse,
} from './annotation-schemas';

// Document API types
export type {
  CreateDocumentRequest,
  CreateDocumentResponse,
  UpdateDocumentRequest,
  GetDocumentResponse,
  ListDocumentsResponse,
  GenerateDocumentFromAnnotationRequest,
  GenerateDocumentFromAnnotationResponse,
  CreateDocumentFromSelectionResponse,
  GetDocumentByTokenResponse,
  CreateDocumentFromTokenRequest,
  CreateDocumentFromTokenResponse,
  CloneDocumentWithTokenResponse,
  DocumentLLMContextResponse,
} from './document-schemas';

// User/Admin API types
export type {
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserResponse,
  DeleteUserResponse,
} from './user-schemas';

// Auth API types
export type {
  OAuthProvider,
  OAuthConfigResponse,
  AcceptTermsResponse,
  TokenRefreshResponse,
  MCPGenerateResponse,
  LogoutResponse,
  OAuthConfigResponseActual,
} from './auth-schemas';

// Type API types
export type {
  AddEntityTypeResponse,
} from './type-schemas';

// Discovery API types
export type {
  DiscoverContextResponse,
  ContextualSummaryResponse,
} from './discovery-schemas';

// Event API types
export type {
  GetEventsResponse,
} from './event-schemas';

// Utility functions (formerly @semiont/sdk)
// Type guards
export * from './type-guards';

// Cryptographic utilities
export * from './crypto';

// Error classes
export * from './errors';

// HTTP client utilities
export * from './http-client';

// Validation utilities
export * from './validation';

// Annotation history utilities
export * from './annotation-history-utils';

// DID and W3C Agent utilities
export * from './did-utils';

// Locale utilities
export * from './locales';

// Job types and schemas
export type {
  JobStatus,
  JobType,
  DetectionProgress,
  DetectionResult,
  GenerationProgress,
  GenerationResult,
  JobStatusResponse,
  CreateJobResponse,
  WaitForJobOptions,
} from './job-schemas';
export {
  JobStatusResponseSchema,
  CreateJobResponseSchema,
} from './job-schemas';

// API Client (Core - for internal use only)
export {
  SemiontCoreClient,
  uploadDocumentBatch,
  createAnnotationBatch,
  resolveAnnotationBatch,
} from './client';
export type {
  SemiontCoreClientConfig,
} from './client';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';