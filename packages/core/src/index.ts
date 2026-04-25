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

// Creation methods
export { CREATION_METHODS } from './creation-methods';
export type { CreationMethod } from './creation-methods';

// Identifier types (only IDs - URIs are in @semiont/api-client)
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

// Persisted events (the 20 event types written to the log)
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
  IContentTransport,
  PutBinaryRequest,
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

// Resource types
export type { UpdateResourceInput, ResourceFilter } from './resource-types';

// Annotation types
export type { Annotation, AnnotationCategory, CreateAnnotationInternal } from './annotation-types';

// Auth types
export type { GoogleAuthRequest } from './auth-types';

// ID generation
export { generateUuid } from './id-generation';

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

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';
