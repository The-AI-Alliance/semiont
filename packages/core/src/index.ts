/**
 * @semiont/core
 *
 * Core domain logic and utilities for the Semiont semantic knowledge platform.
 * OpenAPI types are generated here and exported for use across the monorepo.
 */

// OpenAPI-generated types (source of truth for API schemas)
export type { components, paths, operations } from './types';

// Branded types (compile-time type safety)
export type {
  // OpenAPI types
  Motivation,
  ContentFormat,
  // Authentication & tokens
  Email,
  AuthCode,
  GoogleCredential,
  AccessToken,
  RefreshToken,
  MCPToken,
  CloneToken,
  // System identifiers
  JobId,
  UserDID,
  EntityType,
  SearchQuery,
  BaseUrl,
  // HTTP URI types
  ResourceUri,
  AnnotationUri,
  ResourceAnnotationUri,
} from './branded-types';
export {
  // Helper functions
  email,
  authCode,
  googleCredential,
  accessToken,
  refreshToken,
  mcpToken,
  cloneToken,
  jobId,
  userDID,
  entityType,
  searchQuery,
  baseUrl,
  // URI factory functions
  resourceUri,
  annotationUri,
  resourceAnnotationUri,
} from './branded-types';

// Identifier types (only IDs - URIs are in @semiont/http-transport)
export type { ResourceId, AnnotationId, UserId } from './identifiers';
export {
  resourceId,
  annotationId,
  userId,
  isResourceId,
  isAnnotationId,
} from './identifiers';

// Graph types
export type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
  ResourceDescriptor,
} from './graph';

// Event base types (persistence model foundations)
export type {
  Brand,
  EventBase,
  EventMetadata,
  EventSignature,
  StoredEvent,
  BodyOperation,
  BodyItem,
  EventQuery,
  ResourceAnnotations,
} from './event-base';

// Persisted events (the event types written to the log)
export type {
  EventOfType,
  PersistedEvent,
  PersistedEventType,
  EventInput,
} from './persisted-events';
export { PERSISTED_EVENT_TYPES } from './persisted-events';

// Bus protocol (unified EventMap — all channels on the EventBus)
export type {
  EventMap,
  EventName,
  EmittableChannel,
  ResourceBroadcastType,
} from './bus-protocol';
export { RESOURCE_BROADCAST_TYPES, CHANNEL_SCHEMAS } from './bus-protocol';

// Payload type aliases (OpenAPI schema shortcuts used across the codebase)
export type {
  Selector,
  GatheredContext,
  SelectionData,
} from './payload-types';

// Event utilities
export type { StoredEventLike } from './event-utils';
export {
  getAnnotationUriFromEvent,
  isEventRelatedToAnnotation,
  isStoredEvent,
} from './event-utils';

// Event bus (RxJS-based, framework-agnostic)
export { EventBus, ScopedEventBus } from './event-bus';

// RxJS operators
export { burstBuffer, type BurstBufferOptions } from './operators/burst-buffer';

// Per-key serialization (for RPC-style callers; see also RxJS groupBy + concatMap
// for stream-style callers in packages/make-meaning)
export { serializePerKey } from './serialize-per-key';

// Logger interface (framework-agnostic)
export type { Logger } from './logger';
export { errField } from './logger';

// Bus logging — Tier 1 cross-wire observability
export { busLog, busLogEnabled, setBusLogTraceIdProvider, type BusOp } from './bus-log';

// Annotation body matcher (used by mark:body-updated event replay)
export { findBodyItem } from './annotation-utils';
export type { BodyItemIdentity } from './annotation-utils';

// Annotation assembly (pure functions for building W3C Annotations)
export {
  assembleAnnotation,
  applyBodyOperations,
  getTextPositionSelector,
  getSvgSelector,
  getFragmentSelector,
  validateSvgMarkup,
} from './annotation-assembly';
export type { AssembledAnnotation } from './annotation-assembly';

// W3C Web Annotation accessors (target/body/selector helpers + type guards)
export {
  getBodySource,
  getBodyType,
  isBodyResolved,
  getTargetSource,
  getTargetSelector,
  hasTargetSelector,
  isHighlight,
  isReference,
  isAssessment,
  isComment,
  isTag,
  getCommentText,
  isStubReference,
  isResolvedReference,
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextQuoteSelector,
  extractBoundingBox,
} from './web-annotation-utils';
export type {
  TextPositionSelector,
  TextQuoteSelector,
  SvgSelector,
  FragmentSelector,
} from './web-annotation-utils';

// PDF viewrect FragmentSelector codec (peer of the W3C FragmentSelector wrapper)
export {
  createFragmentSelector,
  parseFragmentSelector,
  getPageFromFragment,
} from './pdf-coordinates';
export type { PdfCoordinate } from './pdf-coordinates';

// ResourceDescriptor accessors
export {
  getResourceId,
  getPrimaryRepresentation,
  getPrimaryMediaType,
  getChecksum,
  getLanguage,
  getStorageUri,
  getCreator,
  getDerivedFrom,
  isArchived,
  getResourceEntityTypes,
  isDraft,
  getNodeEncoding,
  decodeRepresentation,
} from './resource-utils';

// Transport contract — interfaces every concrete transport must satisfy.
export type {
  ITransport,
  IBackendOperations,
  IContentTransport,
  BackendDownload,
  PutBinaryRequest,
  PutBinaryOptions,
  PutBinaryProgress,
  ConnectionState,
  ProgressEvent,
  ProgressCallback,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
  UpdateUserRequest,
  UpdateUserResponse,
  ListUsersResponse,
} from './transport';

// Channel set every concrete transport bridges into the client's bus.
export { BRIDGED_CHANNELS, type BridgedChannel } from './bridged-channels';

// Request/reply over the bus — the transport-neutral primitive (relocated from @semiont/sdk).
export { busRequest, BusRequestError, type BusRequestErrorCode, type BusRequestPrimitive } from './bus-request';

// Fuzzy text anchoring (annotation re-anchoring under content edits)
export {
  normalizeText,
  buildContentCache,
  findBestTextMatch,
  verifyPosition,
} from './fuzzy-anchor';
export type { TextPosition, MatchQuality, ContentCache } from './fuzzy-anchor';

// Render-time anchoring (combines position + quote selectors with scoring)
export {
  anchorAnnotation,
  POSITION_WINDOW,
  CONTEXT_FULL_WEIGHT,
  CONTEXT_PARTIAL_WEIGHT,
  POSITION_WEIGHT_MAX,
} from './anchor-annotation';
export type {
  AnchorStrategy,
  AnchorConfidence,
  RenderedAnchor,
  AnchorSelectors,
} from './anchor-annotation';

// Locale info table
export {
  LOCALES,
  getLocaleInfo,
  getLocaleNativeName,
  getLocaleEnglishName,
  formatLocaleDisplay,
  getAllLocaleCodes,
} from './locales';
export type { LocaleInfo } from './locales';

// SVG utilities
export {
  createRectangleSvg,
  createPolygonSvg,
  createCircleSvg,
  parseSvgSelector,
  normalizeCoordinates,
  scaleSvgToNative,
} from './svg-utils';
export type { Point, BoundingBox } from './svg-utils';

// Text context extraction (depends on fuzzy-anchor)
export { extractContext, reconcileSelector } from './text-context';
export type { ReconciledSelector, AnchorMethod, LlmSelectorInput } from './text-context';

// Text encoding helpers
export { extractCharset, decodeWithCharset } from './text-encoding';

// Schema validation helpers
export {
  JWTTokenSchema,
  validateData,
  isValidEmail,
} from './validation';
export type { ValidationSuccess, ValidationFailure, ValidationResult } from './validation';

// Media-type registry (capability-tiered, keyed by the spec's SupportedMediaType enum)
export {
  MEDIA_TYPES,
  baseMediaType,
  isSupportedMediaType,
  capabilitiesOf,
  extensionForMediaType,
  mediaTypeForExtension,
  textExtractionOf,
  AUTHORABLE_MEDIA_TYPES,
  EMBEDDABLE_MEDIA_TYPES,
} from './media-types';
export type {
  SupportedMediaType,
  MediaTypeCapabilities,
  RenderMode,
  AnchoringModel,
  TextExtraction,
} from './media-types';

// Resource types
export type { UpdateResourceInput, ResourceFilter } from './resource-types';

// Annotation types
export type { Annotation, AnnotationCategory, CreateAnnotationInternal } from './annotation-types';

// Tag-schema type aliases (the schemas themselves are runtime-registered per KB)
export type { TagSchema, TagCategory } from './tag-schemas';

// Auth types
export type { GoogleAuthRequest } from './auth-types';

// ID generation
export { generateUuid } from './id-generation';

// State-unit pattern — the disposable contract shared by every layer (sdk,
// http-transport, react-ui, …). The axiom harness lives in `@semiont/core/testing`.
export type { StateUnit } from './state-unit';

// Utility functions
export * from './type-guards';
export * from './errors';
export * from './did-utils';

// Configuration types
export type {
  EnvironmentConfig,
  SiteConfig,
  AppConfig,
} from './config/config.types';

export {
  loadTomlConfig,
  createTomlConfigLoader,
  type TomlFileReader,
  type InferenceConfig as TomlInferenceConfig,
  type ActorInferenceConfig as TomlActorInferenceConfig,
  type WorkerInferenceConfig as TomlWorkerInferenceConfig,
} from './config/toml-loader';

export {
  parseEnvironment,
  validateEnvironment,
  type Environment,
} from './config/environment-validator';
export { ConfigurationError } from './config/configuration-error';
export {
  type PlatformType,
  isValidPlatformType,
  getAllPlatformTypes,
} from './config/platform-types';

// Schema-generated configuration types
export type {
  BackendServiceConfig,
  FrontendServiceConfig,
  DatabaseServiceConfig,
  GraphServiceConfig,
  OllamaProviderConfig,
  AnthropicProviderConfig,
  InferenceProvidersConfig,
  McpServiceConfig,
  ServicesConfig,
  VectorsServiceConfig,
  EmbeddingServiceConfig,
  SemiontConfig,
  GraphDatabaseType,
  ServicePlatformConfig
} from './config/config.types';

// Knowledge-graph view derivation (CONTEXT-UNIFICATION P3) — pure fn over the KnowledgeGraph type,
// shared by @semiont/make-meaning (matcher) and @semiont/jobs (generation).
export { deriveViews } from './knowledge-graph-views';
export type { GraphViews } from './knowledge-graph-views';
