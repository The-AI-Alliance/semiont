import { z } from '@hono/zod-openapi';

/**
 * Add Entity Type Response
 */
export const AddEntityTypeResponseSchema = z.object({
  success: z.boolean(),
  entityTypes: z.array(z.string()),
});

export type AddEntityTypeResponse = z.infer<typeof AddEntityTypeResponseSchema>;

/**
 * Add Reference Type Response
 */
export const AddReferenceTypeResponseSchema = z.object({
  success: z.boolean(),
  referenceTypes: z.array(z.string()),
});

export type AddReferenceTypeResponse = z.infer<typeof AddReferenceTypeResponseSchema>;

// ============================================================================
// OpenAPI-wrapped Schemas (for Hono routes - call .openapi() on schemas above)
// ============================================================================

export const AddEntityTypeResponseSchemaOpenAPI = AddEntityTypeResponseSchema.openapi('AddEntityTypeResponse');
export const AddReferenceTypeResponseSchemaOpenAPI = AddReferenceTypeResponseSchema.openapi('AddReferenceTypeResponse');
