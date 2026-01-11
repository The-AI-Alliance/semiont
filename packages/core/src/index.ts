/**
 * @semiont/core
 *
 * Core domain logic and utilities for the Semiont semantic knowledge platform.
 * For OpenAPI types, import directly from @semiont/api-client.
 */

// NOTE: OpenAPI types are NOT re-exported from @semiont/core.
// Import types directly from @semiont/api-client where needed:
//   import type { components } from '@semiont/api-client';
//   type Annotation = components['schemas']['Annotation'];

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

// Backend-specific annotation utilities
export { bodyItemsMatch, findBodyItem } from './annotation-utils';

// Resource types
export type { UpdateResourceInput, ResourceFilter } from './resource-types';

// Annotation types
export type { AnnotationCategory, CreateAnnotationInternal } from './annotation-types';

// Auth types
export type { GoogleAuthRequest } from './auth-types';

// Utility functions
export * from './type-guards';
export * from './crypto';
export * from './errors';
export * from './http-client';
export * from './annotation-history-utils';
export * from './did-utils';

// Configuration loading
export {
  loadEnvironmentConfig,
  getAvailableEnvironments,
  getNodeEnvForEnvironment,
  type EnvironmentConfig,
  type ServiceConfig,
  type AWSConfig,
  type SiteConfig,
  type AppConfig,
} from './config/environment-loader';
export {
  isValidEnvironment,
  parseEnvironment,
  validateEnvironment,
  type Environment,
} from './config/environment-validator';
export { ConfigurationError } from './config/configuration-error';
export {
  findProjectRoot,
  isProjectRoot,
  getEnvironmentsPath,
  getSemiontConfigPath,
} from './config/project-discovery';
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

// Configuration validation
export {
  validateSemiontConfig,
  validateEnvironmentConfig,
  validateSiteConfig,
  type ValidationResult,
} from './config/config-validator';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';
