/**
 * @semiont/ontology
 *
 * The entity-type vocabulary a knowledge base starts with.
 *
 * Note: tag-schema *data* lives with the KB that owns it (registered at
 * runtime via `frame.addTagSchema(...)`). The `TagSchema` and `TagCategory`
 * *types* are exported from `@semiont/core`, and so are the readers of an
 * annotation's body (`getEntityTypes`, `getTagCategory`, `getTagSchemaId`).
 */

// Entity types
export { DEFAULT_ENTITY_TYPES } from './entity-types';

// Tag collections
export type { TagCollection, TagCollectionOperations } from './tag-collections';

// NOTE: The entity-types bootstrap lives in @semiont/make-meaning (src/bootstrap/entity-types.ts) —
// it needs EventBus/EventStore, which don't belong in this package.
