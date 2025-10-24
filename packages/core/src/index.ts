/**
 * @semiont/core
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * Types are re-exported from @semiont/api-client (generated from OpenAPI spec).
 */

// Re-export OpenAPI-generated types as the single source of truth
export type { components, paths, operations } from '@semiont/api-client';

// Re-export common schema types for convenience
import type { components } from '@semiont/api-client';
export type Document = components['schemas']['Document'];
export type Annotation = components['schemas']['Annotation'];
export type ContentFormat = components['schemas']['ContentFormat'];

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

// Selector utilities
export {
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextPositionSelector,
  getTextQuoteSelector,
} from './selector-utils';

// Annotation utilities
export { compareAnnotationIds, extractEntityTypes, extractBodySource, bodyItemsMatch, findBodyItem } from './annotation-utils';

// Document types
export type { CreateDocumentInput, UpdateDocumentInput, DocumentFilter } from './document-types';

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
export * from './locales';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';
export const SDK_VERSION = '0.1.0';
