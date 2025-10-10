/**
 * @semiont/core-types
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * This package provides the single source of truth for all domain models.
 */

// Document input/filter types
export type {
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
} from './document';

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
} from './document';
export type {
  Document,
} from './document';

// Annotation schema (SINGLE SOURCE OF TRUTH)
export {
  AnnotationSchema,
  MotivationSchema,
  AgentSchema,
  TextPositionSelectorSchema,
  TextQuoteSelectorSchema,
  SelectorSchema,
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
} from './annotation-schema';
export {
  getAnnotationCategory,
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
} from './annotation-schema';

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

// API Contract schemas and types
export {
  CreateAnnotationRequestSchema,
  CreateAnnotationInternalSchema,
  CreateAnnotationResponseSchema,
  GetHighlightsResponseSchema,
  GetReferencesResponseSchema,
  GetAnnotationsResponseSchema,
  CreateDocumentRequestSchema,
  CreateDocumentResponseSchema,
  UpdateDocumentRequestSchema,
  GetDocumentResponseSchema,
  ListDocumentsResponseSchema,
  DeleteAnnotationRequestSchema,
  DeleteAnnotationResponseSchema,
  AdminUserSchema,
  AdminUsersResponseSchema,
  AdminUserStatsResponseSchema,
  OAuthProviderSchema,
  OAuthConfigResponseSchema,
  ReferencedBySchema,
  GetReferencedByResponseSchema,
  AcceptTermsResponseSchema,
  TokenRefreshResponseSchema,
  MCPGenerateResponseSchema,
  LogoutResponseSchema,
  UpdateUserResponseSchema,
  DeleteUserResponseSchema,
  OAuthConfigResponseSchemaActual,
  AddEntityTypeResponseSchema,
  AddReferenceTypeResponseSchema,
  GenerateDocumentFromAnnotationRequestSchema,
  GenerateDocumentFromAnnotationResponseSchema,
  ResolveAnnotationRequestSchema,
  ResolveAnnotationResponseSchema,
  GetDocumentByTokenResponseSchema,
  CreateDocumentFromTokenRequestSchema,
  CreateDocumentFromTokenResponseSchema,
  CloneDocumentWithTokenResponseSchema,
  DetectAnnotationsResponseSchema,
  DiscoverContextResponseSchema,
  ReferenceLLMContextResponseSchema,
  DocumentLLMContextResponseSchema,
  GetEventsResponseSchema,
  GetAnnotationResponseSchema,
  ListAnnotationsResponseSchema,
  CreateDocumentFromSelectionResponseSchema,
  AnnotationContextResponseSchema,
  ContextualSummaryResponseSchema,
} from './api-contracts';
export type {
  CreateAnnotationRequest,
  CreateAnnotationInternal,
  CreateAnnotationResponse,
  TextSelection,
  GetHighlightsResponse,
  GetReferencesResponse,
  GetAnnotationsResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  UpdateDocumentRequest,
  GetDocumentResponse,
  ListDocumentsResponse,
  DeleteAnnotationRequest,
  DeleteAnnotationResponse,
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  OAuthProvider,
  OAuthConfigResponse,
  ReferencedBy,
  GetReferencedByResponse,
  AcceptTermsResponse,
  TokenRefreshResponse,
  MCPGenerateResponse,
  LogoutResponse,
  UpdateUserResponse,
  DeleteUserResponse,
  OAuthConfigResponseActual,
  AddEntityTypeResponse,
  AddReferenceTypeResponse,
  GenerateDocumentFromAnnotationRequest,
  GenerateDocumentFromAnnotationResponse,
  ResolveAnnotationRequest,
  ResolveAnnotationResponse,
  GetDocumentByTokenResponse,
  CreateDocumentFromTokenRequest,
  CreateDocumentFromTokenResponse,
  CloneDocumentWithTokenResponse,
  DetectAnnotationsResponse,
  DiscoverContextResponse,
  ReferenceLLMContextResponse,
  DocumentLLMContextResponse,
  GetEventsResponse,
  GetAnnotationResponse,
  ListAnnotationsResponse,
  CreateDocumentFromSelectionResponse,
  AnnotationContextResponse,
  ContextualSummaryResponse,
} from './api-contracts';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';