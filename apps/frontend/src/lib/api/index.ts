/**
 * Frontend API Client
 *
 * Pure TanStack Query hooks that use types from @semiont/api-client.
 * Domain-based organization for better maintainability.
 *
 * NOTE: Types are imported directly from @semiont/api-client.
 * Do NOT re-export types from this file.
 */

// Re-export query keys
export { QUERY_KEYS } from '../query-keys';

// API Error class (not in OpenAPI spec, defined here)
export class APIError extends Error {
  public status: number;
  public statusText: string;
  public details: unknown;
  public data: unknown;

  constructor(
    message: string,
    status: number = 500,
    statusText: string = 'Internal Server Error',
    details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
    this.data = details;
  }
}

// Re-export utilities from @semiont/api-client SDK
export {
  // Annotation utilities
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  extractAnnotationId,
  compareAnnotationIds,
  getBodySource,
  getBodyType,
  isBodyResolved,
  getTargetSource,
  getTargetSelector,
  hasTargetSelector,
  getEntityTypes,
  // Selector utilities
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextPositionSelector,
  getTextQuoteSelector,
  // Event utilities
  getAnnotationIdFromEvent,
  isEventRelatedToAnnotation,
  isDocumentEvent,
  // Locales
  LOCALES,
} from '@semiont/api-client';

export type {
  Selector,
  TextPositionSelector,
  TextQuoteSelector,
  LocaleInfo,
  StoredEvent,
  DocumentEvent,
  EventMetadata,
  DocumentEventType,
} from '@semiont/api-client';

// Export individual domain APIs
export { health } from './health';
export { auth } from './auth';
export { admin } from './admin';
export { entityTypes } from './entity-types';
export { documents } from './documents';
export { annotations } from './annotations';

export {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getDocumentCreationDetails,
} from '@semiont/api-client';

export type { DocumentCreationDetails } from '@semiont/api-client';

export { formatLocaleDisplay } from '@semiont/api-client';
