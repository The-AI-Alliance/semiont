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

// URI utilities
export {
  resourceIdToURI,
  uriToResourceId,
  annotationIdToURI,
  uriToAnnotationId,
  uriToAnnotationIdOrPassthrough,
  extractResourceUriFromAnnotationUri,
} from './uri-utils';

// Graph types
export type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from './graph';

// Event types
export type {
  BaseEvent,
  ResourceEvent,
  ResourceEventType,
  SystemEvent,
  ResourceScopedEvent,
  ResourceCreatedEvent,
  ResourceClonedEvent,
  ResourceArchivedEvent,
  ResourceUnarchivedEvent,
  RepresentationAddedEvent,
  RepresentationRemovedEvent,
  AnnotationAddedEvent,
  AnnotationRemovedEvent,
  AnnotationBodyUpdatedEvent,
  JobStartedEvent,
  JobProgressEvent,
  JobCompletedEvent,
  JobFailedEvent,
  BodyOperation,
  BodyItem,
  EntityTagAddedEvent,
  EntityTagRemovedEvent,
  EventMetadata,
  EventSignature,
  StoredEvent,
  EventQuery,
  ResourceAnnotations,
} from './events';
export {
  isResourceEvent,
  isSystemEvent,
  isResourceScopedEvent,
  getEventType,
} from './events';

// Event utilities
export {
  getAnnotationUriFromEvent,
  isEventRelatedToAnnotation,
  isResourceEvent as isStoredEvent,
} from './event-utils';

// Event bus (RxJS-based, framework-agnostic)
export { EventBus, ScopedEventBus } from './event-bus';

// Event protocol (application-level events for event bus)
export type {
  EventMap,
  EventName,
  SelectionData,
  AnnotationProgress,
  GenerationProgress,
  Selector,
  GenerationContext,
} from './event-map';

// Backend-specific annotation utilities
export { findBodyItem } from './annotation-utils';

// Resource types
export type { UpdateResourceInput, ResourceFilter } from './resource-types';

// Annotation types
export type { AnnotationCategory, CreateAnnotationInternal } from './annotation-types';

// Auth types
export type { GoogleAuthRequest } from './auth-types';

// Utility functions
export * from './type-guards';
export * from './errors';
export * from './did-utils';

// Configuration - Pure functions only (no filesystem dependencies)
// Callers should read config files themselves and pass contents to parseAndMergeConfigs
// Or use createConfigLoader with a platform-specific file reader
export {
  deepMerge,
  resolveEnvVars,
  parseAndMergeConfigs,
  createConfigLoader,
  listEnvironmentNames,
  getNodeEnvForEnvironment,
  hasAWSConfig,
  displayConfiguration,
  // Types
  type EnvironmentConfig,
  type ServiceConfig,
  type AWSConfig,
  type SiteConfig,
  type AppConfig,
  type ConfigFileReader,
} from './config/environment-loader';

export {
  parseEnvironment,
  validateEnvironment,
  type Environment,
} from './config/environment-validator';
export {
  formatErrors,
  validateSemiontConfig,
  validateEnvironmentConfig,
  validateSiteConfig,
  type ValidationResult,
} from './config/config-validator';
export { ConfigurationError } from './config/configuration-error';
export type { ProxyServiceConfig } from './config/config.types';
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
  FilesystemServiceConfig,
  InferenceServiceConfig,
  McpServiceConfig,
  ServicesConfig,
  SemiontConfig,
  GraphDatabaseType,
  ServicePlatformConfig
} from './config/config.types';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';
