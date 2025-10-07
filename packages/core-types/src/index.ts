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
  DocumentProjection,
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

// API Contract schemas and types
export {
  CreateAnnotationRequestSchema,
  CreateAnnotationInternalSchema,
  CreateAnnotationResponseSchema,
  GetHighlightsResponseSchema,
  GetReferencesResponseSchema,
  DocumentSchema,
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
  UpdateUserRequestSchema,
  OAuthProviderSchema,
  OAuthConfigResponseSchema,
  ReferencedBySchema,
  AcceptTermsResponseSchema,
  AddEntityTypeResponseSchema,
  AddReferenceTypeResponseSchema,
  GenerateDocumentFromSelectionRequestSchema,
  GenerateDocumentFromSelectionResponseSchema,
  ResolveSelectionRequestSchema,
  ResolveSelectionResponseSchema,
  GetDocumentByTokenResponseSchema,
  CreateDocumentFromTokenRequestSchema,
  CreateDocumentFromTokenResponseSchema,
  CloneDocumentWithTokenResponseSchema,
} from './api-contracts';
export type {
  CreateAnnotationRequest,
  CreateAnnotationInternal,
  CreateAnnotationResponse,
  Annotation,
  HighlightAnnotation,
  ReferenceAnnotation,
  AnnotationUpdate,
  TextSelection,
  GetHighlightsResponse,
  GetReferencesResponse,
  Document,
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
  UpdateUserRequest,
  OAuthProvider,
  OAuthConfigResponse,
  ReferencedBy,
  AcceptTermsResponse,
  AddEntityTypeResponse,
  AddReferenceTypeResponse,
  GenerateDocumentFromSelectionRequest,
  GenerateDocumentFromSelectionResponse,
  ResolveSelectionRequest,
  ResolveSelectionResponse,
  GetDocumentByTokenResponse,
  CreateDocumentFromTokenRequest,
  CreateDocumentFromTokenResponse,
  CloneDocumentWithTokenResponse,
} from './api-contracts';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';