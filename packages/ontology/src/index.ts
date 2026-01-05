/**
 * @semiont/ontology
 *
 * Entity types, tag schemas, and tag extraction utilities.
 * Consolidates ontology-related code that was previously scattered across packages.
 */

// Entity types
export { DEFAULT_ENTITY_TYPES } from './entity-types';

// Tag collections
export type { TagCollection, TagCollectionOperations } from './tag-collections';

// Tag schemas
export {
  TAG_SCHEMAS,
  getTagSchema,
  getAllTagSchemas,
  getTagSchemasByDomain,
  isValidCategory,
  getSchemaCategory
} from './tag-schemas';
export type { TagSchema, TagCategory } from './tag-schemas';

// Entity extraction
export { getEntityTypes } from './entity-extraction';

// Tag extraction
export { getTagCategory, getTagSchemaId } from './tag-extraction';

// NOTE: Bootstrap service remains in backend to avoid circular dependency with @semiont/core
