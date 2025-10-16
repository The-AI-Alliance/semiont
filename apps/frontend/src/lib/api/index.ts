/**
 * Frontend API Client
 *
 * Pure TanStack Query hooks that use types from @semiont/api-client.
 * Domain-based organization for better maintainability.
 */

// Re-export types for convenience
export type {
  Document,
  Annotation,
  HighlightAnnotation,
  ReferenceAnnotation,
  AnnotationUpdate,
  TextSelection,
  CreateAnnotationRequest,
  ReferencedBy,
  AdminUser,
  AdminUsersResponse,
  AdminUserStatsResponse,
  UpdateUserRequest,
  OAuthProvider,
  OAuthConfigResponse,
} from './types';

// Re-export API Error class and query keys
export { APIError } from './types';
export { QUERY_KEYS } from '../query-keys';

// Re-export utilities
export {
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  extractAnnotationId,
  compareAnnotationIds,
} from './annotation-utils';

export {
  getExactText,
  getAnnotationExactText,
  getPrimarySelector,
  getTextPositionSelector,
  getTextQuoteSelector,
} from './selector-utils';

export type {
  Selector,
  TextPositionSelector,
  TextQuoteSelector,
} from './selector-utils';

export { LOCALES } from './locales';
export type { LocaleInfo } from './locales';

export {
  getAnnotationIdFromEvent,
  isEventRelatedToAnnotation,
  isDocumentEvent,
} from './event-utils';

export type {
  StoredEvent,
  DocumentEvent,
  EventMetadata,
  DocumentEventType,
} from './event-utils';

// Export individual domain APIs
export { health } from './health';
export { auth } from './auth';
export { admin } from './admin';
export { entityTypes } from './entity-types';
export { documents } from './documents';
export { annotations } from './annotations';

// Import for main API object
import { health } from './health';
import { auth } from './auth';
import { admin } from './admin';
import { entityTypes } from './entity-types';
import { documents } from './documents';
import { annotations } from './annotations';

/**
 * Main API object - for backward compatibility
 * Prefer importing individual domains directly for better tree-shaking
 */
export const api = {
  health,
  auth,
  admin,
  entityTypes,
  documents,
  annotations,
};

export {
  formatEventType,
  getEventEmoji,
  formatRelativeTime,
  getEventDisplayContent,
  getEventEntityTypes,
  getDocumentCreationDetails,
} from './event-formatting';

export type { DocumentCreationDetails } from './event-formatting';

export { formatLocaleDisplay } from './locales';
