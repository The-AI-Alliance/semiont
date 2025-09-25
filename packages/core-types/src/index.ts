/**
 * @semiont/core-types
 *
 * Core domain types for the Semiont semantic knowledge platform.
 * This package provides the single source of truth for all domain models.
 */

// Document types
export {
  Document,
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentFilter,
} from './document';

// Creation methods
export {
  CREATION_METHODS,
  CreationMethod,
} from './creation-methods';

// Selection types
export {
  Selection,
  CreateSelectionInput,
  ResolveSelectionInput,
  SelectionFilter,
  isHighlight,
  isReference,
  isStubReference,
  isResolvedReference,
  isEntityReference,
  hasReferenceTags,
} from './selection';

// Reference tags
export {
  REFERENCE_TAGS,
  ReferenceTag,
} from './reference-tags';

// Graph types
export {
  GraphConnection,
  GraphPath,
  EntityTypeStats,
} from './graph';

// Version information
export const CORE_TYPES_VERSION = '0.1.0';