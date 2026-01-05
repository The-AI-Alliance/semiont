/**
 * Tag Schema Registry (Frontend)
 *
 * Re-exports from @semiont/ontology package
 */

export {
  TAG_SCHEMAS,
  getTagSchema,
  getAllTagSchemas,
  getTagSchemasByDomain,
  isValidCategory,
  getSchemaCategory as getTagCategory
} from '@semiont/ontology';
export type { TagSchema, TagCategory } from '@semiont/ontology';
