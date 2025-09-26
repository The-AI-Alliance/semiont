/**
 * @semiont/core-types
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * This package provides the single source of truth for all domain models.
 */

// Document types
export type {
  Document,
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
} from './document';

// Creation methods
export { CREATION_METHODS } from './creation-methods';
export type { CreationMethod } from './creation-methods';

// Selection types
export type {
  Selection,
  CreateSelectionInput,
  ResolveSelectionInput,
  SelectionFilter,
} from './selection';
export {
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  isEntityReference,
  hasReferenceTags,
} from './selection';

// Reference tags
export { REFERENCE_TAGS } from './reference-tags';
export type { ReferenceTag } from './reference-tags';

// Graph types
export type {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from './graph';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';