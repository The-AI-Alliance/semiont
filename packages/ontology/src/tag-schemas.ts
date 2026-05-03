/**
 * Tag Schema Registry (deprecated — drained in Stage 2 of TAG-SCHEMAS-GAP).
 *
 * Tag schemas are now runtime-registered per KB via `frame.addTagSchema(...)`
 * — see [TAG-SCHEMAS-GAP.md](../../../.plans/TAG-SCHEMAS-GAP.md). The `TagSchema`
 * and `TagCategory` types live in `@semiont/core`; this module's `TAG_SCHEMAS`
 * constant is intentionally empty and the helper functions return null/[].
 *
 * This module + its helpers will be deleted in Stage 3 once all consumers
 * (worker, frontend, tests) have been verified migrated.
 */

export interface TagCategory {
  name: string;
  description: string;
  examples: string[];
}

export interface TagSchema {
  id: string;
  name: string;
  description: string;
  domain: 'legal' | 'scientific' | 'general';
  tags: TagCategory[];
}

export const TAG_SCHEMAS: Record<string, TagSchema> = {};

/**
 * Get a tag schema by ID
 */
export function getTagSchema(schemaId: string): TagSchema | null {
  return TAG_SCHEMAS[schemaId] || null;
}

/**
 * Get all available tag schemas
 */
export function getAllTagSchemas(): TagSchema[] {
  return Object.values(TAG_SCHEMAS);
}

/**
 * Get tag schemas filtered by domain
 */
export function getTagSchemasByDomain(domain: 'legal' | 'scientific' | 'general'): TagSchema[] {
  return Object.values(TAG_SCHEMAS).filter(schema => schema.domain === domain);
}

/**
 * Validate that a category name is valid for a schema
 */
export function isValidCategory(schemaId: string, categoryName: string): boolean {
  const schema = getTagSchema(schemaId);
  if (!schema) return false;
  return schema.tags.some(tag => tag.name === categoryName);
}

/**
 * Get a specific category from a schema
 */
export function getSchemaCategory(schemaId: string, categoryName: string): TagCategory | null {
  const schema = getTagSchema(schemaId);
  if (!schema) return null;
  return schema.tags.find(tag => tag.name === categoryName) || null;
}
