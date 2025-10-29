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
  AnnotationAddedEvent,
  AnnotationRemovedEvent,
  AnnotationBodyUpdatedEvent,
  BodyOperation,
  BodyItem,
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

// Backend-specific annotation utilities
export { bodyItemsMatch, findBodyItem } from './annotation-utils';

// Document types
export type { UpdateDocumentInput, ResourceFilter } from './document-types';

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

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';
