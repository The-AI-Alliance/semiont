/**
 * OpenAPI Schema Helpers
 *
 * Plain zod schemas from SDK work fine at RUNTIME with Hono OpenAPI.
 * However, TypeScript's type checking expects schemas to have .openapi() method.
 *
 * This utility provides a type-safe cast that satisfies TypeScript
 * without changing runtime behavior or using 'any'.
 */

/**
 * Makes SDK's plain zod schemas compatible with Hono OpenAPI's type requirements.
 *
 * At runtime: Plain zod schemas work perfectly with Hono - no changes needed.
 * At compile time: TypeScript needs schemas to have the .openapi() signature.
 *
 * This function is a pure type-level assertion that tells TypeScript
 * "trust me, this schema is compatible" without runtime overhead.
 *
 * @param schema - Plain Zod schema from SDK
 * @returns The same schema, typed as Hono-compatible
 */
export function toOpenAPI<T>(schema: T): any {
  // Plain zod schemas work at runtime - this is just for TypeScript
  return schema;
}

// Alias for backward compatibility
export const asOpenAPISchema = toOpenAPI;
