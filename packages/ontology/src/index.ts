/**
 * @semiont/ontology
 *
 * Entity-type vocabulary + annotation-body extraction utilities.
 *
 * Note: tag-schema *data* lives with the KB that owns it (registered at
 * runtime via `frame.addTagSchema(...)`). The `TagSchema` and `TagCategory`
 * *types* are exported from `@semiont/core`. This package owns only the
 * extraction helpers (`getTagCategory`, `getTagSchemaId`) that read schema
 * provenance off an annotation's body.
 */

// Entity types
export { DEFAULT_ENTITY_TYPES } from './entity-types';

// Tag collections
export type { TagCollection, TagCollectionOperations } from './tag-collections';

// Entity extraction
export { getEntityTypes } from './entity-extraction';

// Tag extraction
export { getTagCategory, getTagSchemaId } from './tag-extraction';

// NOTE: Bootstrap service remains in backend to avoid circular dependency with @semiont/core
