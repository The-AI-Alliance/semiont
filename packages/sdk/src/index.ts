/**
 * @semiont/sdk
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * This package provides the single source of truth for all domain models.
 */

// Document input/filter types
export type {
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
} from './document-schemas';

// Creation methods
export { CREATION_METHODS } from './creation-methods';
export type { CreationMethod } from './creation-methods';

// Reference tags
export { REFERENCE_TAGS } from './reference-tags';
export type { ReferenceTag } from './reference-tags';

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

// Document schema (SINGLE SOURCE OF TRUTH)
export {
  DocumentSchema,
} from './document-schemas';
export {
  // OpenAPI-wrapped version for Hono routes
  DocumentSchemaOpenAPI,
} from './document';
export type {
  Document,
} from './document-schemas';

// Annotation schema (SINGLE SOURCE OF TRUTH)
export {
  AnnotationSchema,
  MotivationSchema,
  AgentSchema,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  SelectorSchema,
} from './annotation-schemas';
export {
  // OpenAPI-wrapped versions for Hono routes
  AnnotationSchemaOpenAPI,
  MotivationSchemaOpenAPI,
  AgentSchemaOpenAPI,
  TextPositionSelectorSchemaOpenAPI,
  TextQuoteSelectorSchemaOpenAPI,
  SelectorSchemaOpenAPI,
} from './annotation-schema';
export type {
  Annotation,
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
  // OpenAPI-wrapped versions for Hono routes
  StatusResponseSchemaOpenAPI,
  HealthResponseSchemaOpenAPI,
  ErrorResponseSchemaOpenAPI,
} from './status-schemas';
export type {
  StatusResponse,
  HealthResponse,
  ErrorResponse,
} from './status-schemas';

// Auth schemas and types
export {
  GoogleAuthRequestSchema,
  // OpenAPI-wrapped version for Hono routes
  GoogleAuthRequestSchemaOpenAPI,
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
  // OpenAPI-wrapped versions for Hono routes
  AuthResponseSchemaOpenAPI,
  UserResponseSchemaOpenAPI,
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
  // OpenAPI-wrapped versions for Hono routes
  CreateAnnotationRequestSchemaOpenAPI,
  CreateAnnotationResponseSchemaOpenAPI,
  GetHighlightsResponseSchemaOpenAPI,
  GetReferencesResponseSchemaOpenAPI,
  GetAnnotationsResponseSchemaOpenAPI,
  DeleteAnnotationRequestSchemaOpenAPI,
  DeleteAnnotationResponseSchemaOpenAPI,
  GetAnnotationResponseSchemaOpenAPI,
  ListAnnotationsResponseSchemaOpenAPI,
  DetectAnnotationsResponseSchemaOpenAPI,
  ResolveAnnotationRequestSchemaOpenAPI,
  ResolveAnnotationResponseSchemaOpenAPI,
  AnnotationContextResponseSchemaOpenAPI,
  ReferencedBySchemaOpenAPI,
  GetReferencedByResponseSchemaOpenAPI,
  ReferenceLLMContextResponseSchemaOpenAPI,
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
  // OpenAPI-wrapped versions for Hono routes
  CreateDocumentRequestSchemaOpenAPI,
  CreateDocumentResponseSchemaOpenAPI,
  UpdateDocumentRequestSchemaOpenAPI,
  GetDocumentResponseSchemaOpenAPI,
  ListDocumentsResponseSchemaOpenAPI,
  GenerateDocumentFromAnnotationRequestSchemaOpenAPI,
  GenerateDocumentFromAnnotationResponseSchemaOpenAPI,
  CreateDocumentFromSelectionResponseSchemaOpenAPI,
  GetDocumentByTokenResponseSchemaOpenAPI,
  CreateDocumentFromTokenRequestSchemaOpenAPI,
  CreateDocumentFromTokenResponseSchemaOpenAPI,
  CloneDocumentWithTokenResponseSchemaOpenAPI,
  DocumentLLMContextResponseSchemaOpenAPI,
} from './document-schemas';

// User/Admin API schemas
export {
  AdminUserSchema,
  AdminUsersResponseSchema,
  AdminUserStatsResponseSchema,
  UpdateUserResponseSchema,
  DeleteUserResponseSchema,
  // OpenAPI-wrapped versions for Hono routes
  UpdateUserResponseSchemaOpenAPI,
  DeleteUserResponseSchemaOpenAPI,
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
  // OpenAPI-wrapped versions for Hono routes
  OAuthConfigResponseSchemaActualOpenAPI,
  TokenRefreshResponseSchemaOpenAPI,
  MCPGenerateResponseSchemaOpenAPI,
  LogoutResponseSchemaOpenAPI,
  AcceptTermsResponseSchemaOpenAPI,
} from './auth-schemas';

// Type schemas
export {
  AddEntityTypeResponseSchema,
  AddReferenceTypeResponseSchema,
  // OpenAPI-wrapped versions for Hono routes
  AddEntityTypeResponseSchemaOpenAPI,
  AddReferenceTypeResponseSchemaOpenAPI,
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
  AddReferenceTypeResponse,
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

// Validation utilities
export * from './validation';

// Annotation history utilities
export * from './annotation-history-utils';

// DID and W3C Agent utilities
export * from './did-utils';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';