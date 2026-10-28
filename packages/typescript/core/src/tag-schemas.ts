/**
 * Tag-schema type aliases.
 *
 * These are type-only re-exports of the OpenAPI `TagSchema` and `TagCategory`
 * shapes. The schemas themselves do not live in `@semiont/core` — they're
 * registered at runtime per-KB via `frame.addTagSchema(...)` against a
 * per-KB projection. This module just exposes the shape so KB authors and
 * skill code can type their schema literals without the OpenAPI lookup
 * syntax (`components['schemas']['TagSchema']`).
 */

import type { components } from './types';

/**
 * A structural-analysis schema (e.g. legal-irac, scientific-imrad).
 *
 * Defines a methodology framework as an id, name, description, domain hint,
 * and an ordered list of categories. KBs and their skills register schemas
 * with the runtime registry via `frame.addTagSchema(...)` at session start.
 */
export type TagSchema = components['schemas']['TagSchema'];

/**
 * A single category within a {@link TagSchema} (e.g. 'Issue' in IRAC).
 *
 * Each category carries methodology-bound semantics: a name, a description,
 * and examples used in the LLM prompt.
 */
export type TagCategory = components['schemas']['TagCategory'];
